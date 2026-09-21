export function parseByBase(input: string, base: 2 | 8 | 10 | 16): bigint | null {
  const raw = input.trim().replace(/\s+/g, "").replace(/^0x/i, "");
  if (!raw) return null;
  try {
    return BigInt(base === 10 ? raw : `${base === 16 ? "0x" : base === 8 ? "0o" : "0b"}${raw}`);
  } catch {
    return null;
  }
}

export function formatByBase(value: bigint, base: 2 | 8 | 10 | 16): string {
  const sign = value < 0n ? "-" : "";
  const abs = value < 0n ? -value : value;
  return sign + abs.toString(base).toUpperCase();
}

export function bytesToBase64(bytes: number[]): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export function base64ToBytes(input: string): number[] {
  const bin = atob(input.trim());
  return Array.from(bin, (c) => c.charCodeAt(0));
}

export function encodeUrl(input: string): string {
  return encodeURIComponent(input);
}

export function decodeUrl(input: string): string {
  return decodeURIComponent(input);
}

export function prettyJson(input: string): string {
  return JSON.stringify(JSON.parse(input), null, 2);
}

export function minifyJson(input: string): string {
  return JSON.stringify(JSON.parse(input));
}
