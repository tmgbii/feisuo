import { defineStore } from "pinia";
import { reactive } from "vue";
import { toast } from "vue-sonner";
import { t } from "@/i18n";
import { errorMessage, invokeSsh, isTauri } from "@/lib/ipc";
import { normalizeDbConfig } from "@/lib/protocol";
import { useSessionsStore } from "@/stores/sessions";
import type { DbConfig } from "@/types";

export interface DbQueryResult {
  columns: string[];
  rows: (string | null)[][];
  affected: number;
  elapsedMs: number;
  truncated: boolean;
  kind: "query" | "exec";
}

export interface DbTable {
  schema: string;
  name: string;
}

export interface DbScriptLine {
  index: number;
  total: number;
  preview: string;
  ok: boolean;
  affected: number;
  elapsedMs: number;
  error?: string | null;
  cancelled?: boolean;
}

interface DbViewState {
  result: DbQueryResult | null;
  error: string;
  running: boolean;
  tables: DbTable[];
  catalogs: string[];
  switching: boolean;
  scriptLog: DbScriptLine[];
  scriptTotal: number;
  scripting: boolean;
}

const SCRIPT_LOG_CAP = 300;

function emptyView(): DbViewState {
  return {
    result: null,
    error: "",
    running: false,
    tables: [],
    catalogs: [],
    switching: false,
    scriptLog: [],
    scriptTotal: 0,
    scripting: false,
  };
}

