import { t } from "@/i18n";

export type PointType = "u16" | "i16" | "u32" | "i32" | "f32" | "bcd32" | "bool";
export type WordOrder = "ABCD" | "CDAB" | "BADC" | "DCBA";

export interface ModbusPoint {
  id: string;
  name: string;
  address: number;
  type: PointType;
  order: WordOrder;
  scale: number;
  offset: number;
  digits: number;
  unit: string;
}

export interface DecodedPoint {
  name: string;
  address: number;
  text: string;
  raw: string;
  unit: string;
  error?: string;
}

export const POINT_TYPE_OPTIONS = [
  { value: "u16", label: "uint16" },
  { value: "i16", label: "int16" },
  { value: "u32", label: "uint32" },
  { value: "i32", label: "int32" },
  { value: "f32", label: "float32" },
  { value: "bcd32", get label() { return t("tools.bcd32"); } },
  { value: "bool", label: "bool" },
];

export const WORD_ORDER_OPTIONS = [
  { value: "ABCD", get label() { return t("tools.abcd"); } },
  { value: "CDAB", get label() { return t("tools.cdab"); } },
  { value: "BADC", get label() { return t("tools.badc"); } },
  { value: "DCBA", get label() { return t("tools.dcba"); } },
];

export function newPoint(partial: Partial<ModbusPoint> = {}): ModbusPoint {
  return {
    id: crypto.randomUUID(),
    name: "",
    address: 0,
    type: "u16",
    order: "ABCD",
    scale: 1,
    offset: 0,
    digits: 2,
    unit: "",
    ...partial,
  };
}

export function pointSpan(type: PointType): number {
  if (type === "u32" || type === "i32" || type === "f32" || type === "bcd32") return 2;
  return 1;
}

export function isWideType(type: PointType): boolean {
  return type === "u32" || type === "i32" || type === "f32" || type === "bcd32";
}

export function pointRange(points: ModbusPoint[]): { address: number; quantity: number } | null {
  const valid = points.filter((p) => p.name.trim() || p.address >= 0);
  if (!valid.length) return null;
  let min = Infinity;
  let max = -Infinity;
  for (const p of valid) {
    min = Math.min(min, p.address);
    max = Math.max(max, p.address + pointSpan(p.type) - 1);
  }
  if (!Number.isFinite(min) || max < min) return null;
  return { address: min, quantity: max - min + 1 };
}

export function permuteBytes(bytes: number[], order: WordOrder): number[] {
  const n = bytes.length;
  if (n < 2) return bytes.slice();
  const words: [number, number][] = [];
  for (let i = 0; i + 1 < n; i += 2) words.push([bytes[i] ?? 0, bytes[i + 1] ?? 0]);
  let next = words;
  switch (order) {
    case "CDAB": {
      const swapped: [number, number][] = [];
      for (let i = 0; i + 1 < words.length; i += 2) swapped.push(words[i + 1], words[i]);
      if (words.length % 2) swapped.push(words[words.length - 1]);
      next = swapped;
      break;
    }
    case "BADC":
      next = words.map(([a, b]) => [b, a]);
      break;
    case "DCBA":
      next = [...words].reverse().map(([a, b]) => [b, a]);
      break;
    default:
      next = words;
  }
  const out = next.flat();
  if (n % 2) out.push(bytes[n - 1] ?? 0);
  return out;
}

function reorder(bytes: number[], order: WordOrder): number[] {
  return permuteBytes(bytes.slice(0, 4), order);
}

export interface IeeeRow {
  order: WordOrder;
  bytes: number[];
  float32: number | null;
  float64: number | null;
}

function readFloat(bytes: number[], little: boolean, size: 4 | 8): number {
  const view = new DataView(new ArrayBuffer(size));
  for (let i = 0; i < size; i += 1) view.setUint8(i, bytes[i] ?? 0);
  return size === 4 ? view.getFloat32(0, little) : view.getFloat64(0, little);
}

export function decodeIeee(bytes: number[], order: WordOrder): IeeeRow {
  const n = permuteBytes(bytes, order);
  return {
    order,
    bytes: n,
    float32: n.length >= 4 ? readFloat(n, false, 4) : null,
    float64: n.length >= 8 ? readFloat(n, false, 8) : null,
  };
}

export function decodeIeeeTable(bytes: number[]): IeeeRow[] {
  return WORD_ORDER_OPTIONS.map((opt) => decodeIeee(bytes, opt.value as WordOrder));
}

