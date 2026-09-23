<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from "@lucide/vue";
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
import { generateTableSql, tableLabel } from "@/lib/table-sql";
import { useSessionsStore } from "@/stores/sessions";
import { DB_PAGE_SIZES, useDbStore } from "@/stores/db";
import DbBar from "@/components/db/DbBar.vue";
import SqlEditor from "@/components/db/SqlEditor.vue";
import TableInspect from "@/components/db/TableInspect.vue";
import CellViewer from "@/components/db/CellViewer.vue";
import AppSelect from "@/components/common/AppSelect.vue";
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
const busy = computed(
  () => view.value.running || view.value.scripting || view.value.switching || view.value.exporting,
);

function patchSql(sql: string) {
  sessions.updateConfig(props.session.id, { sql });
}

const menu = ref<{ schema: string; name: string; x: number; y: number } | null>(null);
const menuEl = ref<HTMLElement | null>(null);

const inspectOpen = ref(false);
const cellView = ref<{ column: string; type: string; value: string } | null>(null);

const menuItems = computed(() => [
  { id: "open" as const, label: t("db.open") },
  { id: "inspect" as const, label: t("db.inspect") },
  { id: "export" as const, label: t("db.export") },
]);

function fillTable(schema: string, name: string) {
  const sql = generateTableSql(cfg.value.engine, schema, name, "preview");
  if (sql) patchSql(sql);
  menu.value = null;
}

function openTable(schema: string, name: string) {
  const sql = generateTableSql(cfg.value.engine, schema, name, "open");
  menu.value = null;
  if (!sql) return;
  patchSql(sql);
  run(sql);
}

function onMenuItem(schema: string, name: string, id: "open" | "inspect" | "export") {
  if (id === "open") {
    openTable(schema, name);
    return;
  }
  if (id === "export") {
    void exportTable(schema, name);
    return;
  }
  void openInspect(schema, name);
}

async function exportTable(schema: string, name: string) {
  menu.value = null;
  const file = `${name}.sql`;
  const path = await pickSavePath(file);
  if (!path) return;
  await db.exportSql(props.session.id, schema, name, path);
}

async function exportDatabase() {
  const dbName = cfg.value.database.trim() || cfg.value.engine;
  const path = await pickSavePath(`${dbName}.sql`);
  if (!path) return;
  await db.exportSql(props.session.id, "", "", path);
}

async function openInspect(schema: string, name: string) {
  menu.value = null;
  inspectOpen.value = true;
  const ok = await db.inspect(props.session.id, schema, name);
  if (!ok) inspectOpen.value = false;
}

function closeInspect() {
  inspectOpen.value = false;
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
  if (e.key !== "Escape") return;
  if (document.querySelector('[role="dialog"]')) return;
  if (inspectOpen.value) {
    closeInspect();
    return;
  }
  closeMenu();
}

function openCell(column: string, type: string, value: string | null) {
  if (value == null) return;
  cellView.value = { column, type, value };
}

watch(connected, (ok) => {
  if (!ok) {
    closeInspect();
    cellView.value = null;
  }
});

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
  const lines = [result.columns.map((c) => csvEscape(c.name)).join(",")];
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
  if (v.exporting) return t("db.exporting");
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
  if (r.paged && v.total == null) return t("db.elapsed", { ms: r.elapsedMs });
  const n = r.paged ? (v.total ?? r.rows.length) : r.rows.length;
  const extra = !r.paged && r.truncated ? t("db.truncated") : "";
  return `${t("db.rows", { n, ms: r.elapsedMs })}${extra}`;
});

const gridEl = ref<HTMLElement | null>(null);
const pageInput = ref("1");

const grid = computed(() => {
  const v = view.value;
  const r = v.result;
  if (!r || r.kind !== "query" || !r.columns.length) return null;
  const size = v.pageSize;
  const rows = r.paged ? r.rows : r.rows.slice((v.page - 1) * size, v.page * size);
  const start = r.paged ? r.offset : (v.page - 1) * size;
  const pages = v.total == null ? null : Math.max(1, Math.ceil(v.total / size));
  const from = rows.length ? start + 1 : 0;
  const to = start + rows.length;
  const canNext = r.paged
    ? pages != null
      ? v.page < pages
      : r.hasMore
    : v.page * size < r.rows.length;
  return {
    rows,
    start,
    from,
    to,
    pages,
    canNext,
    show: r.paged || r.truncated || r.rows.length > size || v.page > 1,
  };
});

