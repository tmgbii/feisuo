<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import { toast } from "vue-sonner";
import { t, translateError } from "@/i18n";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import ToolFold from "@/components/tools/ToolFold.vue";
import {
  errorMessage,
  invokeNetdiagArp,
  invokeNetdiagDns,
  invokeNetdiagHost,
  invokeNetdiagLanStart,
  invokeNetdiagLanStop,
  invokeNetdiagPingStart,
  invokeNetdiagPingStop,
  invokeNetdiagPort,
  invokeNetdiagRoutes,
  invokeNetdiagScanStart,
  invokeNetdiagScanStop,
  invokeNetdiagSocks,
  invokeNetdiagTraceStart,
  invokeNetdiagTraceStop,
  isTauri,
  type NetdiagHostInfo,
  type NetdiagLanDone,
  type NetdiagLanHost,
  type NetdiagPingDone,
  type NetdiagPingReply,
  type NetdiagPortResult,
  type NetdiagRouteInfo,
  type NetdiagScanDone,
  type NetdiagScanHit,
  type NetdiagSock,
  type NetdiagTraceDone,
  type NetdiagTraceHop,
} from "@/lib/ipc";

interface LogRow {
  id: number;
  action: string;
  extra: string;
}

const pingHost = ref("127.0.0.1");
const pingCount = ref(4);
const pingLoop = ref(false);
const pingSize = ref(32);
const pingInterval = ref(1000);
const pingTimeout = ref(1000);
const pingAdv = ref("");
const pinging = ref(false);
const pingReplies = ref<NetdiagPingReply[]>([]);
const pingDone = ref<NetdiagPingDone | null>(null);

const portHost = ref("127.0.0.1");
const portNum = ref(80);
const portTimeout = ref(2000);
const portAdv = ref("");
const portBusy = ref(false);
const portResult = ref<NetdiagPortResult | null>(null);

const hostBusy = ref(false);
const hostInfo = ref<NetdiagHostInfo | null>(null);
const routeBusy = ref(false);
const routeInfo = ref<NetdiagRouteInfo | null>(null);

const sockBusy = ref(false);
const socks = ref<NetdiagSock[]>([]);
const sockSummary = ref("");

const scanHost = ref("127.0.0.1");
const scanPorts = ref("");
const scanTimeout = ref(800);
const scanAdv = ref("");
const scanning = ref(false);
const scanHits = ref<NetdiagScanHit[]>([]);
const scanDone = ref<NetdiagScanDone | null>(null);

const lanBusy = ref(false);
const lanHosts = ref<NetdiagLanHost[]>([]);
const lanDone = ref<NetdiagLanDone | null>(null);

const dnsHost = ref("");
const dnsBusy = ref(false);
const dnsTried = ref(false);
const dnsAddrs = ref<string[]>([]);

const traceHost = ref("");
const tracing = ref(false);
const traceHops = ref<NetdiagTraceHop[]>([]);

const logs = ref<LogRow[]>([]);
const pane = ref("ping");
let logSeq = 0;
let unlisten: (() => void)[] = [];

const pingSummary = computed(() => {
  const d = pingDone.value;
  if (!d && !pinging.value) return "";
  const sent = d?.sent ?? pingReplies.value.length;
  const recv = d?.recv ?? pingReplies.value.filter((r) => r.ok).length;
  const loss = sent ? ((sent - recv) * 100) / sent : 0;
  const avg = d?.avgMs ?? avgOf(pingReplies.value);
  const up = recv > 0;
  const lossTxt = Number.isInteger(loss) ? String(loss) : loss.toFixed(1);
  const parts = [
    up ? t("net.up") : t("net.down"),
    `${recv}/${sent}`,
    t("net.loss", { n: lossTxt }),
  ];
  if (avg != null) parts.push(t("net.avg", { n: fmtMs(avg) }));
  if (d?.degraded) parts.push(t("net.degraded"));
  return parts.join("  ·  ");
});

function avgOf(rows: NetdiagPingReply[]): number | null {
  const ok = rows.filter((r) => r.ok && r.rttMs != null).map((r) => r.rttMs as number);
  if (!ok.length) return null;
  return ok.reduce((a, b) => a + b, 0) / ok.length;
}

function fmtMs(n: number) {
  return n < 10 ? n.toFixed(1) : String(Math.round(n));
}

