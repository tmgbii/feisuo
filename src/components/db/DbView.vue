<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref } from "vue";
import type { DbConfig, Session } from "@/types";
import { t } from "@/i18n";
import {
  errorMessage,
  invokeSsh,
  isTauri,
  pickLocalFiles,
  pickSavePath,
  writeLocalFile,
} from "@/lib/ipc";
import {
  generateTableSql,
  tableSqlMenu,
  tableLabel,
  tableSqlAvailable,
  type TableSqlId,
} from "@/lib/table-sql";
import { useSessionsStore } from "@/stores/sessions";
import { useDbStore } from "@/stores/db";
import DbBar from "@/components/db/DbBar.vue";
import SqlEditor from "@/components/db/SqlEditor.vue";
import { Button } from "@/components/ui/button";

const EDITOR_MAX = 2 * 1024 * 1024;
const SQL_FILTER = [{ name: "SQL", extensions: ["sql"] }];

const props = defineProps<{ session: Session }>();
const sessions = useSessionsStore();
const db = useDbStore();
const editor = ref<{ runSql: () => string } | null>(null);

const cfg = computed(() => props.session.config as DbConfig);
const view = computed(() => db.viewOf(props.session.id));
const connected = computed(() => props.session.status === "connected");
const busy = computed(() => view.value.running || view.value.scripting || view.value.switching);

function patchSql(sql: string) {
  sessions.updateConfig(props.session.id, { sql });
}

const menu = ref<{ schema: string; name: string; x: number; y: number } | null>(null);
const menuEl = ref<HTMLElement | null>(null);

const menuItems = computed(() =>
  tableSqlMenu().filter((item) => tableSqlAvailable(cfg.value.engine, item.id)),
);

function fillTable(schema: string, name: string, id: TableSqlId = "preview") {
  const sql = generateTableSql(cfg.value.engine, schema, name, id);
  if (sql) patchSql(sql);
  menu.value = null;
}

function onTableMenu(e: MouseEvent, schema: string, name: string) {
  e.preventDefault();
  e.stopPropagation();
  menu.value = { schema, name, x: e.clientX, y: e.clientY };
  void nextTick(() => {
    const el = menuEl.value;
    if (!el || !menu.value) return;
    const pad = 8;
    menu.value = {
      ...menu.value,
      x: Math.min(e.clientX, window.innerWidth - el.offsetWidth - pad),
      y: Math.min(e.clientY, window.innerHeight - el.offsetHeight - pad),
    };
  });
}

function closeMenu() {
  menu.value = null;
}

function onWindowClick(e: MouseEvent) {
  if (menuEl.value?.contains(e.target as Node)) return;
  closeMenu();
}

function onKey(e: KeyboardEvent) {
  if (e.key === "Escape") closeMenu();
}

onMounted(() => {
  window.addEventListener("click", onWindowClick);
  window.addEventListener("keydown", onKey);
});
onUnmounted(() => {
  window.removeEventListener("click", onWindowClick);
  window.removeEventListener("keydown", onKey);
});

function run(sql?: string) {
  void db.query(props.session.id, sql ?? editor.value?.runSql() ?? cfg.value.sql);
}

async function pickSql(): Promise<string | null> {
  const [path] = await pickLocalFiles({ title: "SQL", filters: SQL_FILTER });
  return path ?? null;
}

async function openSql() {
  const path = await pickSql();
  if (!path) return;
  if (!isTauri()) {
    view.value.error = t("err.needDesktop");
    return;
  }
  try {
    const size = await invokeSsh<number>("ssh_local_size", { path });
    if (size > EDITOR_MAX) {
      view.value.error = t("db.tooBig");
      return;
    }
    const text = await invokeSsh<string>("ssh_read_local", { path });
    patchSql(text);
  } catch (err) {
    view.value.error = errorMessage(err);
  }
}

async function runScript() {
  const path = await pickSql();
  if (!path) return;
  void db.runScript(props.session.id, path);
}

