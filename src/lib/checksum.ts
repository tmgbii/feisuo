import { bytesToHex, hexToBytes, textToBytes } from "@/lib/hex";

export function crc16Modbus(bytes: number[]): number {
  let crc = 0xffff;
  for (const b of bytes) {
    crc ^= b;
    for (let i = 0; i < 8; i += 1) {
      crc = crc & 1 ? (crc >> 1) ^ 0xa001 : crc >> 1;
    }
  }
  return crc & 0xffff;
}

export function crc16Ccitt(bytes: number[]): number {
  let crc = 0xffff;
  for (const b of bytes) {
    crc ^= b << 8;
    for (let i = 0; i < 8; i += 1) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc;
}

export function crc32(bytes: number[]): number {
  let crc = 0xffffffff;
  for (const b of bytes) {
    crc ^= b;
    for (let i = 0; i < 8; i += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function crc8(bytes: number[]): number {
  let crc = 0;
  for (const b of bytes) {
    crc ^= b;
    for (let i = 0; i < 8; i += 1) {
      crc = crc & 0x80 ? ((crc << 1) ^ 0x07) & 0xff : (crc << 1) & 0xff;
    }
  }
  return crc;
}

export function xorSum(bytes: number[]): number {
  return bytes.reduce((a, b) => a ^ b, 0) & 0xff;
}

export function addSum(bytes: number[]): number {
  return bytes.reduce((a, b) => a + b, 0) & 0xff;
}

export function lrc(bytes: number[]): number {
  return ((0x100 - addSum(bytes)) & 0xff);
}

export function appendCrc16Modbus(bytes: number[]): number[] {
  const crc = crc16Modbus(bytes);
  return [...bytes, crc & 0xff, (crc >> 8) & 0xff];
}

export function toHexWord(n: number, bytes = 2): string {
  return n.toString(16).toUpperCase().padStart(bytes * 2, "0");
}

export function parsePayload(input: string, asHex: boolean): number[] {
  return asHex ? hexToBytes(input) : textToBytes(input);
}

export function formatChecksum(name: string, value: number, width: number): string {
  return `${name} ${toHexWord(value, width)} (${value})`;
}

export { bytesToHex };
