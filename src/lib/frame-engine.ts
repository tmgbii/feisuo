import {
  addSum,
  crc16Ccitt,
  crc16Modbus,
  crc32,
  crc8,
  lrc,
  xorSum,
} from "@/lib/checksum";
import { bytesToHex, hexToBytes } from "@/lib/hex";
import { t } from "@/i18n";
import type { FrameEndian, FrameField, FrameSchema } from "@/lib/frame-schema";

export type FrameKind = "ok" | "partial" | "junk";

export interface DecodedField {
  name: string;
  raw: string;
  value: string;
}

export interface ParsedFrame {
  kind: FrameKind;
  hex: string;
  checksumOk?: boolean;
  checksumExpect?: string;
  checksumGot?: string;
  fields: DecodedField[];
  note?: string;
}

function hexBytes(input?: string): number[] {
  if (!input?.trim()) return [];
  return hexToBytes(input);
}

function readUInt(bytes: number[], offset: number, size: number, endian: FrameEndian): number {
  let n = 0;
  if (endian === "little") {
    for (let i = size - 1; i >= 0; i -= 1) n = (n << 8) | (bytes[offset + i] ?? 0);
  } else {
    for (let i = 0; i < size; i += 1) n = (n << 8) | (bytes[offset + i] ?? 0);
  }
  return n >>> 0;
}

function readInt(bytes: number[], offset: number, size: number, endian: FrameEndian): number {
  const u = readUInt(bytes, offset, size, endian);
  const bits = size * 8;
  const sign = 1 << (bits - 1);
  return u & sign ? u - (1 << bits) : u;
}

function findSeq(buf: number[], start: number, seq: number[]): number {
  if (!seq.length) return start;
  outer: for (let i = start; i <= buf.length - seq.length; i += 1) {
    for (let j = 0; j < seq.length; j += 1) {
      if (buf[i + j] !== seq[j]) continue outer;
    }
    return i;
  }
  return -1;
}

function unescape(buf: number[], rules: { from: number[]; to: number[] }[]): number[] {
  if (!rules.length) return buf;
  const out: number[] = [];
  let i = 0;
  while (i < buf.length) {
    const hit = rules.find(
      (r) => r.from.length && i + r.from.length <= buf.length && r.from.every((b, k) => buf[i + k] === b),
    );
    if (hit) {
      out.push(...hit.to);
      i += hit.from.length;
    } else {
      out.push(buf[i] ?? 0);
      i += 1;
    }
  }
  return out;
}

function checksumIndex(len: number, offset: number): number {
  if (offset < 0) return len + offset;
  return offset;
}

function checksumValue(algo: string, data: number[], size: number): number[] {
  const key = algo.toLowerCase();
  let n = 0;
  if (key === "crc16-modbus") n = crc16Modbus(data);
  else if (key === "crc16-ccitt") n = crc16Ccitt(data);
  else if (key === "crc32") n = crc32(data);
  else if (key === "crc8") n = crc8(data);
  else if (key === "lrc") n = lrc(data);
  else if (key === "xor") n = xorSum(data);
  else n = addSum(data);
  const out: number[] = [];
  if (key === "crc16-modbus") {
    out.push(n & 0xff, (n >> 8) & 0xff);
  } else {
    for (let i = size - 1; i >= 0; i -= 1) out.push((n >> (8 * i)) & 0xff);
  }
  return out.slice(0, size);
}

function checksumPayload(bytes: number[], cs: number): number[] {
  return bytes.slice(0, cs);
}

function frameTotal(schema: FrameSchema, length: number): number {
  const lf = schema.frame.lengthField;
  if (!lf) return length;
  const adj = lf.adjust ?? 0;
  const after = lf.offset + lf.size + length + adj;
  const extra =
    (schema.frame.checksum?.size ?? 0) + hexBytes(schema.frame.tail).length;
  if (lf.includes === "frame") return length + adj;
  if (lf.includes === "body") return after + extra;
  return after;
}

function decodeBcd(slice: number[]): string {
  let s = "";
  for (const b of slice) {
    const hi = (b >> 4) & 0xf;
    const lo = b & 0xf;
    if (hi <= 9) s += String(hi);
    if (lo <= 9) s += String(lo);
  }
  return s.replace(/^0+(?=\d)/, "") || "0";
}

function decodeFloat(slice: number[], endian: FrameEndian, bytes: 4 | 8): number {
  const raw = endian === "little" ? [...slice].reverse() : slice;
  const buf = new DataView(Uint8Array.from(raw).buffer);
  return bytes === 4 ? buf.getFloat32(0) : buf.getFloat64(0);
}

function formatNum(n: number, scale?: number, bias?: number, unit?: string): string {
  let v = n;
  if (scale != null) v *= scale;
  if (bias != null) v += bias;
  const text = Number.isInteger(v) ? String(v) : String(Number(v.toFixed(6)));
  return unit ? `${text} ${unit}` : text;
}