export const useDbStore = defineStore("db", () => {
  const views = reactive<Record<string, DbViewState>>({});
  let bound = false;
  let unlisten: Array<() => void> = [];

  function viewOf(id: string): DbViewState {
    return views[id] ?? (views[id] = emptyView());
  }

  function dbConfig(id: string): DbConfig | null {
    const s = useSessionsStore().sessions.find((x) => x.id === id);
    return s?.config.kind === "db" ? normalizeDbConfig(s.config) : null;
  }

  function resetResult(id: string) {
    const v = viewOf(id);
    v.result = null;
    v.error = "";
    v.running = false;
    v.tables = [];
    v.catalogs = [];
    v.switching = false;
    v.scriptLog = [];
    v.scriptTotal = 0;
    v.scripting = false;
  }

  async function connect(id: string) {
    const sessions = useSessionsStore();
    const cfg = dbConfig(id);
    if (!cfg) return;
    if (!isTauri()) {
      toast.error(t("err.needDesktop"));
      return;
    }
    if (cfg.engine === "sqlite") {
      if (!cfg.file.trim()) {
        toast.error(t("err.missing_file"));
        return;
      }
    } else if (!cfg.host.trim()) {
      toast.error(t("err.missing_host"));
      return;
    }
    sessions.applyStatus(id, "connecting");
    try {
      await invokeSsh("db_connect", {
        req: {
          sessionId: id,
          engine: cfg.engine,
          host: cfg.host.trim(),
          port: Number(cfg.port) || (cfg.engine === "mysql" ? 3306 : 5432),
          database: cfg.database.trim(),
          user: cfg.user.trim(),
          password: cfg.password,
          file: cfg.file.trim(),
        },
      });
    } catch (err) {
      sessions.applyStatus(id, "error", errorMessage(err));
    }
  }

  async function disconnect(id: string) {
    resetResult(id);
    if (!isTauri()) {
      useSessionsStore().applyStatus(id, "disconnected");
      return;
    }
    try {
      await invokeSsh("db_script_cancel", { sessionId: id });
    } catch {
      /* */
    }
    try {
      await invokeSsh("db_disconnect", { sessionId: id });
    } catch {
      /* already gone */
    }
  }

  async function listTables(id: string) {
    if (!isTauri()) return;
    const session = useSessionsStore().sessions.find((x) => x.id === id);
    if (session?.status !== "connected") return;
    try {
      const rows = await invokeSsh<DbTable[]>("db_tables", { sessionId: id });
      const current = useSessionsStore().sessions.find((x) => x.id === id);
      if (current?.status !== "connected") return;
      viewOf(id).tables = rows;
    } catch {
      if (useSessionsStore().sessions.find((x) => x.id === id)?.status === "connected") {
        viewOf(id).tables = [];
      }
    }
  }

  async function listDatabases(id: string) {
    if (!isTauri()) return;
    const cfg = dbConfig(id);
    const session = useSessionsStore().sessions.find((x) => x.id === id);
    if (session?.status !== "connected" || !cfg || cfg.engine === "sqlite") {
      viewOf(id).catalogs = [];
      return;
    }
    try {
      const info = await invokeSsh<{ current: string; names: string[] }>("db_databases", {
        sessionId: id,
      });
      const current = useSessionsStore().sessions.find((x) => x.id === id);
      if (current?.status !== "connected") return;
      const names = info.names.filter(Boolean);
      if (info.current && !names.includes(info.current)) names.unshift(info.current);
      viewOf(id).catalogs = names;
      if (info.current && info.current !== cfg.database) {
        useSessionsStore().updateConfig(id, { database: info.current });
      }
    } catch {
      const still = useSessionsStore().sessions.find((x) => x.id === id);
      if (still?.status === "connected") {
        const fallback = dbConfig(id)?.database.trim();
        viewOf(id).catalogs = fallback ? [fallback] : [];
      }
    }
  }

  async function useDatabase(id: string, name: string) {
    const cfg = dbConfig(id);
    const next = name.trim();
    if (!cfg || cfg.engine === "sqlite" || !next || next === cfg.database.trim()) return;
    const session = useSessionsStore().sessions.find((x) => x.id === id);
    if (session?.status !== "connected") return;
    if (!isTauri()) {
      toast.error(t("err.needDesktop"));
      return;
    }
    const v = viewOf(id);
    if (v.scripting || v.switching) return;
    v.switching = true;
    v.error = "";
    try {
      await invokeSsh("db_use", { sessionId: id, database: next });
      if (useSessionsStore().sessions.find((x) => x.id === id)?.status !== "connected") return;
      useSessionsStore().updateConfig(id, { database: next });
      v.result = null;
      v.scriptLog = [];
      v.scriptTotal = 0;
      await Promise.all([listTables(id), listDatabases(id)]);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      v.switching = false;
    }
  }

  async function query(id: string, sql: string) {
    const v = viewOf(id);
    const session = useSessionsStore().sessions.find((x) => x.id === id);
    const cfg = dbConfig(id);
    v.error = "";
    v.result = null;
    v.scriptLog = [];
    v.scriptTotal = 0;
    if (!session || session.status !== "connected") {
      v.error = t("err.notConnected");
      return;
    }
    const text = sql.trim();
    if (!text) {
      v.error = t("err.sql_empty");
      return;
    }
    if (!isTauri()) {
      v.error = t("err.needDesktop");
      return;
    }
    v.running = true;
    try {
      const result = await invokeSsh<DbQueryResult>("db_query", {
        req: {
          sessionId: id,
          sql: text,
          selectOnly: Boolean(cfg?.selectOnly),
        },
      });
      if (useSessionsStore().sessions.find((x) => x.id === id)?.status !== "connected") {
        resetResult(id);
        return;
      }
      v.result = result;
    } catch (err) {
      v.error = errorMessage(err);
    } finally {
      v.running = false;
    }
  }

  async function runScript(id: string, path: string) {
    const v = viewOf(id);
    const session = useSessionsStore().sessions.find((x) => x.id === id);
    const cfg = dbConfig(id);
    v.error = "";
    v.result = null;
    v.scriptLog = [];
    v.scriptTotal = 0;
    if (!session || session.status !== "connected") {
      v.error = t("err.notConnected");
      return;
    }
    if (!isTauri()) {
      v.error = t("err.needDesktop");
      return;
    }
    v.scripting = true;
    try {
      await invokeSsh("db_script", {
        req: {
          sessionId: id,
          path,
          selectOnly: Boolean(cfg?.selectOnly),
        },
      });
    } catch (err) {
      v.error = errorMessage(err);
      v.scripting = false;
    }
  }

  async function stopScript(id: string) {
    if (!isTauri()) return;
    try {
      await invokeSsh("db_script_cancel", { sessionId: id });
    } catch {
      /* */
    }
  }

  function dropSession(id: string) {
    delete views[id];
  }

  async function bind() {
    if (bound || !isTauri()) return;
    bound = true;
    const { listen } = await import("@tauri-apps/api/event");
    unlisten.push(
      await listen<{ sessionId: string; status: string; error?: string | null }>("db:status", (e) => {
        const status = e.payload.status as "connected" | "connecting" | "disconnected" | "error";
        if (!["connected", "connecting", "disconnected", "error"].includes(status)) return;
        const sessions = useSessionsStore();
        const session = sessions.sessions.find((x) => x.id === e.payload.sessionId);
        if (!session) return;
        if (status === "disconnected" && session.status === "connecting") return;
        sessions.applyStatus(e.payload.sessionId, status, e.payload.error);
        if (status === "connected") {
          void listTables(e.payload.sessionId);
          void listDatabases(e.payload.sessionId);
        }
        if (status === "disconnected" || status === "error") {
          resetResult(e.payload.sessionId);
        }
      }),
    );
    unlisten.push(
      await listen<{
        sessionId: string;
        index: number;
        total: number;
        preview: string;
        ok: boolean;
        affected: number;
        elapsedMs: number;
        error?: string | null;
        done: boolean;
        cancelled: boolean;
      }>("db:script", (e) => {
        const v = viewOf(e.payload.sessionId);
        v.scriptTotal = e.payload.total;
        if (e.payload.cancelled) {
          v.scripting = false;
          void listTables(e.payload.sessionId);
          return;
        }
        if (e.payload.index > 0) {
          v.scriptLog.push({
            index: e.payload.index,
            total: e.payload.total,
            preview: e.payload.preview,
            ok: e.payload.ok,
            affected: e.payload.affected,
            elapsedMs: e.payload.elapsedMs,
            error: e.payload.error,
          });
          if (v.scriptLog.length > SCRIPT_LOG_CAP) {
            v.scriptLog.splice(0, v.scriptLog.length - SCRIPT_LOG_CAP);
          }
          if (!e.payload.ok) {
            v.error = e.payload.error || t("err.failed");
          }
        }
        if (e.payload.done) {
          v.scripting = false;
          void listTables(e.payload.sessionId);
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
    views,
    viewOf,
    connect,
    disconnect,
    listTables,
    listDatabases,
    useDatabase,
    query,
    runScript,
    stopScript,
    dropSession,
    bind,
    unbind,
  };
});
