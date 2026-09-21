import { defineStore } from "pinia";
import { reactive, ref } from "vue";
import { toast } from "vue-sonner";
import { t } from "@/i18n";
import { errorMessage, invokeSsh, isTauri } from "@/lib/ipc";
import { normalizeSshConfig } from "@/lib/protocol";
import {
  dirSpecFromLine,
  resetCwdTrack,
  resolveRemotePath,
  samePosix,
  takeOscPaths,
  type DirSpec,
} from "@/lib/ssh-cwd";
import { disposeTerminal, pasteLineCount, pasteTerminal, terminalCommandLine, terminalSize, writeTerminal } from "@/lib/ssh-term";
import { useHostsStore } from "@/stores/hosts";
import { useSessionsStore } from "@/stores/sessions";
import { useUiStore } from "@/stores/ui";
import type { SshConfig, SshFileEntry, SshProbeInfo, SshTunnelRule } from "@/types";

interface HostKeyPrompt {
  sessionId: string;
  host: string;
  fingerprint: string;
  alg: string;
  previous: string | null;
}

interface XferState {
  id: string;
  name: string;
  transferred: number;
  total: number;
  done: boolean;
  error?: string | null;
}

export const useSshStore = defineStore("ssh", () => {
  const filesOpen = reactive<Record<string, boolean>>({});
  const jumpOpen = reactive<Record<string, boolean>>({});
  const tunnelsOpen = reactive<Record<string, boolean>>({});
  const cwd = reactive<Record<string, string>>({});
  const homes: Record<string, string> = {};
  const shellCwd: Record<string, string> = {};
  const prevCwd: Record<string, string> = {};
  const followAt: Record<string, number> = {};
  const followSpec: Record<string, DirSpec> = {};
  const listing = reactive<Record<string, SshFileEntry[]>>({});
  const probe = reactive<Record<string, SshProbeInfo>>({});
  const xfers = reactive<Record<string, XferState[]>>({});
  const tunnelStatus = reactive<Record<string, Record<string, string>>>({});
  const wantedTunnels = reactive<Record<string, string[]>>({});
  const hostKey = ref<HostKeyPrompt | null>(null);
  const pastePrompt = ref<{ sessionId: string; text: string; lines: number } | null>(null);
  const userClosed = new Set<string>();
  let bound = false;
  let unlisten: Array<() => void> = [];
  let reconnecting = new Set<string>();

  function sshConfig(id: string): SshConfig | null {
    const s = useSessionsStore().sessions.find((x) => x.id === id);
    return s?.config.kind === "ssh" ? normalizeSshConfig(s.config) : null;
  }

  async function connect(id: string, cols?: number, rows?: number) {
    const sessions = useSessionsStore();
    const cfg = sshConfig(id);
    if (!cfg) return;
    if (!isTauri()) {
      toast.error(t("err.needDesktop"));
      return;
    }
    if (!cfg.host.trim()) {
      toast.error(t("err.missing_host"));
      return;
    }
    if (!cfg.user.trim()) {
      toast.error(t("err.missing_user"));
      return;
    }
    if (cfg.auth.method === "key" && !cfg.auth.keyPath.trim()) {
      toast.error(t("err.missing_key"));
      return;
    }
    if (cfg.jumpEnabled) {
      if (!cfg.jump.host.trim()) {
        toast.error(t("err.missing_jump_host"));
        return;
      }
      if (!cfg.jump.user.trim()) {
        toast.error(t("err.missing_jump_user"));
        return;
      }
      if (cfg.jump.auth.method === "key" && !cfg.jump.auth.keyPath.trim()) {
        toast.error(t("err.missing_jump_key"));
        return;
      }
    }
    userClosed.delete(id);
    sessions.applyStatus(id, "connecting");
    const size = terminalSize(id);
    try {
      await invokeSsh("ssh_connect", {
        req: {
          sessionId: id,
          host: cfg.host.trim(),
          port: Number(cfg.port) || 22,
          user: cfg.user.trim(),
          auth: cfg.auth,
          cols: cols ?? size.cols,
          rows: rows ?? size.rows,
          jump: cfg.jumpEnabled && cfg.jump.host.trim()
            ? { host: cfg.jump.host.trim(), port: Number(cfg.jump.port) || 22, user: cfg.jump.user.trim(), auth: cfg.jump.auth }
            : null,
        },
      });
    } catch (err) {
      sessions.applyStatus(id, "error", errorMessage(err));
    }
  }

  function resetFiles(id: string) {
    listing[id] = [];
    delete cwd[id];
    delete homes[id];
    delete shellCwd[id];
    delete prevCwd[id];
    delete followSpec[id];
    const t = followAt[id];
    if (t) window.clearTimeout(t);
    delete followAt[id];
    resetCwdTrack(id);
    delete xfers[id];
  }

  async function disconnect(id: string, fromUser = true) {
    if (fromUser) userClosed.add(id);
    resetFiles(id);
    if (!isTauri()) {
      useSessionsStore().applyStatus(id, "disconnected");
      return;
    }
    try {
      await invokeSsh("ssh_disconnect", { sessionId: id });
    } catch {
      /* already gone */
    }
  }

  function requestPaste(id: string, text: string) {
    if (!text) return;
    const lines = pasteLineCount(text);
    if (lines > 1) pastePrompt.value = { sessionId: id, text, lines };
    else pasteTerminal(id, text);
  }

  function acceptPaste() {
    const p = pastePrompt.value;
    pastePrompt.value = null;
    if (p) pasteTerminal(p.sessionId, p.text);
  }

  function cancelPaste() {
    pastePrompt.value = null;
  }

  function posixQuote(path: string) {
    if (/^[\w./:@%+=,-]+$/.test(path)) return path;
    return `'${path.replace(/'/g, `'\\''`)}'`;
  }

  function cdTerminal(id: string, remotePath: string, isDir: boolean) {
    const session = useSessionsStore().sessions.find((x) => x.id === id);
    if (!session || session.status !== "connected") {
      toast.error(t("err.not_connected"));
      return;
    }
    const dir = isDir ? remotePath : parentPath(remotePath);
    void write(id, `cd ${posixQuote(dir)}\r`);
  }

  function parentPath(p: string) {
    if (p === "/" || !p) return "/";
    const trimmed = p.replace(/\/+$/, "");
    const i = trimmed.lastIndexOf("/");
    return i <= 0 ? "/" : trimmed.slice(0, i);
  }

  async function write(id: string, data: string | Uint8Array) {
    if (typeof data === "string") noteOutgoing(id, data);
    if (!isTauri()) return;
    const bytes = typeof data === "string" ? [...new TextEncoder().encode(data)] : [...data];
    try {
      await invokeSsh("ssh_write", { sessionId: id, data: bytes });
    } catch {
      /* ignore */
    }
  }

  function noteOutgoing(id: string, data: string) {
    if (data === "\r" || data === "\n" || data === "\r\n") {
      const spec = dirSpecFromLine(terminalCommandLine(id));
      if (spec != null) queueFollow(id, spec);
      return;
    }
    if (!data.includes("\r") && !data.includes("\n")) return;
    for (const line of data.split(/\r\n|\r|\n/)) {
      if (!line) continue;
      const spec = dirSpecFromLine(line);
      if (spec != null) queueFollow(id, spec);
    }
  }

  function queueFollow(id: string, spec: DirSpec) {
    followSpec[id] = spec;
    const prev = followAt[id];
    if (prev) window.clearTimeout(prev);
    followAt[id] = window.setTimeout(() => {
      delete followAt[id];
      const next = followSpec[id];
      delete followSpec[id];
      if (next != null) void applyFollow(id, next);
    }, 80);
  }

  async function applyFollow(id: string, spec: DirSpec) {
    const session = useSessionsStore().sessions.find((x) => x.id === id);
    if (!session || session.status !== "connected" || !isTauri()) return;
    let home = homes[id];
    if (!home) {
      try {
        home = homes[id] = await invokeSsh<string>("ssh_home", { sessionId: id });
      } catch {
        home = "/";
      }
    }
    const base = shellCwd[id] ?? cwd[id] ?? home;
    const next = resolveRemotePath(base, home, prevCwd[id] ?? null, spec);
    if (!next) return;
    if (samePosix(next, cwd[id] ?? "")) {
      shellCwd[id] = next;
      return;
    }
    try {
      const rows = await invokeSsh<SshFileEntry[]>("ssh_sftp_list", { sessionId: id, path: next });
      const live = useSessionsStore().sessions.find((x) => x.id === id);
      if (live?.status !== "connected") return;
      prevCwd[id] = base;
      shellCwd[id] = next;
      cwd[id] = next;
      if (filesOpen[id]) listing[id] = rows;
    } catch {
      /* cd failed or path gone */
    }
  }

  async function rememberHome(id: string) {
    if (!isTauri() || homes[id]) return;
    try {
      const home = await invokeSsh<string>("ssh_home", { sessionId: id });
      const session = useSessionsStore().sessions.find((x) => x.id === id);
      if (session?.status !== "connected") return;
      homes[id] = home;
      if (!shellCwd[id]) shellCwd[id] = home;
      if (!cwd[id]) cwd[id] = home;
    } catch {
      /* skip */
    }
  }

  async function resize(id: string, cols: number, rows: number) {
    if (!isTauri()) return;
    try {
      await invokeSsh("ssh_resize", { sessionId: id, cols, rows });
    } catch {
      /* ignore */
    }
  }

  async function answerHostKey(accept: boolean) {
    const prompt = hostKey.value;
    if (!prompt) return;
    hostKey.value = null;
    try {
      await invokeSsh("ssh_answer_hostkey", { sessionId: prompt.sessionId, accept });
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  async function list(id: string, path?: string) {
    if (!isTauri()) return;
    const target = path ?? cwd[id] ?? "";
    try {
      const rows = await invokeSsh<SshFileEntry[]>("ssh_sftp_list", { sessionId: id, path: target });
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
      const home = await invokeSsh<string>("ssh_home", { sessionId: id });
      const session = useSessionsStore().sessions.find((x) => x.id === id);
      if (session?.status !== "connected") return;
      cwd[id] = home;
      await list(id, home);
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  async function startTunnels(id: string) {
    const cfg = sshConfig(id);
    if (!cfg || !isTauri()) return;
    const wanted = wantedTunnels[id] ?? [];
    for (const rule of cfg.tunnels) {
      if (!wanted.includes(rule.id)) continue;
      await startTunnel(id, rule);
    }
  }

  async function startTunnel(id: string, rule: SshTunnelRule) {
    if (!isTauri()) return;
    const cur = wantedTunnels[id] ?? [];
    if (!cur.includes(rule.id)) wantedTunnels[id] = [...cur, rule.id];
    try {
      await invokeSsh("ssh_tunnel_start", {
        req: {
          sessionId: id,
          id: rule.id,
          kind: rule.kind,
          bindHost: rule.bindHost || "127.0.0.1",
          bindPort: Number(rule.bindPort) || 0,
          destHost: rule.destHost,
          destPort: Number(rule.destPort) || 0,
        },
      });
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  async function stopTunnel(id: string, ruleId: string) {
    if (!isTauri()) return;
    wantedTunnels[id] = (wantedTunnels[id] ?? []).filter((x) => x !== ruleId);
    try {
      await invokeSsh("ssh_tunnel_stop", { sessionId: id, id: ruleId });
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  async function probeNow(id: string) {
    if (!isTauri()) return;
    try {
      await invokeSsh("ssh_probe", { sessionId: id });
    } catch {
      /* skip */
    }
  }

  function dropSession(id: string) {
    disposeTerminal(id);
    delete filesOpen[id];
    delete jumpOpen[id];
    delete tunnelsOpen[id];
    delete cwd[id];
    delete homes[id];
    delete shellCwd[id];
    delete prevCwd[id];
    delete followSpec[id];
    const t = followAt[id];
    if (t) window.clearTimeout(t);
    delete followAt[id];
    resetCwdTrack(id);
    delete listing[id];
    delete probe[id];
    delete xfers[id];
    delete tunnelStatus[id];
    delete wantedTunnels[id];
  }

  async function bind() {
    if (bound || !isTauri()) return;
    bound = true;
    const { listen } = await import("@tauri-apps/api/event");
    unlisten.push(
      await listen<{ sessionId: string; data: number[] }>("ssh:rx", (e) => {
        const id = e.payload.sessionId;
        const data = e.payload.data ?? [];
        writeTerminal(id, new Uint8Array(data));
        const s = useSessionsStore().sessions.find((x) => x.id === id);
        if (s) {
          s.rxBytes += data.length;
          s.rxFrames += 1;
        }
        for (const path of takeOscPaths(id, data)) queueFollow(id, path);
      }),
    );
    unlisten.push(
      await listen<{ sessionId: string; status: string; error?: string | null }>("ssh:status", (e) => {
        const status = e.payload.status as "connected" | "connecting" | "disconnected" | "error";
        if (!["connected", "connecting", "disconnected", "error"].includes(status)) return;
        const sessions = useSessionsStore();
        const session = sessions.sessions.find((x) => x.id === e.payload.sessionId);
        if (!session) return;
        if (status === "disconnected" && session.status === "connecting") return;
        sessions.applyStatus(e.payload.sessionId, status, e.payload.error);
        if (status === "connected") {
          writeTerminal(e.payload.sessionId, "");
          const cfg = sshConfig(e.payload.sessionId);
          if (cfg?.host.trim()) useHostsStore().fromSession(session.name, cfg);
          void startTunnels(e.payload.sessionId);
          void probeNow(e.payload.sessionId);
          void rememberHome(e.payload.sessionId);
        }
        if (status === "disconnected" || status === "error") {
          resetFiles(e.payload.sessionId);
          delete probe[e.payload.sessionId];
          if (status === "disconnected" || status === "error") {
            writeTerminal(e.payload.sessionId, `\r\n\x1b[31m${t("ssh.disconnected")}\x1b[0m\r\n`);
          }
          const ui = useUiStore();
          if (
            ui.settings.sshAutoReconnect &&
            !userClosed.has(e.payload.sessionId) &&
            !reconnecting.has(e.payload.sessionId)
          ) {
            reconnecting.add(e.payload.sessionId);
            window.setTimeout(() => {
              reconnecting.delete(e.payload.sessionId);
              if (!userClosed.has(e.payload.sessionId)) void connect(e.payload.sessionId);
            }, ui.settings.sshReconnectMs);
          }
        }
      }),
    );
    unlisten.push(
      await listen<HostKeyPrompt>("ssh:hostkey", (e) => {
        hostKey.value = e.payload;
      }),
    );
    unlisten.push(
      await listen<XferState & { sessionId: string }>("ssh:xfer", (e) => {
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
          if (path) void listDirKeep(e.payload.sessionId, path);
        }
      }),
    );
    unlisten.push(
      await listen<{ sessionId: string; id: string; status: string; error?: string | null }>("ssh:tunnel", (e) => {
        const map = tunnelStatus[e.payload.sessionId] ?? (tunnelStatus[e.payload.sessionId] = {});
        map[e.payload.id] = e.payload.status;
        if (e.payload.error) toast.error(e.payload.error);
      }),
    );
    unlisten.push(
      await listen<SshProbeInfo & { sessionId: string }>("ssh:probe", (e) => {
        probe[e.payload.sessionId] = {
          os: e.payload.os,
          cores: e.payload.cores,
          mem: e.payload.mem,
          disk: e.payload.disk,
          hostname: e.payload.hostname,
          distro: e.payload.distro,
          osId: e.payload.osId,
          ip: e.payload.ip,
          load: e.payload.load,
          diskTotal: e.payload.diskTotal,
          rttMs: e.payload.rttMs,
        };
      }),
    );
  }

  async function listDirKeep(id: string, path: string) {
    await list(id, path);
  }

  function unbind() {
    for (const stop of unlisten) stop();
    unlisten = [];
    bound = false;
  }

  return {
    filesOpen,
    jumpOpen,
    tunnelsOpen,
    cwd,
    listing,
    probe,
    xfers,
    tunnelStatus,
    hostKey,
    pastePrompt,
    requestPaste,
    acceptPaste,
    cancelPaste,
    cdTerminal,
    connect,
    disconnect,
    write,
    resize,
    answerHostKey,
    list,
    home,
    startTunnel,
    stopTunnel,
    dropSession,
    bind,
    unbind,
  };
});
