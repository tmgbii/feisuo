import { computed, reactive, ref } from "vue";
import { defineStore } from "pinia";
import { toast } from "vue-sonner";
import { t } from "@/i18n";
import {
  errorMessage,
  invokeConnect,
  invokeDisconnect,
  invokeSend,
  isTauri,
} from "@/lib/ipc";
import {
  buildRequest,
  decodeBlock,
  hexOf,
  newPollDef,
  newPool,
  parseResponseRegisters,
  slaveHandle,
  takeAdus,
  unwrapAdu,
  type LabLog,
  type LabTransport,
  type LabWire,
  type PollDef,
  type SlavePool,
  type TestCase,
} from "@/lib/modbus-lab";
import type { SessionConfig } from "@/types";
import type { NumericRadix } from "@/lib/radix";

export const LAB_MASTER_ID = "feisuo-lab-master";
export const LAB_SLAVE_ID = "feisuo-lab-slave";

interface RxBatch {
  sessionId: string;
  frames: { data: number[]; source?: string | null }[];
}
interface StatusPayload {
  sessionId: string;
  status: string;
  error?: string | null;
}
interface ClientsPayload {
  sessionId: string;
  clients: { id: string; addr: string }[];
}

function sleep(ms: number) {
  return new Promise((r) => window.setTimeout(r, ms));
}

