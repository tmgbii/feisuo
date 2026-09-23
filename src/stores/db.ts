import { defineStore } from "pinia";
import { reactive } from "vue";
import { toast } from "vue-sonner";
import { t } from "@/i18n";
import { errorMessage, invokeSsh, isTauri } from "@/lib/ipc";
import { dbDefaultPort, normalizeDbConfig } from "@/lib/protocol";
import { useSessionsStore } from "@/stores/sessions";
import type { DbConfig } from "@/types";

export interface DbColumn {
  name: string;
  type: string;
  comment: string;
  pk: boolean;
}

export interface DbQueryResult {
  columns: DbColumn[];
  rows: (string | null)[][];
  affected: number;
  elapsedMs: number;
  truncated: boolean;
  kind: "query" | "exec";
  offset: number;
  hasMore: boolean;
  paged: boolean;
}

export const DB_PAGE_SIZES = [100, 200, 500, 1000];

function asColumns(raw: unknown): DbColumn[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((item) => {
    if (typeof item === "string") {
      return { name: item, type: "", comment: "", pk: false };
    }
    const col = item as { name?: string; type?: string; comment?: string; pk?: boolean };
    return {
      name: col.name ?? "",
      type: col.type ?? "",
      comment: col.comment ?? "",
      pk: Boolean(col.pk),
    };
  });
}

export interface DbTable {
  schema: string;
  name: string;
  comment: string;
}

export interface DbInspectCol {
  name: string;
  type: string;
  nullable: boolean;
  default: string;
  comment: string;
  pk: boolean;
}

export interface DbInspectRow {
  name: string;
  detail: string;
}

export interface DbTableInspect {
  schema: string;
  name: string;
  comment: string;
  estimate: string;
  size: string;
  columns: DbInspectCol[];
  indexes: DbInspectRow[];
  foreignKeys: DbInspectRow[];
  checks: DbInspectRow[];
  triggers: DbInspectRow[];
  ddl: string;
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
  inspect: DbTableInspect | null;
  inspecting: boolean;
  exporting: boolean;
  page: number;
  pageSize: number;
  total: number | null;
  querySql: string;
  countGen: number;
}

const SCRIPT_LOG_CAP = 300;
let pageSizePref = 200;

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
    inspect: null,
    inspecting: false,
    exporting: false,
    page: 1,
    pageSize: pageSizePref,
    total: null,
    querySql: "",
    countGen: 0,
  };
}

