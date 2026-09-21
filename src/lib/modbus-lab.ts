import { t } from "@/i18n";
import { appendCrc16Modbus, crc16Modbus } from "@/lib/checksum";
import { bytesToHex } from "@/lib/hex";
import { formatIeee, permuteBytes, type WordOrder } from "@/lib/point-table";

export type LabWire = "TCP" | "RTU";
export type LabTransport = "loopback" | "tcp" | "serial";
export type LabView = "u16" | "i16" | "u32" | "i32" | "f32";
export type LabFault = 0 | 1 | 2 | 3 | -1;

export interface PollDef {
  id: string;
  name: string;
  enabled: boolean;
  slave: number;
  func: number;
  address: number;
  quantity: number;
  scanMs: number;
  order: WordOrder;
  view: LabView;
}

export interface SlavePool {
  unit: number;
  holdStart: number;
  hold: number[];
  coilStart: number;
  coils: number[];
  fault: LabFault;
}

export interface LabLog {
  id: string;
  ts: number;
  tone: "ok" | "err" | "warn" | "info";
  text: string;
  hex?: string;
}

export interface TestCase {
  name: string;
  ok: boolean;
  detail: string;
}

function u16(n: number): [number, number] {
  const v = n & 0xffff;
  return [(v >> 8) & 0xff, v & 0xff];
}

function be16(bytes: number[], i: number): number {
  return (((bytes[i] ?? 0) << 8) | (bytes[i + 1] ?? 0)) & 0xffff;
}

export function newPollDef(partial: Partial<PollDef> = {}): PollDef {
  return {
    id: crypto.randomUUID(),
    name: t("tools.fc03"),
    enabled: true,
    slave: 1,
    func: 3,
    address: 0,
    quantity: 8,
    scanMs: 500,
    order: "ABCD",
    view: "u16",
    ...partial,
  };
}

export function newPool(): SlavePool {
  return {
    unit: 1,
    holdStart: 0,
    hold: Array.from({ length: 32 }, () => 0),
    coilStart: 0,
    coils: Array.from({ length: 32 }, () => 0),
    fault: 0,
  };
}

export function wrapAdu(mode: LabWire, slave: number, pdu: number[], tid = 1): number[] {
  if (mode === "TCP") {
    const len = pdu.length + 1;
    return [...u16(tid), 0, 0, ...u16(len), slave & 0xff, ...pdu];
  }
  return appendCrc16Modbus([slave & 0xff, ...pdu]);
}

export function unwrapAdu(
  bytes: number[],
  mode: LabWire,
): { slave: number; pdu: number[]; tid: number; ok: boolean; error?: string } | null {
  if (mode === "TCP") {
    if (bytes.length < 8) return null;
    const tid = be16(bytes, 0);
    const proto = be16(bytes, 2);
    const len = be16(bytes, 4);
    if (proto !== 0) return { slave: 0, pdu: [], tid, ok: false, error: t("tools.tcpProto") };
    if (len !== bytes.length - 6) return { slave: 0, pdu: [], tid, ok: false, error: t("tools.mbapLen") };
    return { slave: bytes[6] ?? 0, pdu: bytes.slice(7), tid, ok: true };
  }
  if (bytes.length < 4) return null;
  const body = bytes.slice(0, -2);
  const crcRecv = (bytes[bytes.length - 2] ?? 0) | ((bytes[bytes.length - 1] ?? 0) << 8);
  const crcCalc = crc16Modbus(body);
  if (crcRecv !== crcCalc) {
    return { slave: body[0] ?? 0, pdu: body.slice(1), tid: 0, ok: false, error: "CRC16" };
  }
  return { slave: body[0] ?? 0, pdu: body.slice(1), tid: 0, ok: true };
}

export function takeAdus(buf: number[], mode: LabWire): { frames: number[][]; rest: number[] } {
  const frames: number[][] = [];
  let cur = buf.slice();
  if (mode === "TCP") {
    while (cur.length >= 6) {
      const len = be16(cur, 4);
      const need = 6 + len;
      if (len < 2 || need > 260) {
        cur = cur.slice(1);
        continue;
      }
      if (cur.length < need) break;
      frames.push(cur.slice(0, need));
      cur = cur.slice(need);
    }
    return { frames, rest: cur };
  }
  if (cur.length >= 4) {
    const crcRecv = (cur[cur.length - 2] ?? 0) | ((cur[cur.length - 1] ?? 0) << 8);
    if (crc16Modbus(cur.slice(0, -2)) === crcRecv) {
      return { frames: [cur], rest: [] };
    }
  }
  if (cur.length > 256) return { frames: [], rest: [] };
  return { frames: [], rest: cur };
}

