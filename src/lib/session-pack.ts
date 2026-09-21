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

export function downloadJson(filename: string, data: unknown) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
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

export function pickJsonFile(): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "application/json,.json";
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) {
        reject(new Error(t("pack.noFile")));
        return;
      }
      try {
        resolve(JSON.parse(await file.text()));
      } catch {
        reject(new Error(t("pack.badJson")));
      }
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
  if (!isTauri()) {
    downloadJson("feisuo-sessions.json", pack);
    return;
  }
  try {
    const path = await pickSavePath("feisuo-sessions.json");
    if (!path) return;
    await writeLocalFile(path, JSON.stringify(pack, null, 2));
    toast.success(t("pack.exported"));
  } catch (err) {
    toast.error(errorMessage(err));
  }
}

export async function importSessions() {
  let raw: unknown;
  try {
    raw = await pickJsonFile();
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
