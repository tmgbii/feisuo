export function compactHex(input: string): string {
  return input.replace(/\s+/g, "");
}

export function isValidHex(input: string): boolean {
  const compact = compactHex(input);
  if (!compact) return false;
  return /^[0-9a-fA-F]+$/.test(compact) && compact.length % 2 === 0;
}

export function hexLooksIllegal(input: string): boolean {
  const compact = compactHex(input);
  if (!compact) return false;
  return !/^[0-9a-fA-F]*$/.test(compact) || compact.length % 2 !== 0;
}

export function hexToBytes(input: string): number[] {
  const compact = compactHex(input);
  const bytes: number[] = [];
  for (let i = 0; i < compact.length; i += 2) {
    bytes.push(Number.parseInt(compact.slice(i, i + 2), 16));
  }
  return bytes;
}

export function textToBytes(input: string): number[] {
  return Array.from(new TextEncoder().encode(input));
}

export function bytesToHex(bytes: number[]): string {
  return bytes
    .map((b) => b.toString(16).padStart(2, "0").toUpperCase())
    .join(" ");
}

export function bytesToAscii(bytes: number[]): string {
  return bytes
    .map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : "."))
    .join("");
}

export function bytesToText(bytes: number[]): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(bytes));
  } catch {
    return bytesToAscii(bytes);
  }
}