export function formatIeee(n: number | null): string {
  if (n == null) return "—";
  if (Number.isNaN(n)) return "NaN";
  if (n === Infinity) return "+Inf";
  if (n === -Infinity) return "-Inf";
  if (Object.is(n, -0)) return "-0";
  return String(n);
}

function view32(bytes: number[]): DataView {
  const buf = new ArrayBuffer(4);
  const view = new DataView(buf);
  for (let i = 0; i < 4; i += 1) view.setUint8(i, bytes[i] ?? 0);
  return view;
}

function formatValue(raw: number, scale: number, offset: number, digits: number): string {
  const v = raw * (Number.isFinite(scale) ? scale : 1) + (Number.isFinite(offset) ? offset : 0);
  if (!Number.isFinite(v)) return String(raw);
  const d = Math.min(8, Math.max(0, Number.isFinite(digits) ? digits : 2));
  if (Number.isInteger(v) && d === 0) return String(v);
  return v.toFixed(d);
}

function bcdDigits(bytes: number[]): string {
  let out = "";
  for (const byte of bytes) {
    const hi = (byte >> 4) & 0xf;
    const lo = byte & 0xf;
    if (hi > 9 || lo > 9) throw new Error(t("err.badBcd"));
    out += `${hi}${lo}`;
  }
  return out;
}

function bcdValue(bytes: number[], fracDigits: number): number {
  const digits = bcdDigits(bytes);
  const frac = Math.min(digits.length, Math.max(0, fracDigits));
  const whole = digits.slice(0, digits.length - frac) || "0";
  const part = digits.slice(digits.length - frac);
  return Number(frac ? `${whole}.${part}` : whole);
}

export function decodePoints(
  points: ModbusPoint[],
  start: number,
  payload: { kind: "registers" | "coils"; bytes: number[] },
): DecodedPoint[] {
  const end =
    payload.kind === "registers"
      ? start + Math.floor(payload.bytes.length / 2)
      : start + payload.bytes.length * 8;
  const out: DecodedPoint[] = [];
  for (const point of points) {
    if (!point.name.trim()) continue;
    const span = pointSpan(point.type);
    if (point.address < start || point.address + span > end) continue;
    const offset = point.address - start;
    if (point.type === "bool" || payload.kind === "coils") {
      const byte = payload.bytes[Math.floor(offset / 8)] ?? 0;
      const bit = (byte >> (offset % 8)) & 1;
      out.push({
        name: point.name,
        address: point.address,
        text: bit ? "ON" : "OFF",
        raw: String(bit),
        unit: point.unit,
      });
      continue;
    }
    const byteIndex = offset * 2;
    try {
      if (span === 1) {
        const hi = payload.bytes[byteIndex] ?? 0;
        const lo = payload.bytes[byteIndex + 1] ?? 0;
        const u = (hi << 8) | lo;
        const raw = point.type === "i16" ? (u > 0x7fff ? u - 0x10000 : u) : u;
        out.push({
          name: point.name,
          address: point.address,
          text: formatValue(raw, point.scale, point.offset, point.digits),
          raw: `0x${u.toString(16).toUpperCase().padStart(4, "0")}`,
          unit: point.unit,
        });
      } else {
        const word = [
          payload.bytes[byteIndex] ?? 0,
          payload.bytes[byteIndex + 1] ?? 0,
          payload.bytes[byteIndex + 2] ?? 0,
          payload.bytes[byteIndex + 3] ?? 0,
        ];
        const ordered = reorder(word, point.order);
        let raw: number;
        if (point.type === "bcd32") raw = bcdValue(ordered, point.digits);
        else {
          const dv = view32(ordered);
          if (point.type === "f32") raw = dv.getFloat32(0, false);
          else if (point.type === "i32") raw = dv.getInt32(0, false);
          else raw = dv.getUint32(0, false);
        }
        out.push({
          name: point.name,
          address: point.address,
          text: formatValue(raw, point.scale, point.offset, point.digits),
          raw: word.map((b) => b.toString(16).toUpperCase().padStart(2, "0")).join(" "),
          unit: point.unit,
        });
      }
    } catch (err) {
      out.push({
        name: point.name,
        address: point.address,
        text: "—",
        raw: "",
        unit: point.unit,
        error: err instanceof Error ? err.message : t("err.decodeFail"),
      });
    }
  }
  return out;
}

