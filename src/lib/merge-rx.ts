import type { LogMessage } from "@/types";
import { bytesToHex, bytesToText, hexToBytes } from "@/lib/hex";

export function concatBytes(messages: LogMessage[]): number[] {
  const ordered = [...messages].sort((a, b) => a.timestamp - b.timestamp || a.id.localeCompare(b.id));
  const bytes: number[] = [];
  for (const item of ordered) bytes.push(...hexToBytes(item.hex));
  return bytes;
}

export function concatHex(messages: LogMessage[]): string {
  return bytesToHex(concatBytes(messages));
}

export function concatText(messages: LogMessage[]): string {
  return bytesToText(concatBytes(messages));
}
