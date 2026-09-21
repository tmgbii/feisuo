import { METER_FIXTURE, type FrameSchema } from "@/lib/frame-schema";

export const BUILTIN_SCHEMAS: FrameSchema[] = [
  METER_FIXTURE,
  {
    schemaId: "modbus-rtu",
    name: "Modbus RTU",
    builtin: true,
    sample: "01 03 00 00 00 01 84 0A",
    endian: "big",
    frame: {
      checksum: { offset: -2, size: 2, algo: "crc16-modbus" },
    },
    fields: [
      { name: "从站", offset: 0, size: 1, type: "uint8" },
      { name: "功能码", offset: 1, size: 1, type: "uint8" },
      { name: "PDU", offset: 2, size: "rest", type: "hex" },
    ],
  },
  {
    schemaId: "modbus-tcp",
    name: "Modbus TCP",
    builtin: true,
    sample: "00 01 00 00 00 06 01 03 00 00 00 01",
    endian: "big",
    frame: {
      lengthField: { offset: 4, size: 2, includes: "after" },
    },
    fields: [
      { name: "事务元", offset: 0, size: 2, type: "uint16" },
      { name: "协议元", offset: 2, size: 2, type: "uint16" },
      { name: "长度", offset: 4, size: 2, type: "uint16" },
      { name: "单元", offset: 6, size: 1, type: "uint8" },
      { name: "功能码", offset: 7, size: 1, type: "uint8" },
      { name: "PDU", offset: 8, size: "rest", type: "hex" },
    ],
  },
  {
    schemaId: "dlt645-2007",
    name: "DL/T 645-2007",
    builtin: true,
    sample: "68 11 11 11 11 11 11 68 11 04 33 33 33 33 17 16",
    endian: "little",
    frame: {
      head: "68",
      tail: "16",
      lengthField: { offset: 9, size: 1, includes: "body" },
      checksum: { offset: -2, size: 1, algo: "sum8" },
    },
    fields: [
      { name: "表地址", offset: 1, size: 6, type: "bcd" },
      { name: "控制码", offset: 8, size: 1, type: "uint8" },
      { name: "长度", offset: 9, size: 1, type: "uint8" },
      { name: "数据", offset: 10, size: "rest", type: "hex" },
    ],
  },
  {
    schemaId: "iec104",
    name: "IEC 104",
    builtin: true,
    sample: "68 0A 00 00 00 00 64 01 06 00 01 00",
    endian: "little",
    frame: {
      head: "68",
      lengthField: { offset: 1, size: 1, includes: "after" },
    },
    fields: [
      { name: "长度", offset: 1, size: 1, type: "uint8" },
      { name: "控制域", offset: 2, size: 4, type: "hex" },
      { name: "ASDU", offset: 6, size: "rest", type: "hex" },
    ],
  },
  {
    schemaId: "gb32960",
    name: "GB/T 32960",
    builtin: true,
    sample: "23 23 01 FE 31 32 33 34 35 36 37 38 39 30 31 32 33 34 35 01 00 01 00 CF",
    endian: "big",
    frame: {
      head: "23 23",
      lengthField: { offset: 22, size: 2, includes: "body" },
      checksum: { offset: -1, size: 1, algo: "xor" },
    },
    fields: [
      { name: "命令", offset: 2, size: 1, type: "uint8" },
      { name: "应答", offset: 3, size: 1, type: "uint8" },
      { name: "VIN", offset: 4, size: 17, type: "ascii" },
      { name: "加密", offset: 21, size: 1, type: "uint8" },
      { name: "长度", offset: 22, size: 2, type: "uint16" },
      { name: "数据", offset: 24, size: "rest", type: "hex" },
    ],
  },
  {
    schemaId: "generic-aa55",
    name: "通用 AA55",
    builtin: true,
    sample: "AA 55 03 11 22 33 FC",
    endian: "big",
    frame: {
      head: "AA 55",
      lengthField: { offset: 2, size: 1, includes: "body" },
      checksum: { offset: -1, size: 1, algo: "xor" },
    },
    fields: [
      { name: "长度", offset: 2, size: 1, type: "uint8" },
      { name: "数据", offset: 3, size: "rest", type: "hex" },
    ],
  },
];

export const SCHEMA_PROMPT = `你是飞梭（Feisuo）协议解析 schema 生成器。用户给出协议名称或一份 HEX 样例，你只输出可导入的 JSON，不要解释。

导入格式：
{"version":1,"schemas":[<schema>, ...]}

schema 字段：
- schemaId: 稳定英文 id
- name: 短中文名
- endian: "big" | "little"（默认 big；字段可覆盖）
- sample: 空格分隔 HEX 样例（可选）
- frame.head / frame.tail: 空格分隔 HEX，可空
- frame.lengthField: { offset, size, endian?, includes, adjust? }
  includes: "body" 长度=其后负载；"after" 长度=长度域之后到帧尾；"frame" 长度=整帧。adjust 可正可负。
  长度域是二进制整数，不是 ASCII 数字。
- frame.checksum: { offset, size, algo }
  offset 可负（相对帧尾，-1 最后一字节，-2 倒数第二）。校验范围永远是「帧起始 → 校验字节之前」。
  algo 仅限：sum8 | xor | lrc | crc8 | crc16-modbus | crc16-ccitt | crc32
  crc16-modbus 按小端写入。
- frame.escape: [{from,to}] HEX，可空。引擎先对整段还原再切帧。
- fields: [{ name, offset, size, type, endian?, scale?, bias?, unit?, bit? }]
  size 为字节数或 "rest"（到校验/帧尾之前的剩余；含校验时 rest 会吃到帧尾，不要把校验再单列）。
  type: uint8|uint16|uint32|int8|int16|int32|hex|ascii|bcd|float32|float64|bit
  数值偏置键名是 bias，禁止用 offset。

切帧规则：有 lengthField 按长度切；否则有 tail 则扫到帧尾；都没有则整段 HEX 当一帧（适合 Modbus RTU）。
做不到的不要硬编：ASCII 长度（如 HJ212 的 LLLL）、可变剩余长度（MQTT）、校验不含帧头且帧头异或不为 0、跨字节位域、脚本/表达式。

只输出 JSON。`;
