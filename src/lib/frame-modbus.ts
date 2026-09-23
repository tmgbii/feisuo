import { t } from "@/i18n";
import type { FrameSpan, ParsedFrame } from "@/lib/frame-engine";
import { parseModbus, type ModbusParseResult } from "@/lib/modbus";
import { decodePoints, type DecodedPoint, type ModbusPoint } from "@/lib/point-table";
import type { FrameSchema } from "@/lib/frame-schema";

export type ShownFrame = ParsedFrame & {
  points?: DecodedPoint[];
};

export function schemaLooksModbus(schema: FrameSchema): boolean {
  if (schema.schemaId.toLowerCase().includes("modbus")) return true;
  if (/modbus/i.test(schema.name)) return true;
  return schema.frame.checksum?.algo === "crc16-modbus";
}

/** 03/04 应答没有起始地址，用匹配的读请求。 */
export function lastModbusStart(
  messages: readonly { direction: string; hex: string; timestamp?: number }[],
  match?: { slave?: number; func?: number; beforeTs?: number },
): number | null {
  let fallback: number | null = null;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (!message || message.direction !== "tx") continue;
    if (match?.beforeTs != null && (message.timestamp ?? 0) > match.beforeTs) continue;
    try {
      const tx = parseModbus(message.hex);
      if (tx.address == null) continue;
      const slaveOk = match?.slave == null || tx.slave === match.slave;
      const funcOk = match?.func == null || (tx.func & 0x7f) === (match.func & 0x7f);
      if (slaveOk && funcOk) return tx.address;
      if (fallback == null) fallback = tx.address;
    } catch {
      /* 非 Modbus 发送 */
    }
  }
  return fallback;
}

const SKIP_LABELS = () =>
  new Set([
    t("tools.regsHex"),
    t("tools.regsDec"),
    t("tools.data"),
    t("tools.proto"),
    "CRC16",
    "LRC",
  ]);

function sliceHex(hex: string, offset: number, size: number) {
  return hex.trim().split(/\s+/).slice(offset, offset + size).join(" ");
}

function extraRange(label: string, mb: ModbusParseResult): { offset: number; size: number } | undefined {
  const base = mb.mode === "TCP" ? 7 : mb.mode === "RTU" ? 1 : undefined;
  if (base == null) return;
  if ((label === t("tools.startAddr") || label === t("lab.addr")) && mb.address != null) {
    return { offset: base + 1, size: 2 };
  }
  if (
    label === t("lab.qty")
    && mb.quantity != null
    && [0x01, 0x02, 0x03, 0x04, 0x0f, 0x10].includes(mb.func)
  ) {
    return { offset: base + 3, size: 2 };
  }
  if ((label === t("tools.value") || label === t("tools.coil")) && (mb.func === 0x05 || mb.func === 0x06)) {
    return { offset: base + 3, size: 2 };
  }
  if (label === t("tools.byteCount") && mb.payload) {
    const write = mb.func === 0x0f || mb.func === 0x10;
    return { offset: base + (write ? 5 : 1), size: 1 };
  }
}

export function enrichModbusFrame(
  frame: ParsedFrame,
  points: ModbusPoint[],
  startHint = 0,
): ShownFrame {
  let mb: ModbusParseResult;
  try {
    mb = parseModbus(frame.hex);
  } catch {
    return frame;
  }

  const fields = [...frame.fields];
  const spans: FrameSpan[] = [...(frame.spans ?? [])];
  let tone = spans.reduce((max, span) => Math.max(max, (span.tone ?? -1) + 1), 0);
  const seen = new Set(fields.map((f) => f.name));
  const slave = t("lab.slave");
  const funcNames = new Set([t("tools.func"), t("tools.funcCode"), "功能", "功能码"]);
  const skip = SKIP_LABELS();
  for (const item of mb.fields) {
    if (skip.has(item.label)) continue;
    if ((item.label === slave || item.label === "从站") && (seen.has(slave) || seen.has("从站"))) continue;
    if (funcNames.has(item.label)) {
      const i = fields.findIndex((f) => funcNames.has(f.name));
      if (i >= 0) {
        fields[i] = { ...fields[i], value: item.value };
        continue;
      }
    }
    if (seen.has(item.label)) continue;
    const range = extraRange(item.label, mb);
    const spanKey = range ? `extra:${fields.length}` : undefined;
    fields.push({
      name: item.label,
      value: item.value,
      raw: range ? sliceHex(frame.hex, range.offset, range.size) : "",
      offset: range?.offset,
      size: range?.size,
      spanKey,
    });
    if (range && spanKey) {
      spans.push({
        key: spanKey,
        name: item.label,
        offset: range.offset,
        size: range.size,
        role: "field",
        tone: tone++,
      });
    }
    seen.add(item.label);
  }

  let decoded: DecodedPoint[] = [];
  if (mb.payload && points.length) {
    const start = mb.address ?? startHint;
    if (Number.isFinite(start)) {
      decoded = decodePoints(points, start, mb.payload).map((point) => {
        if (mb.payloadAt == null || point.byteOffset == null) {
          return { ...point, byteOffset: undefined, byteSize: undefined };
        }
        return { ...point, byteOffset: mb.payloadAt + point.byteOffset };
      });
    }
  }

  return { ...frame, fields, spans, points: decoded };
}
