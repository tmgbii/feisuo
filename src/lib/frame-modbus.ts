import { t } from "@/i18n";
import type { ParsedFrame } from "@/lib/frame-engine";
import { parseModbus } from "@/lib/modbus";
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

export function enrichModbusFrame(
  frame: ParsedFrame,
  points: ModbusPoint[],
  startHint = 0,
): ShownFrame {
  let mb;
  try {
    mb = parseModbus(frame.hex);
  } catch {
    return frame;
  }

  const fields = frame.fields.filter(
    (f) => f.name !== "PDU" && f.name !== t("tools.data") && f.name !== "数据",
  );
  const seen = new Set(fields.map((f) => f.name));
  const slave = t("lab.slave");
  const funcNames = new Set([t("tools.func"), t("tools.funcCode"), "功能", "功能码"]);
  for (const item of mb.fields) {
    if ((item.label === slave || item.label === "从站") && (seen.has(slave) || seen.has("从站"))) continue;
    if (funcNames.has(item.label)) {
      const i = fields.findIndex((f) => funcNames.has(f.name));
      if (i >= 0) {
        fields[i] = { ...fields[i], value: item.value };
        continue;
      }
    }
    if (seen.has(item.label)) continue;
    fields.push({ name: item.label, value: item.value, raw: "" });
    seen.add(item.label);
  }

  let decoded: DecodedPoint[] = [];
  if (mb.payload && points.length) {
    const start = mb.address ?? startHint;
    if (Number.isFinite(start)) decoded = decodePoints(points, start, mb.payload);
  }

  return { ...frame, fields, points: decoded };
}
