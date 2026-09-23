export function compactHex(input: string): string {
  return input.replace(/\s+/g, "");
}

/** Turn a hex dump into uppercase bytes. Null when the text is not hex. */
export function formatHexDump(input: string): string | null {
  const stripped = input.replace(/0x/gi, "");
  const junk = stripped.replace(/[0-9a-fA-F]/g, "");
  if (junk && !/^[\s,;:._-]*$/.test(junk)) return null;
  const compact = stripped.replace(/[^0-9a-fA-F]/g, "");
  if (compact.length < 2) return null;
  return compact.toUpperCase().match(/.{1,2}/g)!.join(" ");
}

export function takeHexPaste(
  event: ClipboardEvent,
  current: string,
): { text: string; caret: number } | null {
  const clip = event.clipboardData?.getData("text");
  if (!clip) return null;
  const el = event.target as HTMLTextAreaElement | HTMLInputElement | null;
  const start = el?.selectionStart ?? current.length;
  const end = el?.selectionEnd ?? start;
  const text = formatHexDump(current.slice(0, start) + clip + current.slice(end));
  if (text == null) return null;
  const digits =
    current.slice(0, start).replace(/0x/gi, "").replace(/[^0-9a-fA-F]/g, "").length +
    clip.replace(/0x/gi, "").replace(/[^0-9a-fA-F]/g, "").length;
  const caret = digits + (digits > 0 ? Math.floor((digits - 1) / 2) : 0);
  return { text, caret };
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