function pushLog(action: string, extra = "") {
  logs.value.unshift({ id: ++logSeq, action, extra });
  if (logs.value.length > 50) logs.value.pop();
}

async function copyLog(row: LogRow) {
  const text = row.extra ? `${row.action}  ·  ${row.extra}` : row.action;
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    toast.error(t("err.copyFail"));
  }
}

async function startPing() {
  const host = pingHost.value.trim();
  if (!host) {
    toast.error(t("err.missing_host"));
    return;
  }
  pingReplies.value = [];
  pingDone.value = null;
  pinging.value = true;
  const count = pingLoop.value ? 0 : Math.max(1, Math.min(999, Number(pingCount.value) || 4));
  try {
    const action = await invokeNetdiagPingStart({
      host,
      count,
      size: Math.max(8, Math.min(1472, Number(pingSize.value) || 32)),
      intervalMs: Math.max(200, Number(pingInterval.value) || 1000),
      timeoutMs: Math.max(200, Number(pingTimeout.value) || 1000),
    });
    pushLog(action);
  } catch (e) {
    pinging.value = false;
    toast.error(errorMessage(e));
  }
}

async function stopPing() {
  await invokeNetdiagPingStop();
}

async function probePort() {
  const host = portHost.value.trim();
  const port = Number(portNum.value);
  if (!host) {
    toast.error(t("err.missing_host"));
    return;
  }
  if (!port || port < 1 || port > 65535) {
    toast.error(t("err.missing_port"));
    return;
  }
  portBusy.value = true;
  portResult.value = null;
  try {
    const res = await invokeNetdiagPort({
      host,
      port,
      timeoutMs: Math.max(200, Number(portTimeout.value) || 2000),
    });
    portResult.value = res;
    const extra = res.open
      ? `${t("net.open")}  ${res.timeMs} ms`
      : `${t("net.closed")}  ${res.timeMs} ms${res.error ? `  ${translateError(res.error)}` : ""}`;
    pushLog(res.action, extra);
  } catch (e) {
    toast.error(errorMessage(e));
  } finally {
    portBusy.value = false;
  }
}

async function refreshHost(log = true) {
  hostBusy.value = true;
  try {
    const info = await invokeNetdiagHost();
    hostInfo.value = info;
    if (log) pushLog(info.action);
  } catch (e) {
    toast.error(errorMessage(e));
  } finally {
    hostBusy.value = false;
  }
}

async function refreshRoutes(log = true) {
  routeBusy.value = true;
  try {
    const info = await invokeNetdiagRoutes();
    routeInfo.value = info;
    if (log) pushLog(info.action);
  } catch (e) {
    toast.error(errorMessage(e));
  } finally {
    routeBusy.value = false;
  }
}

const portSummary = computed(() => {
  const r = portResult.value;
  if (!r) return "";
  const head = r.open ? t("net.open") : t("net.closed");
  const err = r.error && !r.open ? `  ·  ${translateError(r.error)}` : "";
  return `${head}  ·  ${r.timeMs} ms${err}`;
});

const scanSummary = computed(() => {
  const d = scanDone.value;
  const open = d?.open.length ?? scanHits.value.filter((h) => h.open).length;
  const total = d?.total ?? scanHits.value.length;
  if (!total && !scanning.value) return "";
  return `${t("net.openN", { n: open })}  ·  ${t("net.closedN", { n: Math.max(0, total - open) })}`;
});

const lanSummary = computed(() => {
  const n = lanHosts.value.length;
  if (!n && !lanBusy.value) return "";
  const total = lanDone.value?.total;
  return total ? `${n} / ${total}` : String(n);
});

const scanRows = computed(() =>
  [...scanHits.value].sort((a, b) => Number(b.open) - Number(a.open) || a.port - b.port),
);

async function queryWho() {
  const port = Number(portNum.value);
  if (!port || port < 1 || port > 65535) {
    toast.error(t("err.missing_port"));
    return;
  }
  sockBusy.value = true;
  try {
    const info = await invokeNetdiagSocks(port, false);
    socks.value = info.rows;
    sockSummary.value = info.rows.length ? t("net.nSock", { n: info.rows.length }) : t("net.emptySock");
    const extra = info.rows
      .slice(0, 3)
      .map((r) => `${r.pid} ${r.name}`.trim())
      .join("  ·  ");
    pushLog(info.action, extra || t("net.emptySock"));
  } catch (e) {
    toast.error(errorMessage(e));
  } finally {
    sockBusy.value = false;
  }
}

