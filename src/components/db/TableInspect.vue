<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { toast } from "vue-sonner";
import type { DbEngine } from "@/types";
import { t } from "@/i18n";
import { generateTableSql, tableLabel, tableSqlAvailable, type TableSqlId } from "@/lib/table-sql";
import { useDbStore, type DbInspectRow } from "@/stores/db";
import { Button } from "@/components/ui/button";
import DdlViewer from "@/components/db/DdlViewer.vue";

const props = defineProps<{
  sessionId: string;
  engine: DbEngine;
}>();

const emit = defineEmits<{
  close: [];
  open: [schema: string, name: string];
  fill: [sql: string];
  export: [schema: string, name: string];
}>();

const db = useDbStore();
const view = computed(() => db.viewOf(props.sessionId));
const info = computed(() => view.value.inspect);
const tab = ref("columns");

const title = computed(() => {
  const i = info.value;
  if (!i) return "";
  return tableLabel(props.engine, i.schema, i.name);
});

const summary = computed(() => {
  const i = info.value;
  if (!i) return "";
  return [i.estimate && `~${i.estimate}`, i.size].filter(Boolean).join(" · ");
});

const maint = computed(() =>
  (["analyze", "vacuum", "optimize", "reindex", "check"] as TableSqlId[]).filter((id) =>
    tableSqlAvailable(props.engine, id),
  ),
);

const tabs = computed(() => {
  const i = info.value;
  return [
    { id: "columns", label: t("db.col"), n: i?.columns.length ?? 0 },
    { id: "indexes", label: t("db.idx"), n: i?.indexes.length ?? 0 },
    { id: "fk", label: t("db.fk"), n: i?.foreignKeys.length ?? 0 },
    { id: "checks", label: t("db.checks"), n: i?.checks.length ?? 0 },
    { id: "triggers", label: t("db.triggers"), n: i?.triggers.length ?? 0 },
    { id: "ddl", label: t("db.ddl"), n: i?.ddl ? 1 : 0 },
  ];
});

const pairRows = computed<DbInspectRow[]>(() => {
  const i = info.value;
  if (!i) return [];
  if (tab.value === "indexes") return i.indexes;
  if (tab.value === "fk") return i.foreignKeys;
  if (tab.value === "checks") return i.checks;
  if (tab.value === "triggers") return i.triggers;
  return [];
});

watch(
  () => (info.value ? `${info.value.schema}.${info.value.name}` : ""),
  () => {
    tab.value = "columns";
  },
);

function fillId(id: TableSqlId) {
  const i = info.value;
  if (!i) return;
  const sql = generateTableSql(props.engine, i.schema, i.name, id);
  if (sql) emit("fill", sql);
}

async function copyDdl() {
  const ddl = info.value?.ddl?.trim();
  if (!ddl) return;
  try {
    await navigator.clipboard.writeText(ddl);
    toast.success(t("common.copied"));
  } catch {
    /* */
  }
}
</script>

