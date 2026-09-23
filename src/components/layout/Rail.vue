<script setup lang="ts">
import { computed, type Component } from "vue";
import {
  Binary,
  Bot,
  Cable,
  Database,
  Folder,
  Globe,
  Network,
  Radio,
  Settings,
  Terminal,
  Waypoints,
  Wrench,
} from "@lucide/vue";
import type { RailId } from "@/types";
import { t } from "@/i18n";
import { useUiStore } from "@/stores/ui";
import { useSessionsStore } from "@/stores/sessions";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

const ui = useUiStore();
const sessions = useSessionsStore();

const items = computed(() =>
  [
    { id: "serial" as RailId, label: t("rail.serial"), icon: Cable },
    { id: "network" as RailId, label: t("rail.network"), icon: Network },
    { id: "mqtt" as RailId, label: t("rail.mqtt"), icon: Radio },
    { id: "http" as RailId, label: t("rail.http"), icon: Globe },
    { id: "ssh" as RailId, label: t("rail.ssh"), icon: Terminal },
    { id: "ftp" as RailId, label: t("rail.ftp"), icon: Folder },
    { id: "db" as RailId, label: t("rail.db"), icon: Database },
  ] as { id: RailId; label: string; icon: Component }[],
);

const bottom = computed(() =>
  [
    { id: "ai" as RailId, label: t("rail.ai"), icon: Bot },
    { id: "net" as RailId, label: t("rail.net"), icon: Waypoints },
    { id: "modbus" as RailId, label: t("rail.sim"), icon: Binary },
    { id: "tools" as RailId, label: t("rail.tools"), icon: Wrench },
    { id: "settings" as RailId, label: t("rail.settings"), icon: Settings },
  ] as { id: RailId; label: string; icon: Component }[],
);

function select(id: RailId) {
  sessions.activateRail(id);
}
</script>

<template>
  <nav class="flex w-16 shrink-0 flex-col items-center border-r border-border bg-bg-1/55 py-2">
    <div class="flex flex-1 flex-col items-center gap-1">
      <Tooltip v-for="item in items" :key="item.id">
        <TooltipTrigger as-child>
          <button
            type="button"
            :class="cn(
              'flex h-11 w-11 flex-col items-center justify-center gap-0.5 rounded-lg text-[10px] transition-colors duration-150',
              ui.rail === item.id
                ? 'bg-primary/12 text-primary'
                : 'text-muted-foreground hover:bg-foreground/5 hover:text-foreground',
            )"
            @click="select(item.id)"
          >
            <component :is="item.icon" class="size-5" />
            <span>{{ item.label }}</span>
          </button>
        </TooltipTrigger>
        <TooltipContent side="right">{{ item.label }}</TooltipContent>
      </Tooltip>
    </div>
    <div class="flex flex-col items-center gap-1">
      <Tooltip v-for="item in bottom" :key="item.id">
        <TooltipTrigger as-child>
          <button
            type="button"
            :class="cn(
              'flex h-11 w-11 flex-col items-center justify-center gap-0.5 rounded-lg text-[10px] transition-colors duration-150',
              ui.rail === item.id
                ? 'bg-primary/12 text-primary'
                : 'text-muted-foreground hover:bg-foreground/5 hover:text-foreground',
            )"
            @click="select(item.id)"
          >
            <component :is="item.icon" class="size-5" />
            <span>{{ item.label }}</span>
          </button>
        </TooltipTrigger>
        <TooltipContent side="right">{{ item.label }}</TooltipContent>
      </Tooltip>
    </div>
  </nav>
</template>