function csvEscape(s: string): string {
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function toCsv(): string {
  const result = view.value.result;
  if (!result?.columns.length) return "";
  const lines = [result.columns.map(csvEscape).join(",")];
  for (const row of result.rows) {
    lines.push(row.map((c) => csvEscape(c ?? "")).join(","));
  }
  return `${lines.join("\r\n")}\r\n`;
}

async function exportCsv() {
  const body = toCsv();
  if (!body) return;
  const name = `${props.session.name}.csv`;
  if (!isTauri()) {
    const blob = new Blob([body], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    URL.revokeObjectURL(url);
    return;
  }
  const path = await pickSavePath(name);
  if (!path) return;
  try {
    await writeLocalFile(path, body);
  } catch (err) {
    view.value.error = errorMessage(err);
  }
}

const stats = computed(() => {
  const v = view.value;
  if (v.scripting || v.scriptLog.length) {
    const last = v.scriptLog[v.scriptLog.length - 1];
    const n = last?.index ?? 0;
    const total = v.scriptTotal || last?.total || 0;
    if (v.scripting) return `${n}/${total}`;
    if (last && !last.ok) return t("db.failN", { n, total });
    return `${n}/${total}`;
  }
  if (v.error) return v.error;
  const r = v.result;
  if (!r) return "—";
  if (r.kind === "exec") return t("db.affected", { n: r.affected, ms: r.elapsedMs });
  const extra = r.truncated ? t("db.truncated") : "";
  return `${t("db.rows", { n: r.rows.length, ms: r.elapsedMs })}${extra}`;
});
</script>

<template>
  <div class="flex h-full min-h-0 flex-col">
    <DbBar :session="session" />
    <div class="flex min-h-0 flex-1">
      <aside
        v-if="connected"
        class="flex w-48 shrink-0 flex-col border-r border-border bg-bg-1/30"
      >
        <div class="flex h-8 items-center justify-between px-2 text-[11px] text-muted-foreground">
          <span>{{ t("db.tables", { n: view.tables.length }) }}</span>
          <Button
            size="xs"
            variant="ghost"
            class="h-5 px-1.5 text-[11px]"
            :disabled="busy"
            @click="db.listTables(session.id)"
          >
            {{ t("common.refresh") }}
          </Button>
        </div>
        <div data-db-tables class="min-h-0 flex-1 overflow-auto">
          <button
            v-for="tbl in view.tables"
            :key="`${tbl.schema}.${tbl.name}`"
            type="button"
            class="block w-full truncate px-2 py-1 text-left font-mono text-[12px] text-foreground/90 hover:bg-foreground/5"
            :title="tableLabel(tbl.schema, tbl.name)"
            @click="fillTable(tbl.schema, tbl.name)"
            @contextmenu="onTableMenu($event, tbl.schema, tbl.name)"
          >
            {{ tableLabel(tbl.schema, tbl.name) }}
          </button>
          <div
            v-if="view.tables.length === 0"
            class="px-2 py-4 text-center text-[11px] text-muted-foreground"
          >
            —
          </div>
        </div>
      </aside>
      <div class="flex min-w-0 flex-1 flex-col">
        <div class="flex min-h-[140px] flex-[2] flex-col border-b border-border">
          <SqlEditor
            :key="session.id"
            ref="editor"
            :model-value="cfg.sql"
            :dialect="cfg.engine"
            @update:model-value="patchSql"
            @run="run"
          />
        </div>
        <div class="flex h-8 shrink-0 items-center gap-2 border-b border-border px-3">
          <Button size="sm" :disabled="!connected || busy" @click="run()">
            {{ view.running ? t("db.running") : t("db.run") }}
          </Button>
          <kbd class="font-mono text-[10px] text-muted-foreground">Ctrl+Enter</kbd>
          <Button size="sm" variant="outline" :disabled="!connected || busy" @click="runScript">
            {{ view.scripting ? t("db.scripting") : t("db.script") }}
          </Button>
          <Button
            v-if="view.scripting"
            size="sm"
            variant="outline"
            @click="db.stopScript(session.id)"
          >
            {{ t("db.stop") }}
          </Button>
          <Button size="sm" variant="outline" :disabled="busy" @click="openSql">{{ t("common.open") }}</Button>
          <Button
            size="sm"
            variant="outline"
            :disabled="!view.result?.columns.length"
            @click="exportCsv"
          >
            CSV
          </Button>
          <span
            class="min-w-0 truncate text-[11px]"
            :class="view.error && !view.scripting ? 'text-err' : 'text-muted-foreground'"
          >
            {{ stats }}
          </span>
        </div>
        <div class="min-h-0 flex-[3] overflow-auto">
          <div
            v-if="view.scriptLog.length"
            class="space-y-0.5 px-3 py-2 font-mono text-[12px]"
          >
            <div
              v-for="line in view.scriptLog"
              :key="line.index"
              class="flex gap-2"
              :class="line.ok ? 'text-muted-foreground' : 'text-err'"
            >
              <span class="w-10 shrink-0 tabular-nums">{{ line.index }}</span>
              <span class="w-16 shrink-0 tabular-nums">
                {{ line.ok ? `${line.elapsedMs}ms` : t("common.failed") }}
              </span>
              <span v-if="line.ok && line.affected" class="w-16 shrink-0">{{ t("db.nRows", { n: line.affected }) }}</span>
              <span class="min-w-0 truncate" :title="line.error || line.preview">
                {{ line.error || line.preview }}
              </span>
            </div>
          </div>
          <div
            v-else-if="view.error"
            class="px-3 py-2 font-mono text-[12px] text-err"
          >
            {{ view.error }}
          </div>
          <div
            v-else-if="view.result?.kind === 'exec'"
            class="px-3 py-2 text-[12px] text-muted-foreground"
          >
            {{ stats }}
          </div>
          <table
            v-else-if="view.result?.columns.length"
            class="w-max min-w-full border-collapse text-[12px]"
          >
            <thead class="sticky top-0 bg-bg-1">
              <tr>
                <th
                  v-for="col in view.result.columns"
                  :key="col"
                  class="border-b border-border px-2 py-1 text-left font-medium whitespace-nowrap"
                >
                  {{ col }}
                </th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="(row, i) in view.result.rows"
                :key="i"
                class="hover:bg-foreground/4"
              >
                <td
                  v-for="(cell, j) in row"
                  :key="j"
                  class="max-w-xs truncate border-b border-border/60 px-2 py-0.5 font-mono whitespace-nowrap"
                  :title="cell ?? 'NULL'"
                  :class="cell == null ? 'text-muted-foreground/60' : ''"
                >
                  {{ cell == null ? "NULL" : cell }}
                </td>
              </tr>
            </tbody>
          </table>
          <div
            v-else
            class="px-3 py-6 text-center text-[12px] text-muted-foreground"
          >
            —
          </div>
        </div>
      </div>
    </div>
    <div
      v-if="menu"
      ref="menuEl"
      data-db-tables
      class="fixed z-[200] max-h-[min(70vh,420px)] min-w-36 overflow-auto rounded-lg border border-border bg-popover p-1 shadow-xl"
      :style="{ left: `${menu.x}px`, top: `${menu.y}px` }"
      @click.stop
    >
      <template v-for="(item, i) in menuItems" :key="item.id">
        <div
          v-if="i > 0 && menuItems[i - 1]?.group !== item.group"
          class="my-1 h-px bg-border"
        />
        <button
          type="button"
          class="flex w-full rounded-md px-2.5 py-1 text-left text-[13px] hover:bg-accent"
          @click="fillTable(menu.schema, menu.name, item.id)"
        >
          {{ item.label }}
        </button>
      </template>
    </div>
  </div>
</template>