export function buildRequest(opts: {
  mode: LabWire;
  slave: number;
  func: number;
  address: number;
  quantity: number;
  value?: number;
  values?: number[];
  tid?: number;
}): number[] {
  const func = opts.func & 0xff;
  let pdu: number[];
  if (func === 0x05) {
    const v = opts.value === 0 ? 0 : 0xff00;
    pdu = [func, ...u16(opts.address), ...u16(v)];
  } else if (func === 0x06) {
    pdu = [func, ...u16(opts.address), ...u16(opts.value ?? opts.quantity)];
  } else if (func === 0x0f) {
    const qty = Math.max(1, opts.quantity);
    const bits = opts.values ?? Array.from({ length: qty }, () => 0);
    const byteCount = Math.ceil(qty / 8);
    const data = Array.from({ length: byteCount }, () => 0);
    for (let i = 0; i < qty; i += 1) {
      if (bits[i]) data[Math.floor(i / 8)] |= 1 << i % 8;
    }
    pdu = [func, ...u16(opts.address), ...u16(qty), byteCount, ...data];
  } else if (func === 0x10) {
    const qty = Math.max(1, opts.quantity);
    const regs = opts.values ?? Array.from({ length: qty }, () => 0);
    const data = regs.flatMap((r) => u16(r));
    pdu = [func, ...u16(opts.address), ...u16(qty), data.length, ...data];
  } else {
    pdu = [func, ...u16(opts.address), ...u16(opts.quantity)];
  }
  return wrapAdu(opts.mode, opts.slave, pdu, opts.tid ?? 1);
}

function exceptionPdu(func: number, code: number): number[] {
  return [(func & 0x7f) | 0x80, code & 0xff];
}

function sliceHold(pool: SlavePool, address: number, quantity: number): number[] | number {
  const end = address + quantity;
  const lo = pool.holdStart;
  const hi = lo + pool.hold.length;
  if (address < lo || end > hi) return 2;
  return pool.hold.slice(address - lo, end - lo);
}

function sliceCoils(pool: SlavePool, address: number, quantity: number): number[] | number {
  const end = address + quantity;
  const lo = pool.coilStart;
  const hi = lo + pool.coils.length;
  if (address < lo || end > hi) return 2;
  return pool.coils.slice(address - lo, end - lo);
}

export function slaveHandle(bytes: number[], mode: LabWire, pool: SlavePool): number[] | null {
  const frame = unwrapAdu(bytes, mode);
  if (!frame?.ok) return null;
  if (frame.slave !== pool.unit && frame.slave !== 0) return null;
  const pdu = frame.pdu;
  const func = pdu[0] ?? 0;
  if (pool.fault === -1) return null;
  if (pool.fault > 0) {
    return wrapAdu(mode, pool.unit, exceptionPdu(func, pool.fault), frame.tid);
  }
  if (pdu.length < 5) {
    return wrapAdu(mode, pool.unit, exceptionPdu(func, 3), frame.tid);
  }
  const address = be16(pdu, 1);
  const quantity = be16(pdu, 3);
  let reply: number[];
  if (func === 0x01 || func === 0x02) {
    const bits = sliceCoils(pool, address, quantity);
    if (typeof bits === "number") reply = exceptionPdu(func, bits);
    else {
      const byteCount = Math.ceil(quantity / 8);
      const data = Array.from({ length: byteCount }, () => 0);
      for (let i = 0; i < quantity; i += 1) if (bits[i]) data[Math.floor(i / 8)] |= 1 << i % 8;
      reply = [func, byteCount, ...data];
    }
  } else if (func === 0x03 || func === 0x04) {
    const regs = sliceHold(pool, address, quantity);
    if (typeof regs === "number") reply = exceptionPdu(func, regs);
    else reply = [func, quantity * 2, ...regs.flatMap((r) => u16(r))];
  } else if (func === 0x05) {
    const bits = sliceCoils(pool, address, 1);
    if (typeof bits === "number") reply = exceptionPdu(func, bits);
    else {
      pool.coils[address - pool.coilStart] = quantity === 0xff00 ? 1 : 0;
      reply = pdu.slice();
    }
  } else if (func === 0x06) {
    const regs = sliceHold(pool, address, 1);
    if (typeof regs === "number") reply = exceptionPdu(func, regs);
    else {
      pool.hold[address - pool.holdStart] = quantity & 0xffff;
      reply = pdu.slice();
    }
  } else if (func === 0x0f) {
    const bits = sliceCoils(pool, address, quantity);
    if (typeof bits === "number") reply = exceptionPdu(func, bits);
    else {
      const data = pdu.slice(6);
      for (let i = 0; i < quantity; i += 1) {
        pool.coils[address - pool.coilStart + i] = (data[Math.floor(i / 8)] >> i % 8) & 1;
      }
      reply = [func, ...u16(address), ...u16(quantity)];
    }
  } else if (func === 0x10) {
    const regs = sliceHold(pool, address, quantity);
    if (typeof regs === "number") reply = exceptionPdu(func, regs);
    else {
      const data = pdu.slice(6);
      for (let i = 0; i < quantity; i += 1) {
        pool.hold[address - pool.holdStart + i] = be16(data, i * 2);
      }
      reply = [func, ...u16(address), ...u16(quantity)];
    }
  } else {
    reply = exceptionPdu(func, 1);
  }
  if (frame.slave === 0) return null;
  return wrapAdu(mode, pool.unit, reply, frame.tid);
}

