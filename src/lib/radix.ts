export type Radix = "DEC" | "HEX" | "STR";
export type NumericRadix = "DEC" | "HEX";
export type PayloadRadix = "HEX" | "STR";

export function parseRadix(raw: string, radix: NumericRadix): number | null {
  const t = raw.trim().replace(/^0x/i, "").replace(/\s+/g, "");
  if (!t) return null;
  if (radix === "HEX" && !/^[0-9a-fA-F]+$/.test(t)) return null;
  if (radix === "DEC" && !/^[+-]?\d+$/.test(t)) return null;
  const n = Number.parseInt(t, radix === "HEX" ? 16 : 10);
  return Number.isFinite(n) ? n : null;
}

export function formatRadix(n: number, radix: NumericRadix, hexDigits = 2): string {
  if (!Number.isFinite(n)) return "";
  if (radix === "DEC") return String(n);
  const hex = (n >>> 0).toString(16).toUpperCase();
  const width = Math.max(hexDigits, hex.length + (hex.length % 2));
  return hex.padStart(width, "0");
}

export function toggleRadix(radix: NumericRadix): NumericRadix {
  return radix === "DEC" ? "HEX" : "DEC";
}

export function togglePayload(radix: PayloadRadix): PayloadRadix {
  return radix === "HEX" ? "STR" : "HEX";
}

export function payloadFromMode(mode: "hex" | "ascii"): PayloadRadix {
  return mode === "hex" ? "HEX" : "STR";
}

export function modeFromPayload(radix: PayloadRadix): "hex" | "ascii" {
  return radix === "HEX" ? "hex" : "ascii";
}
