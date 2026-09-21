<script setup lang="ts">
import { computed } from "vue";
import { t } from "@/i18n";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import AsciiTable from "@/components/tools/AsciiTable.vue";
import FrameParse from "@/components/tools/FrameParse.vue";
import HistoryPanel from "@/components/tools/HistoryPanel.vue";
import JsonStudio from "@/components/tools/JsonStudio.vue";
import ModbusPanel from "@/components/tools/ModbusPanel.vue";
import MoreTools from "@/components/tools/MoreTools.vue";
import { toolTab, type ToolTab } from "@/lib/tool-bridge";

const PANEL_TABS: ToolTab[] = ["modbus", "parse", "json", "history", "ascii", "more"];
const panelTab = computed({
  get: () => (PANEL_TABS.includes(toolTab.value) ? toolTab.value : "modbus"),
  set: (id: string) => {
    toolTab.value = id as ToolTab;
  },
});
</script>

<template>
  <aside class="flex w-96 shrink-0 flex-col border-l border-border bg-bg-1/45">
    <Tabs v-model="panelTab" class="flex h-full flex-col">
      <div class="border-b border-border px-1.5 py-1">
        <TabsList class="grid h-8 w-full grid-cols-6 text-[10px]">
          <TabsTrigger value="modbus" class="px-0 text-[10px]">Modbus</TabsTrigger>
          <TabsTrigger value="parse" class="px-0 text-[10px]">{{ t("tools.tabParse") }}</TabsTrigger>
          <TabsTrigger value="json" class="px-0 text-[10px]">JSON</TabsTrigger>
          <TabsTrigger value="history" class="px-0 text-[10px]">{{ t("common.history") }}</TabsTrigger>
          <TabsTrigger value="ascii" class="px-0 text-[10px]">ASCII</TabsTrigger>
          <TabsTrigger value="more" class="px-0 text-[10px]">{{ t("tools.tabMore") }}</TabsTrigger>
        </TabsList>
      </div>
      <TabsContent value="modbus" class="min-h-0 flex-1 overflow-auto p-3">
        <ModbusPanel />
      </TabsContent>
      <TabsContent value="parse" class="flex min-h-0 flex-1 flex-col overflow-hidden p-3">
        <FrameParse compact />
      </TabsContent>
      <TabsContent value="json" class="flex min-h-0 flex-1 flex-col overflow-hidden p-3">
        <JsonStudio />
      </TabsContent>
      <TabsContent value="history" class="min-h-0 flex-1 overflow-auto p-3">
        <HistoryPanel />
      </TabsContent>
      <TabsContent value="ascii" class="min-h-0 flex-1 overflow-auto p-3">
        <AsciiTable />
      </TabsContent>
      <TabsContent value="more" class="min-h-0 flex-1 overflow-auto p-3">
        <MoreTools />
      </TabsContent>
    </Tabs>
  </aside>
</template>