async function queryListen() {
  sockBusy.value = true;
  try {
    const info = await invokeNetdiagSocks(0, true);
    socks.value = info.rows;
    sockSummary.value = t("net.nSock", { n: info.rows.length });
    pushLog(info.action, sockSummary.value);
  } catch (e) {
    toast.error(errorMessage(e));
  } finally {
    sockBusy.value = false;
  }
}

async function copySock(row: NetdiagSock) {
  try {
    await navigator.clipboard.writeText(`${row.pid}  ${row.name}  ${row.proto} ${row.local}`);
  } catch {
    toast.error(t("err.copyFail"));
  }
}

async function startScan() {
  const host = scanHost.value.trim() || portHost.value.trim();
  if (!host) {
    toast.error(t("err.missing_host"));
    return;
  }
  scanHits.value = [];
  scanDone.value = null;
  scanning.value = true;
  try {
    const action = await invokeNetdiagScanStart(host, scanPorts.value, Number(scanTimeout.value) || 800);
    pushLog(action);
  } catch (e) {
    scanning.value = false;
    toast.error(errorMessage(e));
  }
}

async function stopScan() {
  await invokeNetdiagScanStop();
}

async function startLan() {
  lanHosts.value = [];
  lanDone.value = null;
  lanBusy.value = true;
  try {
    const action = await invokeNetdiagLanStart();
    pushLog(action);
  } catch (e) {
    lanBusy.value = false;
    toast.error(errorMessage(e));
  }
}

async function stopLan() {
  await invokeNetdiagLanStop();
}

async function loadArp() {
  lanBusy.value = true;
  try {
    const info = await invokeNetdiagArp();
    mergeLan(info.rows);
    pushLog(info.action, t("net.nSock", { n: info.rows.length }));
  } catch (e) {
    toast.error(errorMessage(e));
  } finally {
    if (!lanDone.value) lanBusy.value = false;
  }
}

function mergeLan(rows: NetdiagLanHost[]) {
  const map = new Map(lanHosts.value.map((h) => [h.ip, { ...h }]));
  for (const row of rows) {
    const prev = map.get(row.ip);
    if (!prev) map.set(row.ip, { ...row });
    else {
      if (row.mac && row.mac !== "—") prev.mac = row.mac;
      if (row.rttMs != null) prev.rttMs = row.rttMs;
      if (row.name && row.name !== "—") prev.name = row.name;
    }
  }
  lanHosts.value = [...map.values()].sort((a, b) => a.ip.localeCompare(b.ip, undefined, { numeric: true }));
}

async function lookupDns() {
  const host = (dnsHost.value.trim() || scanHost.value.trim() || pingHost.value.trim());
  if (!host) {
    toast.error(t("err.missing_host"));
    return;
  }
  dnsBusy.value = true;
  dnsTried.value = true;
  try {
    const info = await invokeNetdiagDns(host);
    dnsAddrs.value = info.addrs;
    pushLog(info.action, info.addrs.join("  ") || t("net.emptyDns"));
  } catch (e) {
    toast.error(errorMessage(e));
  } finally {
    dnsBusy.value = false;
  }
}

async function startTrace() {
  const host = (traceHost.value.trim() || scanHost.value.trim() || pingHost.value.trim());
  if (!host) {
    toast.error(t("err.missing_host"));
    return;
  }
  traceHops.value = [];
  tracing.value = true;
  try {
    const action = await invokeNetdiagTraceStart(host);
    pushLog(action);
  } catch (e) {
    tracing.value = false;
    toast.error(errorMessage(e));
  }
}

async function stopTrace() {
  await invokeNetdiagTraceStop();
}

