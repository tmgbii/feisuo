<script setup lang="ts">
import type { Component } from "vue";
import { computed } from "vue";
import { Binary, Braces, Cable, Clock, Globe, Hash, Network, Radio, ScanSearch, Shield, Waypoints, Wrench } from "@lucide/vue";
import type { ProtocolType } from "@/types";
import { useSessionsStore } from "@/stores/sessions";
import { useUiStore } from "@/stores/ui";
import { APP_NAME, appTagline } from "@/lib/brand";
import { formatDateTime } from "@/lib/format";
import { protocolLabel, sessionEndpoint } from "@/lib/protocol";
import { t } from "@/i18n";
import PageHelp from "@/components/common/PageHelp.vue";
import { openFrameParser, openJsonTool, openNetWatch, toolTab } from "@/lib/tool-bridge";

const sessions = useSessionsStore();
const ui = useUiStore();

const cards = computed(() =>
  [
    { protocol: "serial" as ProtocolType, desc: t("dash.serial"), icon: Cable },
    { protocol: "tcp" as ProtocolType, desc: t("dash.tcp"), icon: Network },
    { protocol: "udp" as ProtocolType, desc: t("dash.udp"), icon: Network },
    { protocol: "websocket" as ProtocolType, desc: t("dash.websocket"), icon: Globe },
    { protocol: "mqtt" as ProtocolType, desc: t("dash.mqtt"), icon: Radio },
    { protocol: "http" as ProtocolType, desc: t("dash.http"), icon: Globe },
  ] as { protocol: ProtocolType; desc: string; icon: Component }[],
);

const toolShortcuts = computed(() => [
  { id: "lab", label: t("dash.lab"), icon: Binary },
  { id: "modbus", label: t("dash.modbus"), icon: Binary },
  { id: "parse", label: t("dash.parse"), icon: ScanSearch },
  { id: "net", label: t("dash.net"), icon: Waypoints },
  { id: "checksum", label: t("dash.checksum"), icon: Shield },
  { id: "ascii", label: t("dash.ascii"), icon: Hash },
  { id: "json", label: t("dash.json"), icon: Braces },
  { id: "time", label: t("dash.time"), icon: Clock },
  { id: "more", label: t("dash.more"), icon: Wrench },
]);

function openShortcut(id: string) {
  if (id === "lab") {
    ui.setRail("modbus");
    return;
  }
  if (id === "json") {
    openJsonTool();
    return;
  }
  if (id === "parse") {
    openFrameParser();
    return;
  }
  if (id === "net") {
    openNetWatch();
    return;
  }
  if (id === "modbus") toolTab.value = "modbus";
  else if (id === "ascii") toolTab.value = "ascii";
  else toolTab.value = "more";
  ui.setRail("tools");
}
</script>

<template>
  <div class="h-full overflow-auto p-8">
    <div class="mb-8">
      <div class="flex items-center gap-1">
        <h1 class="text-xl font-medium tracking-tight">{{ APP_NAME }}</h1>
        <PageHelp page="dashboard" />
      </div>
      <p class="mt-1 text-sm text-muted-foreground">{{ appTagline() }}</p>
    </div>

    <h2 class="mb-3 text-xs font-medium tracking-wide text-muted-foreground">{{ t("dash.newSession") }}</h2>
    <div class="grid grid-cols-3 gap-3">
      <button
        v-for="card in cards"
        :key="card.protocol"
        type="button"
        class="group rounded-lg border border-border bg-bg-1/80 p-4 text-left transition-colors duration-150 hover:border-primary/40 hover:bg-bg-2"
        @click="sessions.createSession(card.protocol)"
      >
        <component
          :is="card.icon"
          class="size-5 text-primary/80 transition-colors duration-150 group-hover:text-primary"
        />
        <div class="mt-3 text-sm font-medium">{{ protocolLabel(card.protocol) }}</div>
        <div class="mt-1 text-xs text-muted-foreground">{{ card.desc }}</div>
      </button>
    </div>

    <div class="mt-10 grid grid-cols-2 gap-8">
      <section>
        <h2 class="mb-3 text-xs font-medium tracking-wide text-muted-foreground">{{ t("dash.recent") }}</h2>
        <div
          v-if="sessions.recentSessions.length === 0"
          class="rounded-lg border border-dashed border-border px-4 py-8 text-center text-xs text-muted-foreground"
        >
          {{ t("dash.empty") }}
        </div>
        <div v-else class="space-y-1">
          <button
            v-for="session in sessions.recentSessions"
            :key="session.id"
            type="button"
            class="flex w-full items-center justify-between rounded-md px-3 py-2 text-left transition-colors duration-150 hover:bg-foreground/5"
            @click="sessions.selectSession(session.id)"
          >
            <span>
              <span class="text-sm">{{ session.name }}</span>
              <span class="ml-2 text-xs text-muted-foreground">{{ sessionEndpoint(session) }}</span>
            </span>
            <span class="text-[11px] text-muted-foreground">{{ formatDateTime(session.lastActiveAt) }}</span>
          </button>
        </div>
      </section>

      <section>
        <h2 class="mb-3 text-xs font-medium tracking-wide text-muted-foreground">{{ t("dash.tools") }}</h2>
        <div class="grid grid-cols-2 gap-2">
          <button
            v-for="tool in toolShortcuts"
            :key="tool.id"
            type="button"
            class="flex items-center gap-2 rounded-md border border-border bg-bg-1/60 px-3 py-2 text-left text-sm whitespace-nowrap transition-colors duration-150 hover:bg-bg-2"
            @click="openShortcut(tool.id)"
          >
            <component :is="tool.icon" class="size-4 text-muted-foreground" />
            {{ tool.label }}
          </button>
        </div>
      </section>
    </div>
  </div>
</template>