const rangeText = computed(() => {
  const g = grid.value;
  if (!g) return "";
  const total = view.value.total;
  if (!g.rows.length) {
    return total === 0 ? t("db.spanOf", { from: 0, to: 0, n: 0 }) : "—";
  }
  if (total != null) return t("db.spanOf", { from: g.from, to: g.to, n: total });
  return t("db.span", { from: g.from, to: g.to });
});

watch(
  () => view.value.page,
  async (page) => {
    pageInput.value = String(page);
    await nextTick();
    gridEl.value?.scrollTo({ top: 0 });
  },
);
watch(
  () => view.value.running,
  (running) => {
    if (!running) pageInput.value = String(view.value.page);
  },
);

function commitPage() {
  const n = Number.parseInt(pageInput.value, 10);
  if (!Number.isFinite(n) || n < 1) {
    pageInput.value = String(view.value.page);
    return;
  }
  db.setPage(props.session.id, n);
  if (!view.value.running) pageInput.value = String(view.value.page);
}

function onPageSize(value: string) {
  db.setPageSize(props.session.id, Number(value));
}
</script>

<template>
  <div class="flex h-full min-h-0 flex-col">
    <DbBar :session="session" />
    <div class="flex min-h-0 flex-1">
      <aside
        v-if="connected"
        class="flex w-56 shrink-0 flex-col border-r border-border bg-bg-1/30"
      >
        <div class="flex h-8 items-center justify-between gap-1 px-2 text-[11px] text-muted-foreground">
          <span class="min-w-0 truncate">{{ t("db.tables", { n: view.tables.length }) }}</span>
          <div class="flex shrink-0 items-center">
            <Button
              size="xs"
              variant="ghost"
              class="h-5 px-1.5 text-[11px]"
              :disabled="busy || !view.tables.length"
              @click="exportDatabase"
            >
              {{ t("db.exportDb") }}
            </Button>
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
        </div>
        <div data-db-tables class="min-h-0 flex-1 overflow-auto">
          <button
            v-for="tbl in view.tables"
            :key="`${tbl.schema}.${tbl.name}`"
            type="button"
            class="block w-full px-2 py-1.5 text-left"
            :class="
              inspectOpen && view.inspect?.schema === tbl.schema && view.inspect?.name === tbl.name
                ? 'bg-primary/12'
                : 'hover:bg-foreground/5'
            "
            :title="[tableLabel(cfg.engine, tbl.schema, tbl.name), tbl.comment].filter(Boolean).join('\n')"
            @click="fillTable(tbl.schema, tbl.name)"
            @dblclick.prevent="openTable(tbl.schema, tbl.name)"
            @contextmenu="onTableMenu($event, tbl.schema, tbl.name)"
          >
            <div class="truncate font-mono text-[13px] font-medium text-foreground">
              {{ tableLabel(cfg.engine, tbl.schema, tbl.name) }}
            </div>
            <div
              v-if="tbl.comment"
              class="mt-0.5 truncate text-[10px] leading-4 text-muted-foreground/65"
            >
              {{ tbl.comment }}
            </div>
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
        <div class="flex min-h-0 flex-[3] flex-col">
        <div ref="gridEl" class="min-h-0 flex-1 overflow-auto">
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
            v-else-if="view.error && !grid"
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
            v-else-if="grid"
            class="w-max min-w-full border-collapse text-[12px]"
          >
            <thead class="sticky top-0 bg-bg-1">
              <tr>
                <th class="w-10 border-b border-border px-1.5 py-1" />
                <th
                  v-for="col in view.result?.columns ?? []"
                  :key="col.name"
                  class="border-b border-border px-2 py-1 text-left font-medium whitespace-nowrap"
                >
                  <div class="font-mono text-[12px]">{{ col.pk ? "# " : "" }}{{ col.name }}</div>
                  <div
                    v-if="col.type || col.comment"
                    class="text-[10px] font-normal text-muted-foreground"
                  >
                    {{ col.type }}<template v-if="col.type && col.comment"> · </template>{{ col.comment }}
                  </div>
                </th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="(row, i) in grid.rows"
                :key="grid.start + i"
                class="hover:bg-foreground/4"
              >
                <td class="border-b border-border/60 px-1.5 py-0.5 text-right font-mono text-[11px] tabular-nums text-muted-foreground">
                  {{ grid.start + i + 1 }}
                </td>
                <td
                  v-for="(cell, j) in row"
                  :key="j"
                  class="max-w-xs truncate border-b border-border/60 px-2 py-0.5 font-mono whitespace-nowrap"
                  :class="cell == null ? 'text-muted-foreground/60' : 'cursor-pointer'"
                  :title="cell ?? 'NULL'"
                  @dblclick.prevent="
                    openCell(view.result?.columns[j]?.name ?? '', view.result?.columns[j]?.type ?? '', cell)
                  "
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
        <div
          v-if="grid?.show && !view.scriptLog.length"
          class="flex h-8 shrink-0 items-center gap-0.5 border-t border-border px-2"
        >
          <Button
            size="icon-xs"
            variant="ghost"
            :title="t('db.first')"
            :disabled="busy || view.page <= 1"
            @click="db.setPage(session.id, 1)"
          >
            <ChevronsLeft />
          </Button>
          <Button
            size="icon-xs"
            variant="ghost"
            :title="t('db.prev')"
            :disabled="busy || view.page <= 1"
            @click="db.setPage(session.id, view.page - 1)"
          >
            <ChevronLeft />
          </Button>
          <input
            v-model="pageInput"
            class="h-6 w-10 rounded-md border border-border bg-transparent text-center font-mono text-[12px] outline-none disabled:opacity-50"
            :disabled="busy"
            @keydown.enter.prevent="commitPage"
            @blur="commitPage"
          />
          <span v-if="grid.pages != null" class="px-0.5 text-[11px] tabular-nums text-muted-foreground">
            / {{ grid.pages }}
          </span>
          <Button
            size="icon-xs"
            variant="ghost"
            :title="t('db.next')"
            :disabled="busy || !grid.canNext"
            @click="db.setPage(session.id, view.page + 1)"
          >
            <ChevronRight />
          </Button>
          <Button
            size="icon-xs"
            variant="ghost"
            :title="t('db.last')"
            :disabled="busy || grid.pages == null || view.page >= grid.pages"
            @click="grid.pages != null && db.setPage(session.id, grid.pages)"
          >
            <ChevronsRight />
          </Button>
          <AppSelect
            :model-value="view.pageSize"
            :options="DB_PAGE_SIZES"
            class="ml-1"
            :disabled="busy"
            @update:model-value="onPageSize"
          />
          <span class="ml-auto truncate text-[11px] tabular-nums text-muted-foreground">{{ rangeText }}</span>
        </div>
        </div>
      </div>
      <TableInspect
        v-if="inspectOpen"
        :session-id="session.id"
        :engine="cfg.engine"
        @close="closeInspect"
        @open="openTable"
        @fill="patchSql"
        @export="exportTable"
      />
    </div>
    <CellViewer
      v-if="cellView"
      :column="cellView.column"
      :type="cellView.type"
      :value="cellView.value"
      @close="cellView = null"
    />
    <div
      v-if="menu"
      ref="menuEl"
      data-db-tables
      class="fixed z-[200] max-h-[min(70vh,420px)] min-w-36 overflow-auto rounded-lg border border-border bg-popover p-1 shadow-xl"
      :style="{ left: `${menu.x}px`, top: `${menu.y}px` }"
      @click.stop
    >
      <template v-for="item in menuItems" :key="item.id">
        <button
          type="button"
          class="flex w-full rounded-md px-2.5 py-1 text-left text-[13px] hover:bg-accent"
          @click="onMenuItem(menu.schema, menu.name, item.id)"
        >
          {{ item.label }}
        </button>
      </template>
    </div>
  </div>
</template>