onMounted(async () => {
  if (isTauri()) {
    void refreshHost(false);
    void refreshRoutes(false);
  }
  if (!isTauri()) return;
  const { listen } = await import("@tauri-apps/api/event");
  unlisten.push(
    await listen<NetdiagPingReply>("netdiag:ping", (event) => {
      pingReplies.value = [...pingReplies.value, event.payload].slice(-64);
    }),
  );
  unlisten.push(
    await listen<NetdiagPingDone>("netdiag:ping_done", (event) => {
      pingDone.value = event.payload;
      pinging.value = false;
      const d = event.payload;
      const extra = [
        `${d.recv}/${d.sent}`,
        t("net.loss", { n: Number.isInteger(d.loss) ? String(d.loss) : d.loss.toFixed(1) }),
        d.avgMs != null ? t("net.avg", { n: fmtMs(d.avgMs) }) : "",
        d.degraded ? t("net.degraded") : "",
      ]
        .filter(Boolean)
        .join("  ·  ");
      const last = logs.value.find((row) => row.action === d.action);
      if (last) last.extra = extra;
      else pushLog(d.action, extra);
    }),
  );
  unlisten.push(
    await listen<NetdiagScanHit>("netdiag:scan", (event) => {
      scanHits.value = [...scanHits.value, event.payload];
    }),
  );
  unlisten.push(
    await listen<NetdiagScanDone>("netdiag:scan_done", (event) => {
      scanDone.value = event.payload;
      scanning.value = false;
      const extra = t("net.openN", { n: event.payload.open.length });
      const last = logs.value.find((row) => row.action === event.payload.action);
      if (last) last.extra = extra;
      else pushLog(event.payload.action, extra);
    }),
  );
  unlisten.push(
    await listen<NetdiagLanHost>("netdiag:lan", (event) => {
      mergeLan([event.payload]);
    }),
  );
  unlisten.push(
    await listen<NetdiagLanDone>("netdiag:lan_done", (event) => {
      lanDone.value = event.payload;
      lanBusy.value = false;
      const extra = `${event.payload.up} / ${event.payload.total}`;
      const last = logs.value.find((row) => row.action === event.payload.action);
      if (last) last.extra = extra;
      else pushLog(event.payload.action, extra);
    }),
  );
  unlisten.push(
    await listen<NetdiagTraceHop>("netdiag:trace", (event) => {
      const hop = event.payload;
      const next = traceHops.value.filter((h) => h.hop !== hop.hop);
      next.push(hop);
      next.sort((a, b) => a.hop - b.hop);
      traceHops.value = next;
    }),
  );
  unlisten.push(
    await listen<NetdiagTraceDone>("netdiag:trace_done", (event) => {
      tracing.value = false;
      const last = logs.value.find((row) => row.action === event.payload.action);
      if (last) last.extra = String(event.payload.hops);
      else pushLog(event.payload.action, String(event.payload.hops));
    }),
  );
});

onUnmounted(() => {
  for (const stop of unlisten) stop();
  unlisten = [];
  if (pinging.value) void invokeNetdiagPingStop();
  if (scanning.value) void invokeNetdiagScanStop();
  if (lanBusy.value) void invokeNetdiagLanStop();
  if (tracing.value) void invokeNetdiagTraceStop();
});
</script>