function clearGrid(v: DbViewState) {
  v.result = null;
  v.page = 1;
  v.total = null;
  v.querySql = "";
  v.countGen += 1;
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
    clearGrid(v);
    v.error = "";
    v.running = false;
    v.tables = [];
    v.catalogs = [];
    v.switching = false;
    v.scriptLog = [];
    v.scriptTotal = 0;
    v.scripting = false;
    v.inspect = null;
    v.inspecting = false;
    v.exporting = false;
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
          port: Number(cfg.port) || dbDefaultPort(cfg.engine),
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
      clearGrid(v);
      v.scriptLog = [];
      v.scriptTotal = 0;
      await Promise.all([listTables(id), listDatabases(id)]);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      v.switching = false;
    }
  }

  function normalizeResult(result: DbQueryResult): DbQueryResult {
    return {
      ...result,
      columns: asColumns(result.columns),
      offset: result.offset ?? 0,
      hasMore: Boolean(result.hasMore),
      paged: Boolean(result.paged),
    };
  }

  async function loadTotal(id: string, sql: string, gen: number) {
    const v = viewOf(id);
    try {
      const n = await invokeSsh<number>("db_count", { sessionId: id, sql });
      if (v.countGen === gen && v.querySql === sql) v.total = n;
    } catch {
      /* next page still works */
    }
  }

  async function query(id: string, sql: string, page = 1) {
    const v = viewOf(id);
    const session = useSessionsStore().sessions.find((x) => x.id === id);
    const cfg = dbConfig(id);
    const text = sql.trim();
    const nextPage = Math.max(1, page);
    v.error = "";
    if (nextPage === 1) {
      v.scriptLog = [];
      v.scriptTotal = 0;
    }
    if (!session || session.status !== "connected") {
      v.error = t("err.notConnected");
      return;
    }
    if (!text) {
      v.error = t("err.sql_empty");
      return;
    }
    if (!isTauri()) {
      v.error = t("err.needDesktop");
      return;
    }
    if (v.running) return;
    v.running = true;
    if (nextPage === 1) {
      v.countGen += 1;
      v.querySql = text;
      v.total = null;
      v.page = 1;
      v.result = null;
    }
    const offset = Math.min((nextPage - 1) * v.pageSize, 0xffffffff);
    try {
      const result = normalizeResult(
        await invokeSsh<DbQueryResult>("db_query", {
          req: {
            sessionId: id,
            sql: text,
            selectOnly: Boolean(cfg?.selectOnly),
            limit: v.pageSize,
            offset,
          },
        }),
      );
      if (useSessionsStore().sessions.find((x) => x.id === id)?.status !== "connected") {
        resetResult(id);
        return;
      }
      if (nextPage > 1 && result.paged && result.rows.length === 0) return;
      v.result = result;
      v.page = nextPage;
      if (!result.paged) v.total = result.rows.length;
      else if (nextPage === 1) void loadTotal(id, text, v.countGen);
    } catch (err) {
      if (nextPage === 1) v.result = null;
      v.error = errorMessage(err);
    } finally {
      v.running = false;
    }
  }

  function setPage(id: string, page: number) {
    const v = viewOf(id);
    if (v.running || v.scripting || !v.result || v.result.kind !== "query") return;
    const next = Math.max(1, Math.floor(page));
    if (next === v.page) return;
    if (v.result.paged) {
      if (!v.querySql) return;
      void query(id, v.querySql, next);
      return;
    }
    const max = Math.max(1, Math.ceil(v.result.rows.length / v.pageSize));
    v.page = Math.min(next, max);
  }

  function setPageSize(id: string, size: number) {
    if (!DB_PAGE_SIZES.includes(size)) return;
    const v = viewOf(id);
    if (v.running || v.scripting || v.pageSize === size) return;
    pageSizePref = size;
    v.pageSize = size;
    if (!v.result || v.result.kind !== "query") return;
    if (v.result.paged && v.querySql) {
      void query(id, v.querySql, 1);
      return;
    }
    v.page = 1;
  }

  async function runScript(id: string, path: string) {
    const v = viewOf(id);
    const session = useSessionsStore().sessions.find((x) => x.id === id);
    const cfg = dbConfig(id);
    v.error = "";
    clearGrid(v);
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

  async function exportSql(id: string, schema: string, name: string, path: string) {
    const v = viewOf(id);
    const session = useSessionsStore().sessions.find((x) => x.id === id);
    if (!session || session.status !== "connected") {
      toast.error(t("err.notConnected"));
      return;
    }
    if (!isTauri()) {
      toast.error(t("err.needDesktop"));
      return;
    }
    if (v.exporting || v.scripting) return;
    v.exporting = true;
    v.error = "";
    try {
      await invokeSsh("db_export", {
        req: { sessionId: id, path, schema, name },
      });
    } catch (err) {
      v.error = errorMessage(err);
    } finally {
      v.exporting = false;
    }
  }

  async function inspect(id: string, schema: string, name: string): Promise<boolean> {
    const v = viewOf(id);
    const session = useSessionsStore().sessions.find((x) => x.id === id);
    if (!session || session.status !== "connected") {
      v.inspect = null;
      return false;
    }
    if (!isTauri()) {
      toast.error(t("err.needDesktop"));
      return false;
    }
    v.inspecting = true;
    try {
      const info = await invokeSsh<DbTableInspect>("db_inspect", {
        req: { sessionId: id, schema, name },
      });
      if (useSessionsStore().sessions.find((x) => x.id === id)?.status !== "connected") {
        v.inspect = null;
        return false;
      }
      v.inspect = info;
      return true;
    } catch (err) {
      v.inspect = null;
      toast.error(errorMessage(err));
      return false;
    } finally {
      v.inspecting = false;
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
    setPage,
    setPageSize,
    inspect,
    exportSql,
    runScript,
    stopScript,
    dropSession,
    bind,
    unbind,
  };
});
