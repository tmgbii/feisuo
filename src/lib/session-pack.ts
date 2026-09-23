import { toast } from "vue-sonner";
import { t } from "@/i18n";
import type { SessionSnapshot } from "@/stores/sessions";
import { useSessionsStore } from "@/stores/sessions";
import { useHostsStore } from "@/stores/hosts";
import { useUiStore } from "@/stores/ui";
import { errorMessage, isTauri, pickSavePath, writeLocalFile } from "@/lib/ipc";
import type { SshHost, SendHistoryItem } from "@/types";

export interface SessionPack {
  version: 1;
  exportedAt?: number;
  sessions: SessionSnapshot[];
  history?: SendHistoryItem[];
  sshHosts?: SshHost[];
}

const PACK_HEADER = "FEISUO1\n";
const PACK_SEED = "feisuo-session-pack-v1";

function bytesToB64(bytes: Uint8Array): string {
  let s = "";
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    s += String.fromCharCode(...bytes.subarray(i, i + step));
  }
  return btoa(s);
}

function b64ToBytes(text: string): Uint8Array {
  const bin = atob(text);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

async function packKey(): Promise<CryptoKey> {
  const raw = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(PACK_SEED));
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function encodePack(data: unknown): Promise<string> {
  const key = await packKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      key,
      new TextEncoder().encode(JSON.stringify(data)),
    ),
  );
  const body = new Uint8Array(iv.length + ct.length);
  body.set(iv);
  body.set(ct, iv.length);
  return PACK_HEADER + bytesToB64(body);
}

export async function decodePackText(text: string): Promise<unknown> {
  const raw = text.replace(/^\uFEFF/, "").trim();
  const packed = raw.match(/^FEISUO1\r?\n([\s\S]+)$/);
  if (!packed) {
    return JSON.parse(raw);
  }
  const body = b64ToBytes(packed[1].replace(/\s+/g, ""));
  if (body.length < 13) throw new Error(t("pack.badFile"));
  try {
    const key = await packKey();
    const iv = new Uint8Array(body.subarray(0, 12));
    const ct = new Uint8Array(body.subarray(12));
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
    return JSON.parse(new TextDecoder().decode(pt));
  } catch {
    throw new Error(t("pack.badFile"));
  }
}

function downloadText(filename: string, body: string, type = "application/octet-stream") {
  const blob = new Blob([body], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export function downloadJson(filename: string, data: unknown) {
  downloadText(filename, JSON.stringify(data, null, 2), "application/json");
}

export function pickJsonFile(): Promise<unknown> {
  return pickPackFile().then((text) => JSON.parse(text));
}

function pickPackFile(): Promise<string> {
  return new Promise((resolve, reject) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".feisuo,.json,application/json";
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) {
        reject(new Error(t("pack.noFile")));
        return;
      }
      resolve(await file.text());
    };
    input.click();
  });
}

export function buildSessionPack(): SessionPack {
  return {
    version: 1,
    exportedAt: Date.now(),
    sessions: useSessionsStore().snapshot(),
    history: [...useSessionsStore().history],
    sshHosts: useHostsStore().snapshot(),
  };
}

function asSessionList(raw: unknown): SessionSnapshot[] {
  if (Array.isArray(raw)) return raw as SessionSnapshot[];
  if (raw && typeof raw === "object") {
    const obj = raw as { sessions?: SessionSnapshot[] };
    if (Array.isArray(obj.sessions)) return obj.sessions;
  }
  return [];
}

function asHostList(raw: unknown): SshHost[] {
  if (Array.isArray(raw)) {
    const first = raw[0] as { protocol?: string; host?: string } | undefined;
    if (first && !first.protocol && first.host) return raw as SshHost[];
    return [];
  }
  if (!raw || typeof raw !== "object") return [];
  const obj = raw as { sshHosts?: SshHost[]; hosts?: SshHost[] };
  if (Array.isArray(obj.sshHosts)) return obj.sshHosts;
  if (Array.isArray(obj.hosts)) return obj.hosts;
  return [];
}

function asHistory(raw: unknown): SendHistoryItem[] {
  if (!raw || typeof raw !== "object") return [];
  const obj = raw as { history?: SendHistoryItem[] };
  return Array.isArray(obj.history) ? obj.history : [];
}

export async function exportSessions() {
  const pack = buildSessionPack();
  if (!pack.sessions.length && !pack.sshHosts?.length) {
    toast.error(t("pack.nothing"));
    return;
  }
  const body = await encodePack(pack);
  if (!isTauri()) {
    downloadText("feisuo-sessions.feisuo", body);
    return;
  }
  try {
    const path = await pickSavePath("feisuo-sessions.feisuo");
    if (!path) return;
    await writeLocalFile(path, body);
    toast.success(t("pack.exported"));
  } catch (err) {
    toast.error(errorMessage(err));
  }
}

export async function importSessions() {
  let raw: unknown;
  try {
    raw = await decodePackText(await pickPackFile());
  } catch (err) {
    toast.error(err instanceof Error ? err.message : t("pack.importFail"));
    return;
  }
  const sessions = useSessionsStore();
  const n = sessions.importSessions(asSessionList(raw));
  const hosts = asHostList(raw);
  if (hosts.length) useHostsStore().importList(hosts);
  sessions.mergeHistory(asHistory(raw));
  if (!n && !hosts.length) {
    toast.error(t("pack.noSessions"));
    return;
  }
  const ui = useUiStore();
  if (!ui.isChromeView) sessions.activateRail(ui.rail);
  const bits = [];
  if (n) bits.push(t("pack.nSessions", { n }));
  if (hosts.length) bits.push(t("pack.nHosts", { n: hosts.length }));
  toast.success(t("pack.imported", { bits: bits.join(" · ") }));
}
