<script setup lang="ts">
import { computed, onMounted, onUnmounted } from "vue";
import { t } from "@/i18n";
import { RAIL_PROTOCOLS } from "@/lib/protocol";
import { restoreApp, watchPersist } from "@/lib/persist";
import { hideSplash } from "@/lib/splash";
import type { ProtocolType } from "@/types";
import { useSessionsStore } from "@/stores/sessions";
import { useAiStore } from "@/stores/ai";
import { useUiStore } from "@/stores/ui";
import TitleBar from "@/components/layout/TitleBar.vue";
import Rail from "@/components/layout/Rail.vue";
import SessionList from "@/components/layout/SessionList.vue";
import StatusBar from "@/components/layout/StatusBar.vue";
import ToolPanel from "@/components/layout/ToolPanel.vue";
import CloseSessionDialog from "@/components/layout/CloseSessionDialog.vue";
import DashboardView from "@/components/dashboard/DashboardView.vue";
import SessionView from "@/components/session/SessionView.vue";
import HttpView from "@/components/http/HttpView.vue";
import ModbusLabView from "@/components/modbus/ModbusLabView.vue";
import AiView from "@/components/ai/AiView.vue";
import ToolsView from "@/components/tools/ToolsView.vue";
import SettingsView from "@/components/settings/SettingsView.vue";
import CommandPalette from "@/components/command/CommandPalette.vue";
import HelpDialog from "@/components/layout/HelpDialog.vue";
import AboutDialog from "@/components/layout/AboutDialog.vue";
import SshView from "@/components/ssh/SshView.vue";
import SshHostBook from "@/components/ssh/SshHostBook.vue";
import SshHostKeyDialog from "@/components/ssh/SshHostKeyDialog.vue";
import FtpView from "@/components/ftp/FtpView.vue";
import DbView from "@/components/db/DbView.vue";
import { useSshStore } from "@/stores/ssh";
import { useFtpStore } from "@/stores/ftp";
import { useDbStore } from "@/stores/db";

const ui = useUiStore();
const sessions = useSessionsStore();
const ai = useAiStore();
const ssh = useSshStore();
const ftp = useFtpStore();
const db = useDbStore();

const showSessionList = computed(
  () => !ui.isChromeView && !ui.sessionListCollapsed,
);

const currentSession = computed(() => {
  const session = sessions.activeSession;
  if (!session) return null;
  const allowed = RAIL_PROTOCOLS[ui.rail];
  if (allowed && !allowed.includes(session.protocol)) return null;
  return session;
});

const showToolPanel = computed(() => {
  const session = currentSession.value;
  if (!session || ui.isChromeView || ui.toolPanelCollapsed) return false;
  return (
    session.protocol !== "http" &&
    session.protocol !== "ssh" &&
    session.protocol !== "ftp" &&
    session.protocol !== "db" &&
    session.protocol !== "ai"
  );
});

function defaultProtocol(): ProtocolType {
  const allowed = RAIL_PROTOCOLS[ui.rail];
  return allowed?.[0] ?? "serial";
}

function onKey(e: KeyboardEvent) {
  const meta = e.ctrlKey || e.metaKey;
  const inTerm = (e.target as HTMLElement | null)?.closest?.(".ssh-term");
  if (e.key === "Tab" && !meta) {
    if (inTerm) return;
  }
  if (meta && e.key.toLowerCase() === "k") {
    e.preventDefault();
    ui.commandOpen = !ui.commandOpen;
    return;
  }
  if (ui.commandOpen) return;
  if (meta && e.key.toLowerCase() === "b") {
    e.preventDefault();
    ui.toggleSessionList();
  }
  if (meta && e.key.toLowerCase() === "w") {
    e.preventDefault();
    if (sessions.activeId) sessions.requestClose(sessions.activeId);
    return;
  }
  if (meta && e.key.toLowerCase() === "n") {
    e.preventDefault();
    if (ui.isChromeView) {
      ui.commandOpen = true;
    } else {
      sessions.createSession(defaultProtocol());
    }
  }
  if (meta && e.key === "Tab") {
    e.preventDefault();
    sessions.switchNext();
  }
}

onMounted(() => {
  window.addEventListener("keydown", onKey);
  void (async () => {
    try {
      await restoreApp();
      watchPersist();
      await sessions.bindBackend();
      await ai.bind();
      await ssh.bind();
      await ftp.bind();
      await db.bind();
    } finally {
      hideSplash();
    }
  })();
});
onUnmounted(() => {
  window.removeEventListener("keydown", onKey);
  sessions.unbindBackend();
  ai.unbind();
  ssh.unbind();
  ftp.unbind();
  db.unbind();
});
</script>

<template>
  <div class="relative flex h-full flex-col overflow-hidden bg-bg-0/70 text-foreground">
    <TitleBar />
    <div class="flex min-h-0 flex-1">
      <Rail />
      <SessionList v-if="showSessionList" />
      <main class="min-h-0 min-w-0 flex-1 overflow-hidden bg-bg-0/40">
        <ToolsView v-if="ui.rail === 'tools'" />
        <SettingsView v-else-if="ui.rail === 'settings'" />
        <ModbusLabView v-else-if="ui.rail === 'modbus'" />
        <SshHostBook v-else-if="ui.rail === 'ssh' && !currentSession" />
        <div
          v-else-if="(ui.rail === 'ai' || ui.rail === 'ftp' || ui.rail === 'db') && !currentSession"
          class="flex h-full items-center justify-center text-[13px] text-muted-foreground"
        >
          {{ t("dash.empty") }}
        </div>
        <DashboardView v-else-if="!currentSession" />
        <HttpView
          v-else-if="currentSession.protocol === 'http'"
          :session="currentSession"
        />
        <SshView
          v-else-if="currentSession.protocol === 'ssh'"
          :session="currentSession"
        />
        <FtpView
          v-else-if="currentSession.protocol === 'ftp'"
          :session="currentSession"
        />
        <DbView
          v-else-if="currentSession.protocol === 'db'"
          :session="currentSession"
        />
        <AiView
          v-else-if="currentSession.protocol === 'ai'"
          :session="currentSession"
        />
        <SessionView v-else :session="currentSession" />
      </main>
      <ToolPanel v-if="showToolPanel" />
    </div>
    <StatusBar />
    <CommandPalette />
    <HelpDialog />
    <AboutDialog />
    <CloseSessionDialog />
    <SshHostKeyDialog />
  </div>
</template>