export function parseResponseRegisters(
  bytes: number[],
  mode: LabWire,
  expect: { slave: number; func: number; tid?: number },
): { ok: true; values: number[]; coils?: number[]; rttHint?: number } | { ok: false; error: string; exception?: number } {
  const frame = unwrapAdu(bytes, mode);
  if (!frame) return { ok: false, error: t("tools.framePartial") };
  if (!frame.ok) return { ok: false, error: frame.error ?? t("err.decodeFail") };
  if (frame.slave !== expect.slave) return { ok: false, error: t("lab.slaveErr") };
  if (expect.tid != null && mode === "TCP" && frame.tid !== expect.tid) {
    return { ok: false, error: t("tools.tid") };
  }
  const func = frame.pdu[0] ?? 0;
  if (func & 0x80) {
    const code = frame.pdu[1] ?? 0;
    return { ok: false, error: `${t("tools.exception")} ${code}`, exception: code };
  }
  if ((func & 0x7f) !== expect.func) return { ok: false, error: t("tools.funcCode") };
  if (func === 0x01 || func === 0x02) {
    const n = frame.pdu[1] ?? 0;
    const data = frame.pdu.slice(2, 2 + n);
    const coils: number[] = [];
    for (const b of data) for (let i = 0; i < 8; i += 1) coils.push((b >> i) & 1);
    return { ok: true, values: [], coils };
  }
  if (func === 0x03 || func === 0x04) {
    const n = frame.pdu[1] ?? 0;
    const data = frame.pdu.slice(2, 2 + n);
    const values: number[] = [];
    for (let i = 0; i + 1 < data.length; i += 2) values.push(be16(data, i));
    return { ok: true, values };
  }
  if (func === 0x05 || func === 0x06) {
    return { ok: true, values: [be16(frame.pdu, 3)] };
  }
  return { ok: true, values: [] };
}

export function decodeBlock(values: number[], view: LabView, order: WordOrder): string[] {
  const bytes = values.flatMap((r) => u16(r));
  if (view === "u16") return values.map((v) => String(v));
  if (view === "i16") return values.map((v) => String(v > 32767 ? v - 65536 : v));
  const out: string[] = [];
  for (let i = 0; i + 1 < values.length; i += 2) {
    const slice = permuteBytes(bytes.slice(i * 2, i * 2 + 4), order);
    const hi = (slice[0] << 8) | (slice[1] ?? 0);
    const lo = (slice[2] << 8) | (slice[3] ?? 0);
    const u = ((hi << 16) | lo) >>> 0;
    if (view === "u32") out.push(String(u));
    else if (view === "i32") out.push(String(u > 0x7fffffff ? u - 0x100000000 : u));
    else {
      const row = formatIeee(
        (() => {
          const buf = new ArrayBuffer(4);
          const dv = new DataView(buf);
          for (let k = 0; k < 4; k += 1) dv.setUint8(k, slice[k] ?? 0);
          return dv.getFloat32(0, false);
        })(),
      );
      out.push(row);
    }
  }
  return out;
}

export function hexOf(bytes: number[]): string {
  return bytesToHex(bytes);
}

export const FUNC_OPTIONS = [
  { value: 1, get label() { return t("lab.fnCoil"); } },
  { value: 2, get label() { return t("lab.fnDiscrete"); } },
  { value: 3, get label() { return t("lab.fnHold"); } },
  { value: 4, get label() { return t("lab.fnInput"); } },
  { value: 5, get label() { return t("lab.fnWCoil"); } },
  { value: 6, get label() { return t("lab.fnWReg"); } },
  { value: 15, get label() { return t("lab.fnWCoils"); } },
  { value: 16, get label() { return t("lab.fnWRegs"); } },
];

export const FAULT_OPTIONS = [
  { value: 0, get label() { return t("lab.faultOk"); } },
  { value: 1, get label() { return t("lab.fault01"); } },
  { value: 2, get label() { return t("lab.fault02"); } },
  { value: 3, get label() { return t("lab.fault03"); } },
  { value: -1, get label() { return t("lab.faultNone"); } },
];
