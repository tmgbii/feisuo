import { appendCrc16Modbus, crc16Modbus, lrc } from "@/lib/checksum";
import { bytesToHex, bytesToText, hexToBytes } from "@/lib/hex";
import { t } from "@/i18n";

export type ModbusMode = "RTU" | "ASCII" | "TCP";
export type ModbusRole = "request" | "response" | "exception" | "unknown";

const FUNC_KEYS: Record<number, string> = {
  0x01: "tools.fc01",
  0x02: "tools.fc02",
  0x03: "tools.fc03",
  0x04: "tools.fc04",
  0x05: "tools.fc05",
  0x06: "tools.fc06",
  0x0f: "tools.fc0F",
  0x10: "tools.fc10",
};

const EXC_KEYS: Record<number, string> = {
  1: "tools.exc1",
  2: "tools.exc2",
  3: "tools.exc3",
  4: "tools.exc4",
  5: "tools.exc5",
  6: "tools.exc6",
  8: "tools.exc8",
  10: "tools.exc10",
  11: "tools.exc11",
};

export function funcLabel(func: number): string {
  const code = func & 0x7f;
  const key = FUNC_KEYS[code];
  const name = key ? t(key) : t("tools.fcUnknown");
  return `${name} (0x${code.toString(16).toUpperCase().padStart(2, "0")})`;
}

function exceptionLabel(code: number): string {
  const key = EXC_KEYS[code];
  return key ? t(key) : t("tools.excUnknown");
}

export interface ModbusParseField {
  label: string;
  value: string;
}

export interface ModbusParseResult {
  ok: boolean;
  mode: ModbusMode;
  role: ModbusRole;
  slave: number;
  func: number;
  funcName: string;
  address?: number;
  quantity?: number;
  payload?: { kind: "registers" | "coils"; bytes: number[] };
  fields: ModbusParseField[];
  errors: string[];
}

function u16(n: number): [number, number] {
  const v = n & 0xffff;
  return [(v >> 8) & 0xff, v & 0xff];
}

function be16(bytes: number[], i: number): number {
  return (((bytes[i] ?? 0) << 8) | (bytes[i + 1] ?? 0)) & 0xffff;
}

function coilBits(data: number[], quantity?: number): string {
  const bits: number[] = [];
  for (const b of data) {
    for (let i = 0; i < 8; i += 1) bits.push((b >> i) & 1);
  }
  if (quantity != null) bits.length = Math.min(bits.length, quantity);
  return bits.map(String).join(" ") || "—";
}

function registers(data: number[]): { hex: string; dec: string } {
  const regs: number[] = [];
  for (let i = 0; i + 1 < data.length; i += 2) {
    regs.push(be16(data, i));
  }
  return {
    hex: regs.map((r) => r.toString(16).toUpperCase().padStart(4, "0")).join(" ") || "—",
    dec: regs.length ? regs.join(", ") : "—",
  };
}

export function buildModbusFrame(opts: {
  mode: ModbusMode;
  slave: number;
  func: number;
  address: number;
  quantity: number;
}): { bytes: number[]; hex: string; ascii?: string } {
  const pdu = [opts.func & 0xff, ...u16(opts.address), ...u16(opts.quantity)];
  if (opts.func === 0x0f || opts.func === 0x10) {
    const qty = Math.max(1, opts.quantity);
    const byteCount = opts.func === 0x0f ? Math.ceil(qty / 8) : qty * 2;
    pdu.push(byteCount);
    for (let i = 0; i < byteCount; i += 1) pdu.push(0);
  }
  if (opts.mode === "TCP") {
    const len = pdu.length + 1;
    const bytes = [0, 1, 0, 0, (len >> 8) & 0xff, len & 0xff, opts.slave & 0xff, ...pdu];
    return { bytes, hex: bytesToHex(bytes) };
  }
  const adu = [opts.slave & 0xff, ...pdu];
  if (opts.mode === "ASCII") {
    const check = lrc(adu);
    const payload = [...adu, check]
      .map((b) => b.toString(16).toUpperCase().padStart(2, "0"))
      .join("");
    const ascii = `:${payload}\r\n`;
    return {
      bytes: Array.from(new TextEncoder().encode(ascii)),
      hex: bytesToHex(Array.from(new TextEncoder().encode(ascii))),
      ascii,
    };
  }
  const bytes = appendCrc16Modbus(adu);
  return { bytes, hex: bytesToHex(bytes) };
}

