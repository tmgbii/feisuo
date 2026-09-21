const OSC_RE =
  /\x1b\](?:7;([^\x07\x1b]{1,2048})|1337;CurrentDir=([^\x07\x1b]{1,2048})|633;P;Cwd=([^\x07\x1b]{1,2048}))(?:\x07|\x1b\\)/g;

const oscTail = new Map<string, string>();
const decoders = new Map<string, TextDecoder>();

export function resetCwdTrack(id: string) {
  oscTail.delete(id);
  decoders.delete(id);
}

export function posixNormalize(path: string): string {
  const abs = path.startsWith("/");
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (parts.length && parts[parts.length - 1] !== "..") parts.pop();
      else if (!abs) parts.push("..");
      continue;
    }
    parts.push(part);
  }
  if (abs) return parts.length ? `/${parts.join("/")}` : "/";
  return parts.join("/") || ".";
}

export function samePosix(a: string, b: string): boolean {
  const na = posixNormalize(a).replace(/\/+$/, "") || "/";
  const nb = posixNormalize(b).replace(/\/+$/, "") || "/";
  return na === nb;
}

export function tokenize(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: "'" | '"' | null = null;
  let esc = false;
  for (const ch of line) {
    if (esc) {
      cur += ch;
      esc = false;
      continue;
    }
    if (quote === "'") {
      if (ch === "'") quote = null;
      else cur += ch;
      continue;
    }
    if (quote === '"') {
      if (ch === "\\") {
        esc = true;
        continue;
      }
      if (ch === '"') quote = null;
      else cur += ch;
      continue;
    }
    if (ch === "\\") {
      esc = true;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === "#" && !cur) break;
    if (/\s/.test(ch)) {
      if (cur) {
        out.push(cur);
        cur = "";
      }
      continue;
    }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

export type DirSpec = string | "home" | "back";

export function parseCdCommand(line: string): DirSpec | null {
  const tokens = tokenize(line);
  if (!tokens.length) return null;
  let i = 0;
  if (tokens[0] === "builtin") i++;
  const cmd = tokens[i++];
  if (cmd === "popd") return "back";
  if (cmd !== "cd" && cmd !== "pushd") return null;
  while (tokens[i] === "-L" || tokens[i] === "-P" || tokens[i] === "-e") i++;
  if (tokens[i] === "--") i++;
  if (i >= tokens.length) return cmd === "cd" ? "home" : null;
  if (i + 1 < tokens.length) return null;
  const spec = tokens[i] ?? "";
  if (!spec || spec === "-") return spec === "-" ? "back" : null;
  if (/[*$`?]/.test(spec) || spec.includes("$(")) return null;
  return spec;
}

function stripPrompt(clause: string): string {
  const m = clause.match(/[$%#❯]\s+([\s\S]*)$/) ?? clause.match(/~?>\s+([\s\S]*)$/);
  return (m?.[1] ?? "").trim();
}

export function dirSpecFromLine(line: string): DirSpec | null {
  const text = line.replace(/\s+$/, "");
  if (!text) return null;
  const clauses = text.split(/(?:&&|\|\||;)/).map((s) => s.trim()).filter(Boolean);
  for (let i = clauses.length - 1; i >= 0; i--) {
    const raw = clauses[i] ?? "";
    const spec = parseCdCommand(raw) ?? parseCdCommand(stripPrompt(raw));
    if (spec != null) return spec;
  }
  return null;
}

export function resolveRemotePath(
  cwd: string,
  home: string,
  prev: string | null,
  spec: DirSpec,
): string | null {
  if (spec === "home") return posixNormalize(home || "/");
  if (spec === "back") return prev ? posixNormalize(prev) : null;
  let raw = spec;
  if (!raw) return null;
  if (raw === "~" || raw === "~/") return posixNormalize(home || "/");
  if (raw.startsWith("~/")) raw = `${(home || "/").replace(/\/+$/, "")}/${raw.slice(2)}`;
  else if (raw === "~+") raw = cwd;
  else if (raw.startsWith("~")) return null;
  if (!raw.startsWith("/")) {
    const base = (cwd || "/").replace(/\/+$/, "") || "/";
    raw = base === "/" ? `/${raw}` : `${base}/${raw}`;
  }
  return posixNormalize(raw);
}

export function decodeOscPath(raw: string): string | null {
  const text = raw.trim();
  if (!text) return null;
  if (text.startsWith("file://")) {
    try {
      const path = decodeURIComponent(new URL(text).pathname || "");
      return path.startsWith("/") ? path : `/${path}`;
    } catch {
      const rest = text.slice("file://".length);
      const slash = rest.indexOf("/");
      if (slash < 0) return null;
      try {
        return decodeURIComponent(rest.slice(slash));
      } catch {
        return rest.slice(slash);
      }
    }
  }
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

export function takeOscPaths(id: string, bytes: number[]): string[] {
  if (!bytes.length) return [];
  let dec = decoders.get(id);
  if (!dec) {
    dec = new TextDecoder("utf-8");
    decoders.set(id, dec);
  }
  const chunk = dec.decode(new Uint8Array(bytes), { stream: true });
  const s = (oscTail.get(id) ?? "") + chunk;
  const paths: string[] = [];
  let last = 0;
  OSC_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = OSC_RE.exec(s))) {
    const raw = m[1] || m[2] || m[3] || "";
    const path = decodeOscPath(raw);
    if (path) paths.push(path);
    last = m.index + m[0].length;
  }
  oscTail.set(id, s.slice(Math.max(last, s.length - 4096)));
  return paths;
}