function parseType(raw: string): PointType {
  const t = raw.trim().toLowerCase().replace(/\s+/g, "");
  if (["bcd32", "bcd", "bcd16", "packedbcd", "bcd码"].includes(t)) return "bcd32";
  if (["f32", "float", "float32", "real", "float32be", "单精度", "浮点"].includes(t)) return "f32";
  if (["u32", "uint32", "dword", "udint", "uint"].includes(t)) return "u32";
  if (["i32", "int32", "dint", "long"].includes(t)) return "i32";
  if (["i16", "int16", "int", "short"].includes(t)) return "i16";
  if (["bool", "coil", "bit", "boolean", "线圈"].includes(t)) return "bool";
  return "u16";
}

function parseOrder(raw: string): WordOrder {
  const t = raw.trim().toUpperCase().replace(/[-_\s]/g, "");
  if (t === "CDAB" || t === "MIDLITTLE" || t === "WORDSWAP" || t.includes("字交换")) return "CDAB";
  if (t === "BADC") return "BADC";
  if (t === "DCBA" || t === "LITTLE") return "DCBA";
  return "ABCD";
}

function parseAddr(raw: string): number {
  const s = raw.trim();
  if (/^0x/i.test(s)) return Number.parseInt(s, 16);
  const n = Number.parseInt(s, 10);
  if (n >= 40001 && n < 50000) return n - 40001;
  if (n >= 30001 && n < 40000) return n - 30001;
  return n;
}

function asPoint(item: Record<string, unknown>): ModbusPoint {
  return newPoint({
    name: String(item.name ?? item.名称 ?? ""),
    address: parseAddr(String(item.address ?? item.addr ?? item.地址 ?? 0)),
    type: parseType(String(item.type ?? item.类型 ?? "u16")),
    order: parseOrder(String(item.order ?? item.endian ?? item.字节序 ?? "ABCD")),
    scale: Number(item.scale ?? item.系数 ?? 1) || 1,
    offset: Number(item.offset ?? item.偏移 ?? 0) || 0,
    digits: Number(item.digits ?? item.小数 ?? 2) || 0,
    unit: String(item.unit ?? item.单位 ?? ""),
  });
}

function extractJsonArray(text: string): unknown[] | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = (fenced?.[1] ?? text).trim();
  const start = body.indexOf("[");
  const end = body.lastIndexOf("]");
  if (start < 0 || end <= start) return null;
  try {
    const data = JSON.parse(body.slice(start, end + 1)) as unknown;
    return Array.isArray(data) ? data : null;
  } catch {
    return null;
  }
}

export function importPoints(text: string): ModbusPoint[] {
  const raw = text.trim();
  if (!raw) return [];
  const json = extractJsonArray(raw);
  if (json) {
    return json
      .map((row) => asPoint((row ?? {}) as Record<string, unknown>))
      .filter((p) => p.name.trim());
  }
  const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !/^[-|:]+$/.test(l.replace(/\s/g, "")));
  const points: ModbusPoint[] = [];
  for (const line of lines) {
    if (/^名称|^name|^#/i.test(line.replace(/\|/g, "").trim())) continue;
    const cols = line
      .replace(/^\||\|$/g, "")
      .split(/[,，\t;；|]/)
      .map((c) => c.trim())
      .filter(Boolean);
    if (cols.length < 2) continue;
    const address = parseAddr(cols[1] ?? "0");
    if (Number.isNaN(address)) continue;
    const point = newPoint({
      name: cols[0] ?? "",
      address,
      type: parseType(cols[2] ?? "u16"),
      order: parseOrder(cols[3] ?? "ABCD"),
      scale: Number(cols[4] ?? 1) || 1,
      offset: Number(cols[5] ?? 0) || 0,
      digits: Number(cols[6] ?? 2) || 0,
      unit: cols[7] ?? "",
    });
    if (point.name) points.push(point);
  }
  return points;
}

export const AI_POINT_PROMPT = `根据这份设备说明书，整理 Modbus 点表。

只输出 JSON 数组，不要解释、不要 markdown。格式：
[{"name":"瞬时流量","address":0,"type":"f32","order":"CDAB","scale":1,"offset":0,"digits":3,"unit":"m³/h"}]

规则：
- address：寄存器地址，十进制。若说明书是 40001/30001，改成 0 起始。
- type 只能是：u16、i16、u32、i32、f32、bcd32、bool
- bcd32：4 字节 packed BCD，厂商约定，不是 Modbus 标准类型。digits 为说明书小数位（12 34 56 78、4 位小数 → 1234.5678）；字序按说明书
- order 仅 32 位有效：说明书写字交换/CDAB 就用 CDAB，否则 ABCD
- scale 是分辨率/系数，bcd32 一般 1；offset 没有就 0
- 只要实际测点，不要功能码说明、保留字

说明书如下（或见附件）：
`;
