<script setup lang="ts">
import { computed, watch } from "vue";
import { t } from "@/i18n";
import AsciiTable from "@/components/tools/AsciiTable.vue";
import FrameParse from "@/components/tools/FrameParse.vue";
import HistoryPanel from "@/components/tools/HistoryPanel.vue";
import JsonStudio from "@/components/tools/JsonStudio.vue";
import ModbusPanel from "@/components/tools/ModbusPanel.vue";
import MoreTools from "@/components/tools/MoreTools.vue";
import PageHelp from "@/components/common/PageHelp.vue";
import { toolTab } from "@/lib/tool-bridge";
import { cn } from "@/lib/utils";

const nav = computed(() => [
  { id: "modbus" as const, label: t("tools.modbus") },
  { id: "parse" as const, label: t("tools.parse") },
  { id: "json" as const, label: t("tools.json") },
  { id: "history" as const, label: t("tools.history") },
  { id: "ascii" as const, label: t("tools.ascii") },
  { id: "more" as const, label: t("tools.more") },
]);

const current = toolTab;

watch(current, (id) => {
  if (!nav.value.some((item) => item.id === id)) current.value = "modbus";
});
</script>

<template>
  <div class="flex h-full">
    <aside class="w-48 shrink-0 border-r border-border bg-bg-1/40 p-2">
      <div class="px-2 py-2 text-xs font-medium text-muted-foreground">{{ t("tools.title") }}</div>
      <button
        v-for="item in nav"
        :key="item.id"
        type="button"
        :class="cn(
          'mb-0.5 w-full rounded-md px-2 py-1.5 text-left text-[13px] transition-colors duration-150',
          current === item.id ? 'bg-primary/12 text-primary' : 'text-muted-foreground hover:bg-foreground/5 hover:text-foreground',
        )"
        @click="current = item.id"
      >
        {{ item.label }}
      </button>
    </aside>
    <div class="flex min-h-0 min-w-0 flex-1 flex-col p-5">
      <div class="mb-4 flex shrink-0 items-center gap-1">
        <h1 class="text-base font-medium">{{ nav.find((n) => n.id === current)?.label }}</h1>
        <PageHelp page="tools" />
      </div>
      <div :class="current === 'json' || current === 'parse' ? 'min-h-0 flex-1 overflow-hidden' : 'min-h-0 flex-1 overflow-auto'">
        <JsonStudio v-show="current === 'json'" />
        <FrameParse v-show="current === 'parse'" />
        <ModbusPanel v-show="current === 'modbus'" />
        <HistoryPanel v-show="current === 'history'" />
        <AsciiTable v-show="current === 'ascii'" />
        <MoreTools v-show="current === 'more'" />
      </div>
    </div>
  </div>
</template>