function parsePdu(pdu: number[]): {
  role: ModbusRole;
  func: number;
  address?: number;
  quantity?: number;
  payload?: { kind: "registers" | "coils"; bytes: number[] };
  fields: ModbusParseField[];
  errors: string[];
} {
  const fields: ModbusParseField[] = [];
  const errors: string[] = [];
  if (pdu.length === 0) {
    return { role: "unknown", func: 0, fields, errors: [t("tools.noPdu")] };
  }
  const func = pdu[0] ?? 0;
  if (func & 0x80) {
    const code = pdu[1] ?? 0;
    fields.push({
      label: t("tools.excCode"),
      value: `${code} ${exceptionLabel(code)}`,
    });
    if (pdu.length !== 2) errors.push(t("tools.excPdu", { n: pdu.length }));
    return { role: "exception", func: func & 0x7f, fields, errors };
  }

  if (func === 0x01 || func === 0x02 || func === 0x03 || func === 0x04) {
    if (pdu.length === 5) {
      const address = be16(pdu, 1);
      const quantity = be16(pdu, 3);
      fields.push({ label: t("tools.startAddr"), value: `${address} (0x${address.toString(16).toUpperCase().padStart(4, "0")})` });
      fields.push({ label: t("lab.qty"), value: String(quantity) });
      return { role: "request", func, address, quantity, fields, errors };
    }
    const byteCount = pdu[1] ?? 0;
    const data = pdu.slice(2, 2 + byteCount);
    if (pdu.length !== 2 + byteCount) {
      errors.push(t("tools.byteMismatch", { a: byteCount, b: pdu.length - 2 }));
    }
    fields.push({ label: t("tools.byteCount"), value: String(byteCount) });
    if (func === 0x01 || func === 0x02) {
      fields.push({ label: t("tools.coilBits"), value: coilBits(data) });
    } else {
      const regs = registers(data);
      fields.push({ label: t("tools.regsHex"), value: regs.hex });
      fields.push({ label: t("tools.regsDec"), value: regs.dec });
    }
    fields.push({ label: t("tools.data"), value: bytesToHex(data) || "—" });
    return {
      role: "response",
      func,
      payload: { kind: func === 0x01 || func === 0x02 ? "coils" : "registers", bytes: data },
      fields,
      errors,
    };
  }

  if (func === 0x05 || func === 0x06) {
    if (pdu.length < 5) errors.push(t("tools.shortWrite"));
    const address = be16(pdu, 1);
    const value = be16(pdu, 3);
    fields.push({ label: t("lab.addr"), value: `${address} (0x${address.toString(16).toUpperCase().padStart(4, "0")})` });
    if (func === 0x05) {
      fields.push({ label: t("tools.coil"), value: value === 0xff00 ? "ON (FF00)" : value === 0 ? "OFF (0000)" : `0x${value.toString(16).toUpperCase().padStart(4, "0")}` });
    } else {
      fields.push({ label: t("tools.value"), value: `${value} (0x${value.toString(16).toUpperCase().padStart(4, "0")})` });
    }
    return { role: "unknown", func, address, quantity: value, fields, errors };
  }

  if (func === 0x0f || func === 0x10) {
    if (pdu.length === 5) {
      const address = be16(pdu, 1);
      const quantity = be16(pdu, 3);
      fields.push({ label: t("tools.startAddr"), value: `${address} (0x${address.toString(16).toUpperCase().padStart(4, "0")})` });
      fields.push({ label: t("lab.qty"), value: String(quantity) });
      return { role: "response", func, address, quantity, fields, errors };
    }
    const address = be16(pdu, 1);
    const quantity = be16(pdu, 3);
    const byteCount = pdu[5] ?? 0;
    const data = pdu.slice(6, 6 + byteCount);
    fields.push({ label: t("tools.startAddr"), value: `${address} (0x${address.toString(16).toUpperCase().padStart(4, "0")})` });
    fields.push({ label: t("lab.qty"), value: String(quantity) });
    fields.push({ label: t("tools.byteCount"), value: String(byteCount) });
    if (func === 0x0f) {
      fields.push({ label: t("tools.coilBits"), value: coilBits(data, quantity) });
    } else {
      const regs = registers(data);
      fields.push({ label: t("tools.regsHex"), value: regs.hex });
      fields.push({ label: t("tools.regsDec"), value: regs.dec });
    }
    fields.push({ label: t("tools.data"), value: bytesToHex(data) || "—" });
    if (pdu.length !== 6 + byteCount) errors.push(t("tools.writeLen"));
    return {
      role: "request",
      func,
      address,
      quantity,
      payload: { kind: func === 0x0f ? "coils" : "registers", bytes: data },
      fields,
      errors,
    };
  }

  fields.push({ label: "PDU", value: bytesToHex(pdu) });
  errors.push(t("tools.unknownFc"));
  return { role: "unknown", func, fields, errors };
}

