export function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) {
    const kb = n / 1024;
    return `${kb >= 10 ? kb.toFixed(0) : kb.toFixed(1)}KB`;
  }
  const mb = n / (1024 * 1024);
  return `${mb >= 10 ? mb.toFixed(0) : mb.toFixed(1)}MB`;
}

export function formatClock(ts: number): string {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  const ms = String(d.getMilliseconds()).padStart(3, "0");
  return `${hh}:${mm}:${ss}.${ms}`;
}

export function formatDateTime(ts: number): string {
  const d = new Date(ts);
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, "0");
  const da = String(d.getDate()).padStart(2, "0");
  return `${y}-${mo}-${da} ${formatClock(ts).slice(0, 8)}`;
}

export function fileName(path: string): string {
  if (!path) return "";
  return path.replace(/\\/g, "/").split("/").pop() || path;
}
