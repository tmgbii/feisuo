export const MODE_BITS = {
  ownerR: 0o400,
  ownerW: 0o200,
  ownerX: 0o100,
  groupR: 0o040,
  groupW: 0o020,
  groupX: 0o010,
  otherR: 0o004,
  otherW: 0o002,
  otherX: 0o001,
  setuid: 0o4000,
  setgid: 0o2000,
  sticky: 0o1000,
} as const;

export const MODE_PRESETS = [0o644, 0o755, 0o600, 0o700, 0o777] as const;

export function parseMode(text: string): number | null {
  const s = text.trim();
  if (!/^[0-7]{3,4}$/.test(s)) return null;
  return Number.parseInt(s, 8);
}

export function formatOctal(mode: number): string {
  return (mode & 0o7777).toString(8).padStart(4, "0");
}

export function formatSymbolic(mode: number, isDir = false): string {
  const chars = ["r", "w", "x", "r", "w", "x", "r", "w", "x"];
  let out = "";
  for (let i = 0; i < 9; i++) {
    out += mode & (1 << (8 - i)) ? chars[i] : "-";
  }
  if (mode & MODE_BITS.setuid) out = `${out[0]}${out[1]}${out[2] === "x" ? "s" : "S"}${out.slice(3)}`;
  if (mode & MODE_BITS.setgid) out = `${out.slice(0, 3)}${out[3]}${out[4]}${out[5] === "x" ? "s" : "S"}${out.slice(6)}`;
  if (mode & MODE_BITS.sticky) out = `${out.slice(0, 6)}${out[6]}${out[7]}${out[8] === "x" ? "t" : "T"}`;
  return `${isDir ? "d" : "-"}${out}`;
}