<template>
  <div class="flex h-full min-h-0 flex-col text-[13px]">
    <Tabs v-model="pane" class="flex min-h-0 min-w-0 flex-[3] flex-col gap-0">
      <TabsList class="grid h-8 w-full shrink-0 grid-cols-7 text-[11px]">
        <TabsTrigger value="ping" class="px-0 text-[11px]">Ping</TabsTrigger>
        <TabsTrigger value="port" class="px-0 text-[11px]">{{ t("net.tabPort") }}</TabsTrigger>
        <TabsTrigger value="scan" class="px-0 text-[11px]">{{ t("net.scan") }}</TabsTrigger>
        <TabsTrigger value="lan" class="px-0 text-[11px]">{{ t("net.lan") }}</TabsTrigger>
        <TabsTrigger value="dns" class="px-0 text-[11px]">{{ t("net.dns") }}</TabsTrigger>
        <TabsTrigger value="trace" class="px-0 text-[11px]">{{ t("net.trace") }}</TabsTrigger>
        <TabsTrigger value="host" class="px-0 text-[11px]">{{ t("net.tabHost") }}</TabsTrigger>
      </TabsList>

      <TabsContent value="ping" class="mt-3 flex min-h-0 flex-1 flex-col overflow-hidden">
        <div class="flex shrink-0 flex-wrap items-center gap-1.5">
          <Input v-model="pingHost" class="h-7 w-44 font-mono" placeholder="127.0.0.1" />
          <Input
            v-model.number="pingCount"
            class="h-7 w-14 font-mono"
            type="number"
            min="1"
            max="999"
            :disabled="pingLoop"
          />
          <label class="flex items-center gap-1 text-[11px] text-muted-foreground">
            <input v-model="pingLoop" type="checkbox" class="accent-primary" />
            {{ t("net.loop") }}
          </label>
          <Button v-if="!pinging" size="sm" @click="startPing">{{ t("common.start") }}</Button>
          <Button v-else size="sm" variant="outline" @click="stopPing">{{ t("common.stop") }}</Button>
        </div>
        <ToolFold class="mt-2 shrink-0" :title="t('net.advanced')" :model-value="pingAdv" @update:model-value="pingAdv = $event">
          <div class="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
            <span>{{ t("net.size") }}</span>
            <Input v-model.number="pingSize" class="h-7 w-16 font-mono" type="number" min="8" max="1472" />
            <span>{{ t("net.interval") }}</span>
            <Input v-model.number="pingInterval" class="h-7 w-20 font-mono" type="number" min="200" />
            <span>{{ t("net.timeout") }}</span>
            <Input v-model.number="pingTimeout" class="h-7 w-20 font-mono" type="number" min="200" />
          </div>
        </ToolFold>
        <p v-if="pingSummary" class="mt-2 shrink-0 text-[12px]" :class="pingDone && pingDone.recv === 0 ? 'text-destructive' : 'text-foreground'">
          {{ pingSummary }}
        </p>
        <div class="mt-2 min-h-0 flex-1 overflow-auto rounded-md border border-border">
          <table class="w-full text-left font-mono text-[11px]">
            <thead class="sticky top-0 bg-bg-2 text-muted-foreground">
              <tr>
                <th class="px-2 py-1 font-medium">#</th>
                <th class="px-2 py-1 font-medium">TTL</th>
                <th class="px-2 py-1 font-medium">RTT</th>
                <th class="px-2 py-1 font-medium">{{ t("net.result") }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-if="!pingReplies.length">
                <td class="px-2 py-3 text-muted-foreground" colspan="4">—</td>
              </tr>
              <tr v-for="row in pingReplies" :key="row.seq" class="border-t border-border">
                <td class="px-2 py-0.5">{{ row.seq }}</td>
                <td class="px-2 py-0.5">{{ row.ttl ?? "—" }}</td>
                <td class="px-2 py-0.5">{{ row.rttMs != null ? `${fmtMs(row.rttMs)} ms` : "—" }}</td>
                <td class="px-2 py-0.5" :class="row.ok ? 'text-primary' : 'text-destructive'">
                  {{ row.ok ? t("net.up") : translateError(row.error || "timeout") }}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </TabsContent>

      <TabsContent value="port" class="mt-3 flex min-h-0 flex-1 flex-col overflow-hidden">
        <div class="flex shrink-0 flex-wrap items-center gap-1.5">
          <Input v-model="portHost" class="h-7 w-44 font-mono" placeholder="127.0.0.1" />
          <Input v-model.number="portNum" class="h-7 w-20 font-mono" type="number" min="1" max="65535" />
          <Button size="sm" :disabled="portBusy" @click="probePort">{{ t("net.probe") }}</Button>
          <Button size="sm" variant="outline" :disabled="sockBusy" @click="queryWho">{{ t("net.whoQuery") }}</Button>
          <Button size="sm" variant="outline" :disabled="sockBusy" @click="queryListen">{{ t("net.listen") }}</Button>
          <span v-if="portSummary" class="text-[12px]" :class="portResult?.open ? 'text-foreground' : 'text-destructive'">{{ portSummary }}</span>
          <span v-if="sockSummary" class="text-[12px] text-muted-foreground">{{ sockSummary }}</span>
        </div>
        <ToolFold class="mt-2 shrink-0" :title="t('net.advanced')" :model-value="portAdv" @update:model-value="portAdv = $event">
          <div class="flex items-center gap-2 text-[11px] text-muted-foreground">
            <span>{{ t("net.timeout") }}</span>
            <Input v-model.number="portTimeout" class="h-7 w-20 font-mono" type="number" min="200" />
          </div>
        </ToolFold>
        <div class="mt-2 min-h-0 flex-1 overflow-auto rounded-md border border-border">
          <table class="w-full text-left font-mono text-[11px]">
            <thead class="sticky top-0 bg-bg-2 text-muted-foreground">
              <tr>
                <th class="px-2 py-1 font-medium">{{ t("net.pid") }}</th>
                <th class="px-2 py-1 font-medium">{{ t("net.proc") }}</th>
                <th class="px-2 py-1 font-medium">{{ t("net.local") }}</th>
                <th class="px-2 py-1 font-medium">{{ t("net.state") }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-if="!socks.length">
                <td class="px-2 py-3 text-muted-foreground" colspan="4">{{ t("net.emptySock") }}</td>
              </tr>
              <tr
                v-for="(row, i) in socks"
                :key="`${row.pid}-${row.local}-${i}`"
                class="cursor-pointer border-t border-border hover:bg-foreground/5"
                :class="row.state === 'LISTEN' ? 'bg-primary/8' : ''"
                :title="t('common.copy')"
                @click="copySock(row)"
              >
                <td class="px-2 py-0.5">{{ row.pid }}</td>
                <td class="px-2 py-0.5">{{ row.name }}</td>
                <td class="px-2 py-0.5">{{ row.proto }} {{ row.local }}</td>
                <td class="px-2 py-0.5">{{ row.state }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </TabsContent>

      <TabsContent value="scan" class="mt-3 flex min-h-0 flex-1 flex-col overflow-hidden">
        <div class="flex shrink-0 flex-wrap items-center gap-1.5">
          <Input v-model="scanHost" class="h-7 w-44 font-mono" placeholder="127.0.0.1" />
          <Button v-if="!scanning" size="sm" @click="startScan">{{ t("net.scanGo") }}</Button>
          <Button v-else size="sm" variant="outline" @click="stopScan">{{ t("common.stop") }}</Button>
          <span v-if="scanSummary" class="text-[12px] text-muted-foreground">{{ scanSummary }}</span>
        </div>
        <ToolFold class="mt-2 shrink-0" :title="t('net.ports')" :model-value="scanAdv" @update:model-value="scanAdv = $event">
          <Input v-model="scanPorts" class="h-7 font-mono text-[11px]" placeholder="22,80,443,502  ·  8000-8010" />
          <div class="mt-2 flex items-center gap-2 text-[11px] text-muted-foreground">
            <span>{{ t("net.timeout") }}</span>
            <Input v-model.number="scanTimeout" class="h-7 w-20 font-mono" type="number" min="200" />
          </div>
        </ToolFold>
        <div class="mt-2 min-h-0 flex-1 overflow-auto rounded-md border border-border">
          <table class="w-full text-left font-mono text-[11px]">
            <thead class="sticky top-0 bg-bg-2 text-muted-foreground">
              <tr>
                <th class="px-2 py-1 font-medium">{{ t("net.port") }}</th>
                <th class="px-2 py-1 font-medium">{{ t("net.result") }}</th>
                <th class="px-2 py-1 font-medium">RTT</th>
              </tr>
            </thead>
            <tbody>
              <tr v-if="!scanHits.length">
                <td class="px-2 py-3 text-muted-foreground" colspan="3">—</td>
              </tr>
              <tr
                v-for="row in scanRows"
                :key="row.port"
                class="border-t border-border"
                :class="row.open ? '' : 'text-muted-foreground'"
              >
                <td class="px-2 py-0.5">{{ row.port }}</td>
                <td class="px-2 py-0.5" :class="row.open ? 'text-primary' : ''">
                  {{ row.open ? t("net.open") : translateError(row.error || "timeout") }}
                </td>
                <td class="px-2 py-0.5">{{ row.timeMs }} ms</td>
              </tr>
            </tbody>
          </table>
        </div>
      </TabsContent>

      <TabsContent value="lan" class="mt-3 flex min-h-0 flex-1 flex-col overflow-hidden">
        <div class="mb-2 flex shrink-0 flex-wrap items-center gap-1.5">
          <Button v-if="!lanBusy" size="sm" @click="startLan">{{ t("net.lanGo") }}</Button>
          <Button v-else size="sm" variant="outline" @click="stopLan">{{ t("common.stop") }}</Button>
          <Button size="sm" variant="outline" :disabled="lanBusy" @click="loadArp">{{ t("net.arp") }}</Button>
          <span v-if="lanSummary" class="text-[12px] text-muted-foreground">{{ lanSummary }}</span>
        </div>
        <div class="min-h-0 flex-1 overflow-auto rounded-md border border-border">
          <table class="w-full text-left font-mono text-[11px]">
            <thead class="sticky top-0 bg-bg-2 text-muted-foreground">
              <tr>
                <th class="px-2 py-1 font-medium">IP</th>
                <th class="px-2 py-1 font-medium">{{ t("net.mac") }}</th>
                <th class="px-2 py-1 font-medium">RTT</th>
              </tr>
            </thead>
            <tbody>
              <tr v-if="!lanHosts.length">
                <td class="px-2 py-3 text-muted-foreground" colspan="3">{{ t("net.emptyLan") }}</td>
              </tr>
              <tr v-for="row in lanHosts" :key="row.ip" class="border-t border-border">
                <td class="px-2 py-0.5">{{ row.ip }}</td>
                <td class="px-2 py-0.5">{{ row.mac }}</td>
                <td class="px-2 py-0.5">{{ row.rttMs != null ? `${fmtMs(row.rttMs)} ms` : "—" }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </TabsContent>

      <TabsContent value="dns" class="mt-3 flex min-h-0 flex-1 flex-col overflow-hidden">
        <div class="flex shrink-0 flex-wrap items-center gap-1.5">
          <Input v-model="dnsHost" class="h-7 w-56 font-mono" :placeholder="scanHost || pingHost" />
          <Button size="sm" :disabled="dnsBusy" @click="lookupDns">{{ t("net.lookup") }}</Button>
        </div>
        <p v-if="dnsAddrs.length" class="mt-3 font-mono text-[12px]">{{ dnsAddrs.join("  ·  ") }}</p>
        <p v-else-if="dnsTried" class="mt-3 text-[12px] text-muted-foreground">{{ t("net.emptyDns") }}</p>
      </TabsContent>

      <TabsContent value="trace" class="mt-3 flex min-h-0 flex-1 flex-col overflow-hidden">
        <div class="mb-2 flex shrink-0 flex-wrap items-center gap-1.5">
          <Input v-model="traceHost" class="h-7 w-56 font-mono" :placeholder="scanHost || pingHost" />
          <Button v-if="!tracing" size="sm" @click="startTrace">{{ t("common.start") }}</Button>
          <Button v-else size="sm" variant="outline" @click="stopTrace">{{ t("common.stop") }}</Button>
        </div>
        <div class="min-h-0 flex-1 overflow-auto rounded-md border border-border">
          <table class="w-full text-left font-mono text-[11px]">
            <thead class="sticky top-0 bg-bg-2 text-muted-foreground">
              <tr>
                <th class="px-2 py-1 font-medium">{{ t("net.hop") }}</th>
                <th class="px-2 py-1 font-medium">IP</th>
                <th class="px-2 py-1 font-medium">RTT</th>
              </tr>
            </thead>
            <tbody>
              <tr v-if="!traceHops.length">
                <td class="px-2 py-3 text-muted-foreground" colspan="3">{{ t("net.emptyTrace") }}</td>
              </tr>
              <tr v-for="row in traceHops" :key="row.hop" class="border-t border-border">
                <td class="px-2 py-0.5">{{ row.hop }}</td>
                <td class="px-2 py-0.5">{{ row.ip }}</td>
                <td class="px-2 py-0.5">{{ row.error ? translateError(row.error) : row.rttMs != null ? `${fmtMs(row.rttMs)} ms` : "—" }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </TabsContent>

      <TabsContent value="host" class="mt-3 flex min-h-0 flex-1 flex-col overflow-hidden">
        <div class="mb-2 flex shrink-0 flex-wrap items-center justify-between gap-2">
          <div v-if="hostInfo" class="flex flex-wrap gap-x-4 gap-y-1 text-[12px]">
            <span>{{ t("net.egress") }} {{ hostInfo.egress }}</span>
            <span>{{ t("net.gateway") }} {{ hostInfo.gateway }}</span>
            <span>{{ t("net.dns") }} {{ hostInfo.dns.length ? hostInfo.dns.join("  ") : "—" }}</span>
          </div>
          <div class="ml-auto flex gap-1">
            <Button size="xs" variant="outline" :disabled="hostBusy" @click="refreshHost()">{{ t("common.refresh") }}</Button>
          </div>
        </div>
        <div class="min-h-0 flex-1 overflow-auto rounded-md border border-border">
          <table class="w-full text-left font-mono text-[11px]">
            <thead class="sticky top-0 bg-bg-2 text-muted-foreground">
              <tr>
                <th class="px-2 py-1 font-medium">{{ t("common.name") }}</th>
                <th class="px-2 py-1 font-medium">{{ t("net.state") }}</th>
                <th class="px-2 py-1 font-medium">IP</th>
                <th class="px-2 py-1 font-medium">{{ t("net.mask") }}</th>
                <th class="px-2 py-1 font-medium">MAC</th>
              </tr>
            </thead>
            <tbody>
              <tr v-if="!hostInfo?.ifaces.length">
                <td class="px-2 py-3 text-muted-foreground" colspan="5">{{ t("net.emptyIf") }}</td>
              </tr>
              <tr v-for="(row, i) in hostInfo?.ifaces ?? []" :key="`${row.name}-${i}`" class="border-t border-border">
                <td class="px-2 py-0.5">{{ row.name }}</td>
                <td class="px-2 py-0.5">{{ row.up ? t("net.ifUp") : t("net.ifDown") }}</td>
                <td class="px-2 py-0.5">{{ row.ip }}</td>
                <td class="px-2 py-0.5">{{ row.mask }}</td>
                <td class="px-2 py-0.5">{{ row.mac }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <div class="mt-2 flex shrink-0 items-center justify-between">
          <span class="text-[11px] font-medium text-muted-foreground">{{ t("net.routes") }}</span>
          <Button size="xs" variant="outline" :disabled="routeBusy" @click="refreshRoutes()">{{ t("common.refresh") }}</Button>
        </div>
        <div class="mt-1 min-h-0 flex-1 overflow-auto rounded-md border border-border">
          <table class="w-full text-left font-mono text-[11px]">
            <thead class="sticky top-0 bg-bg-2 text-muted-foreground">
              <tr>
                <th class="px-2 py-1 font-medium">{{ t("net.dest") }}</th>
                <th class="px-2 py-1 font-medium">{{ t("net.mask") }}</th>
                <th class="px-2 py-1 font-medium">{{ t("net.gateway") }}</th>
                <th class="px-2 py-1 font-medium">{{ t("net.iface") }}</th>
                <th class="px-2 py-1 font-medium">{{ t("net.metric") }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-if="!routeInfo?.routes.length">
                <td class="px-2 py-3 text-muted-foreground" colspan="5">{{ t("net.emptyRt") }}</td>
              </tr>
              <tr
                v-for="(row, i) in routeInfo?.routes ?? []"
                :key="`${row.dest}-${row.gateway}-${i}`"
                class="border-t border-border"
                :class="row.isDefault ? 'bg-primary/8 font-medium' : ''"
              >
                <td class="px-2 py-0.5">{{ row.dest }}{{ row.isDefault ? `  ${t("net.def")}` : "" }}</td>
                <td class="px-2 py-0.5">{{ row.mask }}</td>
                <td class="px-2 py-0.5">{{ row.gateway }}</td>
                <td class="px-2 py-0.5">{{ row.iface }}</td>
                <td class="px-2 py-0.5">{{ row.metric }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </TabsContent>
    </Tabs>

    <section class="mt-3 flex min-h-0 flex-[2] flex-col overflow-hidden rounded-md border border-border">
      <div class="shrink-0 px-3 py-2 text-[11px] font-medium text-muted-foreground">{{ t("net.log") }}</div>
      <div class="min-h-0 flex-1 overflow-auto px-2 pb-2">
        <p v-if="!logs.length" class="px-1.5 text-[12px] text-muted-foreground">{{ t("net.emptyLog") }}</p>
        <ul v-else class="space-y-0.5 font-mono text-[11px]">
          <li v-for="row in logs" :key="row.id">
            <button
              type="button"
              class="w-full rounded-md px-1.5 py-1 text-left hover:bg-foreground/5"
              :title="t('common.copy')"
              @click="copyLog(row)"
            >
              <span class="text-foreground">{{ row.action }}</span>
              <span v-if="row.extra" class="ml-2 text-muted-foreground">{{ row.extra }}</span>
            </button>
          </li>
        </ul>
      </div>
    </section>
  </div>
</template>