function detectMode(bytes: number[], raw: string): ModbusMode {
  const trimmed = raw.trim();
  if (trimmed.startsWith(":") || bytes[0] === 0x3a) return "ASCII";
  if (bytes.length >= 8 && bytes[2] === 0 && bytes[3] === 0) {
    const len = be16(bytes, 4);
    if (len >= 2 && len === bytes.length - 6) return "TCP";
  }
  return "RTU";
}

function parseAscii(raw: string, bytes: number[]): { adu: number[]; lrcRecv: number; lrcOk: boolean } {
  const text = raw.trim().startsWith(":") ? raw : bytesToText(bytes);
  const compact = text.replace(/\s+/g, "").replace(/^:/, "").replace(/\r?\n$/, "");
  const hex = compact.replace(/[^0-9a-fA-F]/g, "");
  const all = hexToBytes(hex);
  if (all.length < 2) throw new Error(t("tools.asciiShort"));
  const lrcRecv = all[all.length - 1] ?? 0;
  const adu = all.slice(0, -1);
  return { adu, lrcRecv, lrcOk: lrc(adu) === lrcRecv };
}

export function parseModbus(input: string, modeHint: "auto" | ModbusMode = "auto"): ModbusParseResult {
  const raw = input.trim();
  if (!raw) throw new Error(t("tools.noData"));

  let bytes: number[];
  if (raw.startsWith(":")) {
    bytes = Array.from(new TextEncoder().encode(raw));
  } else {
    bytes = hexToBytes(raw);
    if (bytes.length === 0) throw new Error(t("err.hexIllegal"));
  }

  const mode = modeHint === "auto" ? detectMode(bytes, raw) : modeHint;
  const errors: string[] = [];
  let slave = 0;
  let pdu: number[] = [];
  const extra: ModbusParseField[] = [];

  if (mode === "ASCII") {
    const parsed = parseAscii(raw, bytes);
    slave = parsed.adu[0] ?? 0;
    pdu = parsed.adu.slice(1);
    extra.push({
      label: "LRC",
      value: parsed.lrcOk
        ? `OK ${parsed.lrcRecv.toString(16).toUpperCase().padStart(2, "0")}`
        : t("tools.crcGot", {
            got: parsed.lrcRecv.toString(16).toUpperCase().padStart(2, "0"),
            calc: lrc(parsed.adu).toString(16).toUpperCase().padStart(2, "0"),
          }),
    });
    if (!parsed.lrcOk) errors.push(t("tools.lrcFail"));
  } else if (mode === "TCP") {
    if (bytes.length < 8) throw new Error(t("tools.tcpShort"));
    const transaction = be16(bytes, 0);
    const protocol = be16(bytes, 2);
    const length = be16(bytes, 4);
    slave = bytes[6] ?? 0;
    pdu = bytes.slice(7);
    extra.push({ label: t("tools.tid"), value: String(transaction) });
    extra.push({ label: t("tools.protoId"), value: String(protocol) });
    extra.push({ label: t("tools.length"), value: String(length) });
    if (protocol !== 0) errors.push(t("tools.tcpProto"));
    if (length !== bytes.length - 6) errors.push(t("tools.mbapLen"));
  } else {
    if (bytes.length < 4) throw new Error(t("tools.rtuShort"));
    const crcRecv = (bytes[bytes.length - 2] ?? 0) | ((bytes[bytes.length - 1] ?? 0) << 8);
    const body = bytes.slice(0, -2);
    const crcCalc = crc16Modbus(body);
    slave = body[0] ?? 0;
    pdu = body.slice(1);
    extra.push({
      label: "CRC16",
      value: crcRecv === crcCalc
        ? `OK ${crcRecv.toString(16).toUpperCase().padStart(4, "0")}`
        : t("tools.crcGot", {
            got: crcRecv.toString(16).toUpperCase().padStart(4, "0"),
            calc: crcCalc.toString(16).toUpperCase().padStart(4, "0"),
          }),
    });
    if (crcRecv !== crcCalc) errors.push(t("tools.crcFail"));
  }

  const parsed = parsePdu(pdu);
  const fields: ModbusParseField[] = [
    { label: t("tools.proto"), value: mode },
    { label: t("tools.direction"), value: parsed.role === "request" ? t("tools.request") : parsed.role === "response" ? t("tools.response") : parsed.role === "exception" ? t("tools.exception") : t("tools.reqOrResp") },
    { label: t("lab.slave"), value: String(slave) },
    { label: t("tools.funcCode"), value: funcLabel(parsed.func) },
    ...parsed.fields,
    ...extra,
  ];

  return {
    ok: errors.length === 0 && parsed.errors.length === 0,
    mode,
    role: parsed.role,
    slave,
    func: parsed.func,
    funcName: funcLabel(parsed.func),
    address: parsed.address,
    quantity: parsed.quantity,
    payload: parsed.payload,
    fields,
    errors: [...parsed.errors, ...errors],
  };
}
