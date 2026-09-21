import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon, type ISearchResultChangeEvent } from "@xterm/addon-search";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { Terminal } from "@xterm/xterm";
import { resolveSshTheme } from "@/lib/ssh-theme";
import type { SshAnsiTheme } from "@/types";

interface Held {
  term: Terminal;
  fit: FitAddon;
  search: SearchAddon;
  wired: boolean;
}

const held = new Map<string, Held>();

const SEARCH_DECO = {
  matchBackground: "#3a3d41",
  matchOverviewRuler: "#3a3d41",
  activeMatchBackground: "#515c6a",
  activeMatchColorOverviewRuler: "#515c6a",
};

export function terminalOf(
  id: string,
  opts: { theme: SshAnsiTheme; scrollback: number },
): Held {
  const palette = { ...resolveSshTheme(opts.theme) };
  const existing = held.get(id);
  if (existing) {
    existing.term.options.theme = palette;
    existing.term.options.scrollback = opts.scrollback;
    existing.term.refresh(0, existing.term.rows - 1);
    paintTerminal(existing.term, palette);
    return existing;
  }
  const term = new Terminal({
    cursorBlink: true,
    fontFamily: "JetBrains Mono, ui-monospace, Consolas, monospace",
    fontSize: 13,
    lineHeight: 1.2,
    scrollback: opts.scrollback,
    theme: palette,
    allowProposedApi: true,
    drawBoldTextInBrightColors: true,
    minimumContrastRatio: 1,
    overviewRuler: { width: 8 },
  });
  const fit = new FitAddon();
  const search = new SearchAddon();
  const unicode11 = new Unicode11Addon();
  term.loadAddon(fit);
  term.loadAddon(search);
  term.loadAddon(unicode11);
  term.unicode.activeVersion = "11";
  const item: Held = { term, fit, search, wired: false };
  held.set(id, item);
  return item;
}

export function paintTerminal(term: Terminal, palette = term.options.theme) {
  const el = term.element;
  if (!el) return;
  const bg = palette?.background ?? "";
  el.style.background = bg;
  el.style.color = palette?.foreground ?? "";
  const vp = el.querySelector(".xterm-viewport") as HTMLElement | null;
  if (vp) vp.style.background = bg || "transparent";
}

export function disposeTerminal(id: string) {
  const item = held.get(id);
  if (!item) return;
  item.term.blur();
  item.term.dispose();
  held.delete(id);
}

export function writeTerminal(id: string, data: Uint8Array | string) {
  held.get(id)?.term.write(data);
}

export function blurTerminalsExcept(id: string) {
  for (const [sid, item] of held) {
    if (sid !== id) item.term.blur();
  }
}

export function focusTerminal(id: string) {
  blurTerminalsExcept(id);
  held.get(id)?.term.focus();
}

export function terminalSize(id: string) {
  const item = held.get(id);
  return { cols: item?.term.cols || 80, rows: item?.term.rows || 24 };
}

export function terminalSelection(id: string) {
  return held.get(id)?.term.getSelection() ?? "";
}

export function terminalCommandLine(id: string) {
  const term = held.get(id)?.term;
  if (!term) return "";
  const buf = term.buffer.active;
  let y = buf.baseY + buf.cursorY;
  const chunks: string[] = [];
  while (y >= 0) {
    const line = buf.getLine(y);
    if (!line) break;
    chunks.unshift(line.translateToString(true));
    if (!line.isWrapped) break;
    y -= 1;
  }
  return chunks.join("").replace(/\s+$/, "");
}

export function pasteLineCount(text: string) {
  const norm = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const body = norm.endsWith("\n") ? norm.slice(0, -1) : norm;
  if (!body) return norm ? 1 : 0;
  return body.split("\n").length;
}

export function pasteTerminal(id: string, text: string) {
  if (!text) return;
  held.get(id)?.term.paste(text);
}

export function searchTerminal(id: string, query: string, next: boolean, incremental = false) {
  const item = held.get(id);
  if (!item || !query) return false;
  const opts = { incremental, decorations: SEARCH_DECO };
  return next ? item.search.findNext(query, opts) : item.search.findPrevious(query, opts);
}

export function onSearchResults(id: string, fn: (index: number, count: number) => void) {
  const item = held.get(id);
  if (!item) return () => {};
  const sub = item.search.onDidChangeResults((ev: ISearchResultChangeEvent) => {
    fn(ev.resultIndex, ev.resultCount);
  });
  return () => sub.dispose();
}

export function clearTerminalSearch(id: string) {
  held.get(id)?.search.clearDecorations();
}

export function resetTerminalInput(id: string) {
  const item = held.get(id);
  if (!item) return;
  const ta = item.term.textarea;
  if (ta) {
    ta.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
    ta.value = "";
  }
  item.term.element?.querySelector(".composition-view.active")?.classList.remove("active");
  item.term.focus();
}

export function isImeKey(ev: KeyboardEvent) {
  return ev.isComposing || ev.key === "Process" || ev.key === "Unidentified" || ev.keyCode === 229;
}

export function keyToSeq(ev: KeyboardEvent): string | null {
  if (isImeKey(ev) || ev.metaKey) return null;
  if (ev.ctrlKey && ev.key.length === 1) {
    const c = ev.key.toLowerCase().charCodeAt(0);
    if (c >= 97 && c <= 122) return String.fromCharCode(c - 96);
    return null;
  }
  if (ev.altKey) return null;
  switch (ev.key) {
    case "ArrowUp":
      return "\x1b[A";
    case "ArrowDown":
      return "\x1b[B";
    case "ArrowRight":
      return "\x1b[C";
    case "ArrowLeft":
      return "\x1b[D";
    case "Home":
      return "\x1b[H";
    case "End":
      return "\x1b[F";
    case "Insert":
      return "\x1b[2~";
    case "Delete":
      return "\x1b[3~";
    case "PageUp":
      return "\x1b[5~";
    case "PageDown":
      return "\x1b[6~";
    case "Backspace":
      return "\x7f";
    case "Enter":
      return "\r";
    case "Escape":
      return "\x1b";
    case "Tab":
      return ev.shiftKey ? "\x1b[Z" : "\t";
    default:
      return ev.key.length === 1 ? ev.key : null;
  }
}