<template>
  <aside class="flex w-96 shrink-0 flex-col border-l border-border bg-bg-1/45">
    <header class="shrink-0 border-b border-border">
      <div class="flex h-8 items-center gap-1 px-2">
        <div class="min-w-0 flex-1 truncate font-mono text-[13px] font-medium">
          {{ title || "—" }}
        </div>
        <Button
          size="xs"
          variant="ghost"
          class="h-5 px-1.5 text-[11px]"
          :disabled="!info || view.inspecting"
          @click="info && emit('open', info.schema, info.name)"
        >
          {{ t("db.open") }}
        </Button>
        <Button size="xs" variant="ghost" class="h-5 px-1.5 text-[11px]" :disabled="!info" @click="fillId('preview')">
          SELECT
        </Button>
        <Button
          size="xs"
          variant="ghost"
          class="h-5 px-1.5 text-[11px]"
          :disabled="!info || view.exporting"
          @click="info && emit('export', info.schema, info.name)"
        >
          {{ t("db.export") }}
        </Button>
        <Button size="xs" variant="ghost" class="h-5 px-1.5 text-[11px]" @click="emit('close')">
          {{ t("common.close") }}
        </Button>
      </div>
      <div
        v-if="info?.comment || summary"
        class="truncate px-2 pb-1.5 text-[10px] leading-4 text-muted-foreground/65"
      >
        {{ info?.comment || summary }}
        <template v-if="info?.comment && summary"> · {{ summary }}</template>
      </div>
    </header>
    <div v-if="view.inspecting" class="py-10 text-center text-[12px] text-muted-foreground">
      {{ t("db.running") }}
    </div>
    <template v-else-if="info">
      <div class="flex h-8 shrink-0 items-center gap-0.5 overflow-x-auto border-b border-border px-1.5">
        <button
          v-for="item in tabs"
          :key="item.id"
          type="button"
          class="flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 text-[12px]"
          :class="
            tab === item.id
              ? 'bg-primary/12 text-primary'
              : 'text-muted-foreground hover:bg-foreground/5 hover:text-foreground'
          "
          @click="tab = item.id"
        >
          {{ item.label }}
          <span class="text-[10px] text-muted-foreground">{{ item.n }}</span>
        </button>
      </div>
      <div v-if="tab === 'columns'" class="min-h-0 flex-1 overflow-auto">
        <table v-if="info.columns.length" class="w-max min-w-full border-collapse text-[12px]">
          <thead class="sticky top-0 bg-bg-1">
            <tr>
              <th class="w-8 border-b border-border px-2 py-1.5 text-left font-medium"></th>
              <th class="border-b border-border px-2 py-1.5 text-left font-medium">{{ t("common.name") }}</th>
              <th class="border-b border-border px-2 py-1.5 text-left font-medium">{{ t("db.type") }}</th>
              <th class="border-b border-border px-2 py-1.5 text-left font-medium">{{ t("db.nullable") }}</th>
              <th class="border-b border-border px-2 py-1.5 text-left font-medium">{{ t("db.default") }}</th>
              <th class="border-b border-border px-2 py-1.5 text-left font-medium">{{ t("db.comments") }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="col in info.columns" :key="col.name" class="hover:bg-foreground/4">
              <td class="border-b border-border/60 px-2 py-1 text-center text-[10px] text-muted-foreground">
                {{ col.pk ? "#" : "" }}
              </td>
              <td class="border-b border-border/60 px-2 py-1 font-mono whitespace-nowrap">{{ col.name }}</td>
              <td class="border-b border-border/60 px-2 py-1 font-mono whitespace-nowrap text-muted-foreground">
                {{ col.type }}
              </td>
              <td class="border-b border-border/60 px-2 py-1 text-muted-foreground">
                {{ col.nullable ? "NULL" : "" }}
              </td>
              <td
                class="max-w-[160px] truncate border-b border-border/60 px-2 py-1 font-mono text-muted-foreground"
                :title="col.default"
              >
                {{ col.default }}
              </td>
              <td class="max-w-[200px] truncate border-b border-border/60 px-2 py-1" :title="col.comment">
                {{ col.comment }}
              </td>
            </tr>
          </tbody>
        </table>
        <div v-else class="px-3 py-8 text-center text-[12px] text-muted-foreground">—</div>
      </div>
      <div v-else-if="tab !== 'ddl'" class="min-h-0 flex-1 overflow-auto">
        <table v-if="pairRows.length" class="w-max min-w-full border-collapse text-[12px]">
          <thead class="sticky top-0 bg-bg-1">
            <tr>
              <th class="border-b border-border px-2 py-1.5 text-left font-medium">{{ t("common.name") }}</th>
              <th class="border-b border-border px-2 py-1.5 text-left font-medium">{{ t("db.def") }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(row, i) in pairRows" :key="`${row.name}-${i}`" class="hover:bg-foreground/4">
              <td class="border-b border-border/60 px-2 py-1 font-mono whitespace-nowrap">{{ row.name }}</td>
              <td class="border-b border-border/60 px-2 py-1 font-mono text-[11px] break-all text-muted-foreground">
                {{ row.detail }}
              </td>
            </tr>
          </tbody>
        </table>
        <div v-else class="px-3 py-8 text-center text-[12px] text-muted-foreground">—</div>
      </div>
      <div v-else class="flex min-h-0 flex-1 flex-col">
        <div class="flex h-7 shrink-0 items-center justify-end px-2">
          <button
            type="button"
            class="text-[11px] text-muted-foreground hover:text-foreground"
            :disabled="!info.ddl"
            @click="copyDdl"
          >
            {{ t("common.copy") }}
          </button>
        </div>
        <DdlViewer :model-value="info.ddl" :dialect="engine" class="min-h-0 flex-1" />
      </div>
    </template>
    <div v-else class="py-10 text-center text-[12px] text-muted-foreground">—</div>
    <footer
      v-if="info && maint.length && !view.inspecting"
      class="flex h-8 shrink-0 items-center gap-0.5 overflow-x-auto border-t border-border px-1.5"
    >
      <Button
        v-for="id in maint"
        :key="id"
        size="xs"
        variant="ghost"
        class="h-5 px-1.5 text-[11px]"
        @click="fillId(id)"
      >
        {{ id.toUpperCase() }}
      </Button>
    </footer>
  </aside>
</template>
