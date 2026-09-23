import { t } from "@/i18n";

export type FrameEndian = "big" | "little";

export type FrameFieldType =
  | "uint8"
  | "uint16"
  | "uint32"
  | "int8"
  | "int16"
  | "int32"
  | "hex"
  | "ascii"
  | "bcd"
  | "float32"
  | "float64"
  | "bit";

export interface FrameLengthField {
  offset: number;
  size: number;
  endian?: FrameEndian;
  includes?: "body" | "after" | "frame";
  adjust?: number;
}

export interface FrameChecksum {
  offset: number;
  size: number;
  algo: string;
}

export interface FrameEscapeRule {
  from: string;
  to: string;
}

export interface FrameSpec {
  head?: string;
  tail?: string;
  lengthField?: FrameLengthField;
  checksum?: FrameChecksum;
  escape?: FrameEscapeRule[] | null;
}

export interface FrameField {
  name: string;
  offset: number;
  size: number | "rest";
  type: FrameFieldType;
  endian?: FrameEndian;
  scale?: number;
  bias?: number;
  unit?: string;
  bit?: number;
}

export interface FrameSchema {
  schemaId: string;
  name: string;
  builtin?: boolean;
  sample?: string;
  endian?: FrameEndian;
  frame: FrameSpec;
  fields: FrameField[];
}

export const FIELD_TYPES: FrameFieldType[] = [
  "uint8",
  "uint16",
  "uint32",
  "int8",
  "int16",
  "int32",
  "hex",
  "ascii",
  "bcd",
  "float32",
  "float64",
  "bit",
];

export const CHECKSUM_ALGOS = [
  "sum8",
  "xor",
  "lrc",
  "crc8",
  "crc16-modbus",
  "crc16-ccitt",
  "crc32",
] as const;

export function blankField(): FrameField {
  return { name: "", offset: 0, size: 1, type: "hex" };
}

export function blankSchema(): FrameSchema {
  return {
    schemaId: crypto.randomUUID(),
    name: t("pack.unnamed"),
    builtin: false,
    endian: "big",
    frame: { head: "", tail: "" },
    fields: [],
  };
}

const SCHEMA_LABELS: Record<string, string> = {
  从站: "lab.slave",
  功能码: "tools.funcCode",
  事务元: "tools.tid",
  协议元: "tools.protoMeta",
  协议标识: "tools.protoId",
  长度: "tools.length",
  单元: "lab.unit",
  数据: "tools.data",
  表地址: "tools.meterAddr",
  仪表类型: "tools.meterType",
  累计电量: "tools.energy",
  控制码: "tools.ctrlCode",
  控制域: "tools.ctrlField",
  命令: "tools.cmd",
  应答: "tools.response",
  加密: "tools.encrypt",
  "通用 AA55": "tools.genericAa55",
  "耀华 XK3190": "tools.xk3190",
  状态: "tools.status",
  重量: "tools.weight",
  单位: "tools.unit",
  未命名: "pack.unnamed",
};

export function schemaLabel(name: string): string {
  const key = SCHEMA_LABELS[name];
  return key ? t(key) : name;
}