export const useModbusLabStore = defineStore("modbus-lab", () => {
  const transport = ref<LabTransport>("loopback");
  const wire = ref<LabWire>("TCP");
  const tcpHost = ref("127.0.0.1");
  const tcpPort = ref(1502);
  const serialMasterPort = ref("");
  const serialSlavePort = ref("");
  const baudRate = ref(9600);

  const defs = ref<PollDef[]>([newPollDef()]);
  const activeDefId = ref(defs.value[0]?.id ?? "");
  const pool = reactive<SlavePool>(newPool());
  const grid = ref<number[]>([]);
  const coils = ref<number[]>([]);
  const changed = ref<Set<number>>(new Set());
  const logs = ref<LabLog[]>([]);
  const tests = ref<TestCase[]>([]);

  const masterOn = ref(false);
  const slaveOn = ref(false);
  const polling = ref(false);
  const masterStatus = ref("disconnected");
  const slaveStatus = ref("disconnected");
  const stats = reactive({ ok: 0, timeout: 0, crc: 0, exc: 0, rtt: 0 });

  const timeoutMs = ref(800);
  const recordRaw = ref(false);
  const gridRadix = ref<NumericRadix>("DEC");

  let tid = 1;
  let rxMaster: number[] = [];
  let rxSlave: number[] = [];
  let lastSlaveClient = "";
  let slaveClients: { id: string; addr: string }[] = [];
  let waiters: Array<{
    slave: number;
    func: number;
    tid: number;
    resolve: (bytes: number[] | null) => void;
  }> = [];
  let writeQ: Array<{ func: number; address: number; value: number }> = [];
  let loopTimer = 0;
  let unlisteners: Array<() => void> = [];
  let bound = false;
  const due = new Map<string, number>();

  const activeDef = computed(() => defs.value.find((d) => d.id === activeDefId.value) ?? defs.value[0]);
  const decoded = computed(() => {
    const def = activeDef.value;
    if (!def || !grid.value.length) return [];
    return decodeBlock(grid.value, def.view, def.order);
  });

  function log(tone: LabLog["tone"], text: string, hex?: string) {
    logs.value.unshift({ id: crypto.randomUUID(), ts: Date.now(), tone, text, hex });
    if (logs.value.length > 200) logs.value.length = 200;
  }

  function resizeHold(count: number) {
    const n = Math.min(1024, Math.max(1, count));
    const next = Array.from({ length: n }, (_, i) => pool.hold[i] ?? 0);
    pool.hold = next;
  }

  function resizeCoils(count: number) {
    const n = Math.min(1024, Math.max(1, count));
    pool.coils = Array.from({ length: n }, (_, i) => pool.coils[i] ?? 0);
  }

  function addDef() {
    const d = newPollDef({ name: t("lab.defN", { n: defs.value.length + 1 }) });
    defs.value.push(d);
    activeDefId.value = d.id;
  }

  function removeDef(id: string) {
    defs.value = defs.value.filter((d) => d.id !== id);
    if (!defs.value.length) defs.value = [newPollDef()];
    if (!defs.value.some((d) => d.id === activeDefId.value)) {
      activeDefId.value = defs.value[0].id;
    }
  }

  function deliverMaster(bytes: number[]) {
    rxMaster.push(...bytes);
    const taken = takeAdus(rxMaster, wire.value);
    rxMaster = taken.rest;
    for (const frame of taken.frames) {
      if (recordRaw.value) log("info", t("lab.masterRx"), hexOf(frame));
      const adu = unwrapAdu(frame, wire.value);
      const i = waiters.findIndex((w) => (wire.value === "TCP" ? w.tid === (adu?.tid ?? -1) : true));
      if (i < 0) continue;
      const [w] = waiters.splice(i, 1);
      w?.resolve(frame);
    }
  }

  function deliverSlave(bytes: number[], source?: string) {
    if (source) {
      const hit = slaveClients.find((c) => c.addr === source || source.startsWith(c.addr.split(":")[0] ?? ""));
      if (hit) lastSlaveClient = hit.id;
      else if (slaveClients[0]) lastSlaveClient = slaveClients[0].id;
    }
    rxSlave.push(...bytes);
    const taken = takeAdus(rxSlave, wire.value);
    rxSlave = taken.rest;
    for (const frame of taken.frames) {
      if (recordRaw.value) log("info", t("lab.slaveRx"), hexOf(frame));
      const reply = slaveHandle(frame, wire.value, pool);
      if (!reply) continue;
      void sendSlave(reply);
    }
  }

  async function sendSlave(bytes: number[]) {
    if (transport.value === "loopback") return;
    if (!isTauri()) return;
    try {
      await invokeSend(LAB_SLAVE_ID, bytes, {
        tcpClientId: lastSlaveClient || undefined,
      });
    } catch (err) {
      log("err", errorMessage(err));
    }
  }

  async function sendMaster(bytes: number[]) {
    if (transport.value === "loopback") {
      const reply = slaveHandle(bytes, wire.value, pool);
      if (reply) window.setTimeout(() => deliverMaster(reply), 2);
      return;
    }
    if (!isTauri()) {
      toast.error(t("err.needLoop"));
      return;
    }
    await invokeSend(LAB_MASTER_ID, bytes);
  }

  function waitReply(_slave: number, _func: number, txn: number, ms: number): Promise<number[] | null> {
    return new Promise((resolve) => {
      let settled = false;
      const timer = window.setTimeout(() => {
        if (settled) return;
        settled = true;
        waiters = waiters.filter((w) => w.tid !== txn);
        resolve(null);
      }, ms);
      waiters.push({
        slave: _slave,
        func: _func,
        tid: txn,
        resolve: (bytes) => {
          if (settled) return;
          settled = true;
          window.clearTimeout(timer);
          resolve(bytes);
        },
      });
    });
  }

  async function transact(opts: {
    slave: number;
    func: number;
    address: number;
    quantity: number;
    value?: number;
    values?: number[];
  }): Promise<{ ok: boolean; values?: number[]; coils?: number[]; error?: string }> {
    tid = (tid + 1) & 0xffff || 1;
    const req = buildRequest({
      mode: wire.value,
      slave: opts.slave,
      func: opts.func,
      address: opts.address,
      quantity: opts.quantity,
      value: opts.value,
      values: opts.values,
      tid,
    });
    const started = performance.now();
    try {
      await sendMaster(req);
    } catch (err) {
      return { ok: false, error: errorMessage(err) };
    }
    const frame = await waitReply(opts.slave, opts.func, tid, timeoutMs.value);
    if (!frame) {
      stats.timeout += 1;
      log("warn", t("lab.timeoutFc", { func: opts.func.toString(16), address: opts.address }));
      return { ok: false, error: t("lab.timeout") };
    }
    const parsed = parseResponseRegisters(frame, wire.value, {
      slave: opts.slave,
      func: opts.func,
      tid,
    });
    stats.rtt = Math.round(performance.now() - started);
    if (!parsed.ok) {
      if (parsed.exception) stats.exc += 1;
      else stats.crc += 1;
      log("err", parsed.error, hexOf(frame));
      return { ok: false, error: parsed.error };
    }
    stats.ok += 1;
    return { ok: true, values: parsed.values, coils: parsed.coils };
  }

  async function pollOnce(def: PollDef) {
    const res = await transact({
      slave: def.slave,
      func: def.func,
      address: def.address,
      quantity: def.quantity,
    });
    if (!res.ok) return;
    if (res.values?.length) {
      const next = new Set<number>();
      res.values.forEach((v, i) => {
        const addr = def.address + i;
        if (grid.value[i] !== v) next.add(addr);
      });
      grid.value = res.values;
      if (next.size) {
        changed.value = next;
        window.setTimeout(() => {
          changed.value = new Set();
        }, 900);
      }
    }
    if (res.coils?.length) coils.value = res.coils.slice(0, def.quantity);
  }

  async function tick() {
    if (!polling.value) return;
    const w = writeQ.shift();
    if (w) {
      await transact({
        slave: activeDef.value?.slave ?? 1,
        func: w.func,
        address: w.address,
        quantity: 1,
        value: w.value,
      });
      if (!polling.value) return;
      loopTimer = window.setTimeout(() => void tick(), 20);
      return;
    }
    const now = Date.now();
    const ready = defs.value.filter((d) => d.enabled && now >= (due.get(d.id) ?? 0));
    const def = ready[0];
    if (def) {
      due.set(def.id, now + Math.max(50, def.scanMs));
      await pollOnce(def);
    }
    if (!polling.value) return;
    loopTimer = window.setTimeout(() => void tick(), 20);
  }

  function startPoll() {
    if (polling.value) return;
    if (transport.value !== "loopback" && masterStatus.value !== "connected") {
      toast.error(t("err.masterOff"));
      return;
    }
    polling.value = true;
    due.clear();
    const now = Date.now();
    for (const d of defs.value) due.set(d.id, now);
    const def = activeDef.value;
    if (def && (def.func === 0x03 || def.func === 0x04)) {
      const i = def.address - pool.holdStart;
      if (i >= 0) grid.value = pool.hold.slice(i, i + def.quantity);
    }
    log("ok", t("lab.pollStart"));
    void tick();
  }

  function stopPoll() {
    polling.value = false;
    window.clearTimeout(loopTimer);
    loopTimer = 0;
    const pending = waiters;
    waiters = [];
    for (const w of pending) w.resolve(null);
  }

  async function writeReg(address: number, value: number) {
    const def = activeDef.value;
    if (!def) return;
    writeQ.push({ func: 6, address, value: value & 0xffff });
    if (!polling.value) {
      const res = await transact({
        slave: def.slave,
        func: 6,
        address,
        quantity: 1,
        value: value & 0xffff,
      });
      if (res.ok) {
        const i = address - def.address;
        if (i >= 0 && i < grid.value.length) {
          const copy = grid.value.slice();
          copy[i] = value & 0xffff;
          grid.value = copy;
        }
        if (transport.value === "loopback") {
          const idx = address - pool.holdStart;
          if (idx >= 0 && idx < pool.hold.length) pool.hold[idx] = value & 0xffff;
        }
        log("ok", t("lab.writeAt", { addr: address, value: value & 0xffff }));
      }
      writeQ = [];
    }
  }

  async function writeCoil(address: number, on: boolean) {
    const def = activeDef.value;
    if (!def) return;
    const res = await transact({
      slave: def.slave,
      func: 5,
      address,
      quantity: 1,
      value: on ? 0xff00 : 0,
    });
    if (res.ok) {
      const i = address - def.address;
      if (i >= 0) {
        const copy = coils.value.slice();
        copy[i] = on ? 1 : 0;
        coils.value = copy;
      }
      log("ok", t("lab.coilAt", { addr: address, value: on ? 1 : 0 }));
    }
  }

  async function bindEvents() {
    if (bound || !isTauri()) return;
    bound = true;
    const { listen } = await import("@tauri-apps/api/event");
    unlisteners.push(
      await listen<RxBatch>("comm:rx", (e) => {
        if (e.payload.sessionId === LAB_MASTER_ID) {
          for (const f of e.payload.frames ?? []) deliverMaster(f.data ?? []);
        }
        if (e.payload.sessionId === LAB_SLAVE_ID) {
          for (const f of e.payload.frames ?? []) deliverSlave(f.data ?? [], f.source ?? undefined);
        }
      }),
    );
    unlisteners.push(
      await listen<StatusPayload>("comm:status", (e) => {
        const st = e.payload.status;
        if (e.payload.sessionId === LAB_MASTER_ID) {
          masterStatus.value = st;
          if (st === "error") log("err", e.payload.error ?? t("lab.masterErr"));
        }
        if (e.payload.sessionId === LAB_SLAVE_ID) {
          slaveStatus.value = st;
          if (st === "error") log("err", e.payload.error ?? t("lab.slaveErr"));
        }
      }),
    );
    unlisteners.push(
      await listen<ClientsPayload>("comm:clients", (e) => {
        if (e.payload.sessionId !== LAB_SLAVE_ID) return;
        slaveClients = e.payload.clients ?? [];
        if (slaveClients[0] && !lastSlaveClient) lastSlaveClient = slaveClients[0].id;
      }),
    );
  }

  function waitStatus(id: string, want: string, ms: number) {
    return new Promise<void>((resolve, reject) => {
      const start = Date.now();
      const iv = window.setInterval(() => {
        const cur = id === LAB_MASTER_ID ? masterStatus.value : slaveStatus.value;
        if (cur === want) {
          window.clearInterval(iv);
          resolve();
        } else if (cur === "error" || Date.now() - start > ms) {
          window.clearInterval(iv);
          reject(new Error(cur === "error" ? t("err.connectFail") : t("err.connectTimeout")));
        }
      }, 50);
    });
  }

  function masterConfig(): SessionConfig {
    if (transport.value === "serial") {
      return {
        kind: "serial",
        port: serialMasterPort.value,
        baudRate: baudRate.value,
        dataBits: 8,
        stopBits: 1,
        parity: "none",
        flowControl: "none",
      };
    }
    return { kind: "tcp", mode: "client", host: tcpHost.value, port: tcpPort.value };
  }

  function slaveConfig(): SessionConfig {
    if (transport.value === "serial") {
      return {
        kind: "serial",
        port: serialSlavePort.value,
        baudRate: baudRate.value,
        dataBits: 8,
        stopBits: 1,
        parity: "none",
        flowControl: "none",
      };
    }
    return { kind: "tcp", mode: "server", host: "0.0.0.0", port: tcpPort.value };
  }

  async function startSlave() {
    await bindEvents();
    rxSlave = [];
    if (transport.value === "loopback") {
      slaveOn.value = true;
      slaveStatus.value = "connected";
      log("ok", t("lab.slaveLoop"));
      return;
    }
    if (!isTauri()) {
      toast.error(t("err.needDesktop"));
      return;
    }
    try {
      slaveStatus.value = "connecting";
      await invokeConnect(LAB_SLAVE_ID, slaveConfig());
      await waitStatus(LAB_SLAVE_ID, "connected", 4000);
      slaveOn.value = true;
      log("ok", t("lab.slaveListen", { port: transport.value === "tcp" ? tcpPort.value : serialSlavePort.value }));
    } catch (err) {
      slaveOn.value = false;
      toast.error(errorMessage(err));
    }
  }

  async function stopSlave() {
    const was = slaveOn.value;
    slaveOn.value = false;
    slaveStatus.value = "disconnected";
    if (transport.value !== "loopback" && isTauri()) {
      try {
        await invokeDisconnect(LAB_SLAVE_ID);
      } catch {
        /* ignore */
      }
    }
    if (was) log("info", t("lab.slaveStopped"));
  }

  async function startMaster() {
    await bindEvents();
    rxMaster = [];
    if (transport.value === "loopback") {
      masterOn.value = true;
      masterStatus.value = "connected";
      log("ok", t("lab.masterLoop"));
      return;
    }
    if (!isTauri()) {
      toast.error(t("err.needDesktop"));
      return;
    }
    try {
      masterStatus.value = "connecting";
      await invokeConnect(LAB_MASTER_ID, masterConfig());
      await waitStatus(LAB_MASTER_ID, "connected", 4000);
      masterOn.value = true;
      log("ok", t("lab.masterConn", { endpoint: `${tcpHost.value}:${tcpPort.value}` }));
    } catch (err) {
      masterOn.value = false;
      toast.error(errorMessage(err));
    }
  }

  async function stopMaster() {
    const was = masterOn.value;
    stopPoll();
    masterOn.value = false;
    masterStatus.value = "disconnected";
    if (transport.value !== "loopback" && isTauri()) {
      try {
        await invokeDisconnect(LAB_MASTER_ID);
      } catch {
        /* ignore */
      }
    }
    if (was) log("info", t("lab.masterStopped"));
  }

  async function loopbackMem() {
    stopPoll();
    await stopMaster();
    await stopSlave();
    transport.value = "loopback";
    wire.value = "TCP";
    pool.fault = 0;
    await startSlave();
    await startMaster();
    startPoll();
  }

  async function loopbackTcp() {
    if (!isTauri()) {
      await loopbackMem();
      return;
    }
    stopPoll();
    await stopMaster();
    await stopSlave();
    transport.value = "tcp";
    wire.value = "TCP";
    tcpHost.value = "127.0.0.1";
    pool.fault = 0;
    await startSlave();
    await sleep(150);
    await startMaster();
    startPoll();
  }

  async function startLoop() {
    if (transport.value === "tcp") return loopbackTcp();
    if (transport.value === "serial") {
      stopPoll();
      await stopMaster();
      await stopSlave();
      pool.fault = 0;
      await startSlave();
      await sleep(150);
      await startMaster();
      startPoll();
      return;
    }
    return loopbackMem();
  }

  async function stopLoop() {
    stopPoll();
    await stopMaster();
    await stopSlave();
  }

  async function runTests() {
    const wasPolling = polling.value;
    stopPoll();
    await sleep(30);
    const out: TestCase[] = [];
    const snapFault = pool.fault;
    const snapHold0 = pool.hold[0] ?? 0;
    async function one(name: string, fn: () => Promise<string>) {
      try {
        const detail = await fn();
        out.push({ name, ok: true, detail });
      } catch (err) {
        out.push({ name, ok: false, detail: errorMessage(err) });
      }
    }
    if (!slaveOn.value) await startSlave();
    if (!masterOn.value) await startMaster();
    const slave = pool.unit;
    await one(t("lab.testReadHold"), async () => {
      pool.fault = 0;
      pool.hold[0] = 0;
      const r = await transact({ slave, func: 3, address: 0, quantity: 1 });
      if (!r.ok) throw new Error(r.error);
      if ((r.values?.[0] ?? -1) !== 0) throw new Error(t("lab.got", { n: r.values?.[0] ?? "" }));
      return "0";
    });
    await one(t("lab.testWrite06"), async () => {
      pool.fault = 0;
      const r1 = await transact({ slave, func: 6, address: 0, quantity: 1, value: 0x1234 });
      if (!r1.ok) throw new Error(r1.error);
      const r2 = await transact({ slave, func: 3, address: 0, quantity: 1 });
      if (!r2.ok) throw new Error(r2.error);
      if ((r2.values?.[0] ?? 0) !== 0x1234) throw new Error(t("lab.got", { n: r2.values?.[0] ?? "" }));
      return "0x1234";
    });
    await one(t("lab.testExc02"), async () => {
      pool.fault = 2;
      const r = await transact({ slave, func: 3, address: 0, quantity: 1 });
      pool.fault = 0;
      if (r.ok) throw new Error(t("lab.expectExc"));
      if (!r.error?.includes("2")) throw new Error(r.error ?? t("lab.noExc"));
      return r.error ?? "";
    });
    const prevTimeout = timeoutMs.value;
    timeoutMs.value = 280;
    await one(t("lab.testTimeout"), async () => {
      pool.fault = -1;
      const r = await transact({ slave, func: 3, address: 0, quantity: 1 });
      pool.fault = 0;
      if (r.ok) throw new Error(t("lab.expectTimeout"));
      return t("lab.timeout");
    });
    timeoutMs.value = prevTimeout;
    pool.fault = snapFault;
    pool.hold[0] = snapHold0;
    tests.value = out;
    const fail = out.filter((t) => !t.ok).length;
    if (fail) toast.error(t("err.testsFail", { n: fail }));
    if (wasPolling) startPoll();
  }

  function resetStats() {
    stats.ok = 0;
    stats.timeout = 0;
    stats.crc = 0;
    stats.exc = 0;
    stats.rtt = 0;
  }

  function snapshot() {
    return {
      transport: transport.value,
      wire: wire.value,
      tcpHost: tcpHost.value,
      tcpPort: tcpPort.value,
      serialMasterPort: serialMasterPort.value,
      serialSlavePort: serialSlavePort.value,
      baudRate: baudRate.value,
      defs: defs.value,
      pool: { ...pool, hold: [...pool.hold], coils: [...pool.coils] },
      timeoutMs: timeoutMs.value,
      recordRaw: recordRaw.value,
      gridRadix: gridRadix.value,
    };
  }

  function hydrate(data: ReturnType<typeof snapshot>) {
    if (!data) return;
    transport.value = data.transport ?? "loopback";
    wire.value = data.wire ?? "TCP";
    tcpHost.value = data.tcpHost ?? "127.0.0.1";
    tcpPort.value = data.tcpPort ?? 1502;
    serialMasterPort.value = data.serialMasterPort ?? "";
    serialSlavePort.value = data.serialSlavePort ?? "";
    baudRate.value = data.baudRate ?? 9600;
    if (data.defs?.length) {
      defs.value = data.defs;
      activeDefId.value = data.defs[0].id;
    }
    if (data.pool) {
      pool.unit = data.pool.unit;
      pool.holdStart = data.pool.holdStart;
      pool.hold = data.pool.hold;
      pool.coilStart = data.pool.coilStart;
      pool.coils = data.pool.coils;
      pool.fault = data.pool.fault;
    }
    timeoutMs.value = data.timeoutMs ?? 800;
    recordRaw.value = data.recordRaw ?? false;
    gridRadix.value = data.gridRadix === "HEX" ? "HEX" : "DEC";
  }

  async function dispose() {
    stopPoll();
    await stopMaster();
    await stopSlave();
    for (const stop of unlisteners) stop();
    unlisteners = [];
    bound = false;
  }

  return {
    transport,
    wire,
    tcpHost,
    tcpPort,
    serialMasterPort,
    serialSlavePort,
    baudRate,
    defs,
    activeDefId,
    activeDef,
    pool,
    grid,
    coils,
    changed,
    decoded,
    logs,
    tests,
    masterOn,
    slaveOn,
    polling,
    masterStatus,
    slaveStatus,
    stats,
    timeoutMs,
    recordRaw,
    gridRadix,
    addDef,
    removeDef,
    resizeHold,
    resizeCoils,
    startMaster,
    stopMaster,
    startSlave,
    stopSlave,
    startPoll,
    stopPoll,
    writeReg,
    writeCoil,
    loopbackMem,
    loopbackTcp,
    startLoop,
    stopLoop,
    runTests,
    resetStats,
    snapshot,
    hydrate,
    dispose,
  };
});
