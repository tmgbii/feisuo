import { defineStore } from "pinia";
import { reactive } from "vue";
import { toast } from "vue-sonner";
import { t } from "@/i18n";
import { errorMessage, invokeSsh, isTauri } from "@/lib/ipc";
import { normalizeFtpConfig } from "@/lib/protocol";
import { useSessionsStore } from "@/stores/sessions";
import type { FtpConfig, SshFileEntry } from "@/types";

interface XferState {
  id: string;
  name: string;
  transferred: number;
  total: number;
  done: boolean;
  error?: string | null;
}

export const useFtpStore = defineStore("ftp", () => {
  const cwd = reactive<Record<string, string>>({});
  const listing = reactive<Record<string, SshFileEntry[]>>({});
  const xfers = reactive<Record<string, XferState[]>>({});
  let bound = false;
  let unlisten: Array<() => void> = [];

  function ftpConfig(id: string): FtpConfig | null {
    const s = useSessionsStore().sessions.find((x) => x.id === id);
    return s?.config.kind === "ftp" ? normalizeFtpConfig(s.config) : null;
  }

  async function connect(id: string) {
    const sessions = useSessionsStore();
    const cfg = ftpConfig(id);
    if (!cfg) return;
    if (!isTauri()) {
      toast.error(t("err.needDesktop"));
      return;
    }
    if (!cfg.host.trim()) {
      toast.error(t("err.missing_host"));
      return;
    }
    sessions.applyStatus(id, "connecting");
    try {
      await invokeSsh("ftp_connect", {
        req: {
          sessionId: id,
          host: cfg.host.trim(),
          port: Number(cfg.port) || 21,
          user: cfg.user.trim() || "anonymous",
          password: cfg.password,
        },
      });
    } catch (err) {
      sessions.applyStatus(id, "error", errorMessage(err));
    }
  }

  function resetFiles(id: string) {
    listing[id] = [];
    delete cwd[id];
    delete xfers[id];
  }

  async function disconnect(id: string) {
    resetFiles(id);
    if (!isTauri()) {
      useSessionsStore().applyStatus(id, "disconnected");
      return;
    }
    try {
      await invokeSsh("ftp_disconnect", { sessionId: id });
    } catch {
      /* already gone */
    }
  }

  async function list(id: string, path?: string) {
    if (!isTauri()) return;
    const target = path ?? cwd[id] ?? "";
    try {
      const rows = await invokeSsh<SshFileEntry[]>("ftp_list", { sessionId: id, path: target });
      const session = useSessionsStore().sessions.find((x) => x.id === id);
      if (session?.status !== "connected") return;
      listing[id] = rows;
      cwd[id] = target || cwd[id] || "/";
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  async function home(id: string) {
    if (!isTauri()) return;
    try {
      const home = await invokeSsh<string>("ftp_home", { sessionId: id });
      const session = useSessionsStore().sessions.find((x) => x.id === id);
      if (session?.status !== "connected") return;
      cwd[id] = home;
      await list(id, home);
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  async function refresh(id: string, path: string) {
    await list(id, path);
  }

  function dropSession(id: string) {
    delete cwd[id];
    delete listing[id];
    delete xfers[id];
  }

  async function bind() {
    if (bound || !isTauri()) return;
    bound = true;
    const { listen } = await import("@tauri-apps/api/event");
    unlisten.push(
      await listen<{ sessionId: string; status: string; error?: string | null }>("ftp:status", (e) => {
        const status = e.payload.status as "connected" | "connecting" | "disconnected" | "error";
        if (!["connected", "connecting", "disconnected", "error"].includes(status)) return;
        const sessions = useSessionsStore();
        const session = sessions.sessions.find((x) => x.id === e.payload.sessionId);
        if (!session) return;
        if (status === "disconnected" && session.status === "connecting") return;
        sessions.applyStatus(e.payload.sessionId, status, e.payload.error);
        if (status === "disconnected" || status === "error") {
          resetFiles(e.payload.sessionId);
        }
      }),
    );
    unlisten.push(
      await listen<XferState & { sessionId: string }>("ftp:xfer", (e) => {
        const list = xfers[e.payload.sessionId] ?? (xfers[e.payload.sessionId] = []);
        const i = list.findIndex((x) => x.id === e.payload.id);
        const next = {
          id: e.payload.id,
          name: e.payload.name,
          transferred: e.payload.transferred,
          total: e.payload.total,
          done: e.payload.done,
          error: e.payload.error,
        };
        if (i >= 0) list[i] = next;
        else list.push(next);
        if (next.done && !next.error) {
          const path = cwd[e.payload.sessionId];
          if (path) void refresh(e.payload.sessionId, path);
        }
      }),
    );
  }

  function unbind() {
    for (const stop of unlisten) stop();
    unlisten = [];
    bound = false;
  }

  return {
    cwd,
    listing,
    xfers,
    connect,
    disconnect,
    list,
    home,
    dropSession,
    bind,
    unbind,
  };
});