function decodeField(frame: number[], field: FrameField, endian: FrameEndian, schema: FrameSchema): DecodedField {
  let size: number;
  if (field.size === "rest") {
    let end = frame.length;
    const cs = schema.frame.checksum;
    if (cs && cs.size > 0) {
      const idx = checksumIndex(frame.length, cs.offset);
      if (idx >= 0) end = Math.min(end, idx);
    }
    const tail = hexBytes(schema.frame.tail).length;
    if (tail) end = Math.min(end, frame.length - tail);
    size = Math.max(0, end - field.offset);
  } else {
    size = field.size;
  }
  const slice = frame.slice(field.offset, field.offset + size);
  const raw = bytesToHex(slice);
  const end = field.endian ?? endian;
  let value = raw;
  try {
    switch (field.type) {
      case "uint8":
      case "uint16":
      case "uint32":
        value = formatNum(readUInt(slice, 0, slice.length, end), field.scale, field.bias, field.unit);
        break;
      case "int8":
      case "int16":
      case "int32":
        value = formatNum(readInt(slice, 0, slice.length, end), field.scale, field.bias, field.unit);
        break;
      case "bcd":
        value = formatNum(Number(decodeBcd(slice)) || 0, field.scale, field.bias, field.unit);
        if (!field.scale && !field.bias && !field.unit) value = decodeBcd(slice);
        break;
      case "ascii":
        value = slice.map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : ".")).join("");
        break;
      case "float32":
        value = formatNum(decodeFloat(slice, end, 4), field.scale, field.bias, field.unit);
        break;
      case "float64":
        value = formatNum(decodeFloat(slice, end, 8), field.scale, field.bias, field.unit);
        break;
      case "bit": {
        const bit = field.bit ?? 0;
        value = String(((slice[0] ?? 0) >> bit) & 1);
        break;
      }
      default:
        value = raw;
    }
  } catch {
    value = raw;
  }
  return { name: field.name, raw, value };
}

function inspectFrame(schema: FrameSchema, frame: number[]): ParsedFrame {
  const endian = schema.endian ?? "big";
  const cs = schema.frame.checksum;
  let checksumOk: boolean | undefined;
  let checksumExpect: string | undefined;
  let checksumGot: string | undefined;
  if (cs && cs.size > 0) {
      const idx = checksumIndex(frame.length, cs.offset);
    if (idx >= 0 && idx + cs.size <= frame.length) {
      const got = frame.slice(idx, idx + cs.size);
      const expect = checksumValue(cs.algo, checksumPayload(frame, idx), cs.size);
      checksumGot = bytesToHex(got);
      checksumExpect = bytesToHex(expect);
      checksumOk = got.every((b, i) => b === expect[i]);
    } else {
      checksumOk = false;
      checksumExpect = "—";
      checksumGot = "—";
    }
  }
  return {
    kind: "ok",
    hex: bytesToHex(frame),
    checksumOk,
    checksumExpect,
    checksumGot,
    fields: schema.fields.map((f) => decodeField(frame, f, endian, schema)),
  };
}

export function parseFrames(schema: FrameSchema, input: number[] | string): ParsedFrame[] {
  const raw = typeof input === "string" ? hexToBytes(input) : input;
  const rules = (schema.frame.escape ?? [])
    .filter((r) => r.from.trim() && r.to.trim())
    .map((r) => ({ from: hexBytes(r.from), to: hexBytes(r.to) }));
  const buf = unescape(raw, rules);
  const head = hexBytes(schema.frame.head);
  const tail = hexBytes(schema.frame.tail);
  const out: ParsedFrame[] = [];
  let i = 0;
  while (i < buf.length) {
    const at = head.length ? findSeq(buf, i, head) : i;
    if (at < 0) {
      out.push({ kind: "junk", hex: bytesToHex(buf.slice(i)), fields: [], note: t("tools.noHead") });
      break;
    }
    if (at > i) {
      out.push({ kind: "junk", hex: bytesToHex(buf.slice(i, at)), fields: [], note: t("tools.frameMiss") });
      i = at;
    }
    const lf = schema.frame.lengthField;
    if (lf) {
      const need = lf.offset + lf.size;
      if (i + need > buf.length) {
        out.push({ kind: "partial", hex: bytesToHex(buf.slice(i)), fields: [], note: t("tools.framePartial") });
        break;
      }
      const length = readUInt(buf, i + lf.offset, lf.size, lf.endian ?? schema.endian ?? "big");
      const total = frameTotal(schema, length);
      if (total <= 0 || i + total > buf.length) {
        out.push({ kind: "partial", hex: bytesToHex(buf.slice(i)), fields: [], note: t("tools.framePartial") });
        break;
      }
      if (tail.length) {
        const end = buf.slice(i + total - tail.length, i + total);
        if (tail.some((b, k) => end[k] !== b)) {
          out.push({ kind: "junk", hex: bytesToHex(buf.slice(i, i + total)), fields: [], note: t("tools.badTail") });
          i += Math.max(head.length, 1);
          continue;
        }
      }
      out.push(inspectFrame(schema, buf.slice(i, i + total)));
      i += total;
      continue;
    }
    if (tail.length) {
      const end = findSeq(buf, i + head.length, tail);
      if (end < 0) {
        out.push({ kind: "partial", hex: bytesToHex(buf.slice(i)), fields: [], note: t("tools.framePartial") });
        break;
      }
      const total = end + tail.length - i;
      out.push(inspectFrame(schema, buf.slice(i, i + total)));
      i += total;
      continue;
    }
    out.push(inspectFrame(schema, buf.slice(i)));
    break;
  }
  return out;
}
