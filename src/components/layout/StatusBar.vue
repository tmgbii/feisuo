<script setup lang="ts">
import { ChevronUp, RotateCcw } from "@lucide/vue";
import { formatBytes } from "@/lib/format";
import { invokeAppQuit } from "@/lib/ipc";
import { t } from "@/i18n";
import { connectionParams, statusLabel } from "@/lib/protocol";
import { useSessionsStore } from "@/stores/sessions";
import { useModbusLabStore } from "@/stores/modbus-lab";
import { useAiStore } from "@/stores/ai";
import { useSshStore } from "@/stores/ssh";
import { useUiStore } from "@/stores/ui";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

const sessions = useSessionsStore();
const lab = useModbusLabStore();
const ai = useAiStore();
const ssh = useSshStore();
const ui = useUiStore();

const sshTunnels = () => {
  const id = sessions.activeSession?.id;
  if (!id) return 0;
  return Object.values(ssh.tunnelStatus[id] ?? {}).filter((s) => s === "open").length;
};
</script>

<template>
  <footer class="flex h-6 shrink-0 items-center gap-3 border-t border-border bg-bg-1/80 px-3 text-[11px] text-muted-foreground">
    <template v-if="ui.rail === 'ai'">
      <template v-if="sessions.activeSession?.protocol === 'ai'">
        <span>{{ sessions.activeSession.name }}</span>
        <span>{{
          sessions.activeSession.config.kind === "ai"
            ? sessions.activeSession.config.model || t("bar.notConfigured")
            : t("bar.notConfigured")
        }}</span>
        <span v-if="ai.streamingId === sessions.activeSession.id">{{ t("bar.generating") }}</span>
      </template>
      <span v-else>AI</span>
    </template>
    <template v-else-if="ui.rail === 'net'">
      <span>{{ t("rail.net") }}</span>
    </template>
    <template v-else-if="ui.rail === 'modbus'">
      <span>{{ t("rail.sim") }}</span>
      <span>{{ t("bar.master", { s: lab.masterStatus }) }}</span>
      <span>{{ t("bar.slave", { s: lab.slaveStatus }) }}</span>
      <span class="text-foreground/20">│</span>
      <span>{{ t("bar.labStats", { ok: lab.stats.ok, timeout: lab.stats.timeout, crc: lab.stats.crc, exc: lab.stats.exc }) }}</span>
      <Button
        variant="ghost"
        size="xs"
        class="h-5 px-1.5 text-[11px] text-muted-foreground"
        @click="lab.resetStats"
      >
        <RotateCcw class="size-3" />
        {{ t("common.reset") }}
      </Button>
    </template>
    <template v-else-if="ui.rail === 'ftp'">
      <template v-if="sessions.activeSession?.protocol === 'ftp'">
        <span class="flex items-center gap-1.5">
          <span
            class="size-1.5 rounded-full"
            :class="{
              'bg-rx': sessions.activeSession.status === 'connected',
              'bg-warn': sessions.activeSession.status === 'connecting',
              'bg-err': sessions.activeSession.status === 'error',
              'bg-muted-foreground/50': sessions.activeSession.status === 'disconnected',
            }"
          />
          <span class="text-foreground/80">{{ statusLabel(sessions.activeSession.status) }}</span>
          <span>{{ connectionParams(sessions.activeSession) }}</span>
        </span>
      </template>
      <span v-else>FTP</span>
    </template>
    <template v-else-if="ui.rail === 'db'">
      <template v-if="sessions.activeSession?.protocol === 'db'">
        <span class="flex items-center gap-1.5">
          <span
            class="size-1.5 rounded-full"
            :class="{
              'bg-rx': sessions.activeSession.status === 'connected',
              'bg-warn': sessions.activeSession.status === 'connecting',
              'bg-err': sessions.activeSession.status === 'error',
              'bg-muted-foreground/50': sessions.activeSession.status === 'disconnected',
            }"
          />
          <span class="text-foreground/80">{{ statusLabel(sessions.activeSession.status) }}</span>
          <span>{{ connectionParams(sessions.activeSession) }}</span>
        </span>
      </template>
      <span v-else>DB</span>
    </template>
    <template v-else-if="ui.rail === 'ssh'">
      <template v-if="sessions.activeSession?.protocol === 'ssh'">
        <span class="flex items-center gap-1.5">
          <span
            class="size-1.5 rounded-full"
            :class="{
              'bg-rx': sessions.activeSession.status === 'connected',
              'bg-warn': sessions.activeSession.status === 'connecting',
              'bg-err': sessions.activeSession.status === 'error',
              'bg-muted-foreground/50': sessions.activeSession.status === 'disconnected',
            }"
          />
          <span class="text-foreground/80">{{ statusLabel(sessions.activeSession.status) }}</span>
          <span>{{ connectionParams(sessions.activeSession) }}</span>
        </span>
        <span class="text-foreground/20">│</span>
        <span>{{ t("bar.tunnels", { n: sshTunnels() }) }}</span>
      </template>
      <span v-else>{{ t("common.hostBook") }}</span>
    </template>
    <template v-else-if="sessions.activeSession">
      <span class="flex items-center gap-1.5">
        <span
          class="size-1.5 rounded-full"
          :class="{
            'bg-rx': sessions.activeSession.status === 'connected',
            'bg-warn': sessions.activeSession.status === 'connecting',
            'bg-err': sessions.activeSession.status === 'error',
            'bg-muted-foreground/50': sessions.activeSession.status === 'disconnected',
          }"
        />
        <span class="text-foreground/80">{{ statusLabel(sessions.activeSession.status) }}</span>
        <span>{{ connectionParams(sessions.activeSession) }}</span>
      </span>
      <span class="text-foreground/20">│</span>
      <span>RX {{ formatBytes(sessions.activeSession.rxBytes) }}/{{ sessions.activeSession.rxFrames }}</span>
      <span>TX {{ formatBytes(sessions.activeSession.txBytes) }}/{{ sessions.activeSession.txFrames }}</span>
      <Button
        variant="ghost"
        size="xs"
        class="h-5 px-1.5 text-[11px] text-muted-foreground"
        @click="sessions.resetCounters(sessions.activeSession.id)"
      >
        <RotateCcw class="size-3" />
        {{ t("common.reset") }}
      </Button>
    </template>
    <span v-else>{{ t("common.ready") }}</span>

    <DropdownMenu>
      <DropdownMenuTrigger as-child>
        <Button
          variant="ghost"
          size="xs"
          class="ml-auto h-5 gap-0.5 px-1.5 text-[11px] text-muted-foreground"
        >
          飞梭
          <ChevronUp class="size-3" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" side="top" class="min-w-28">
        <DropdownMenuItem variant="destructive" @click="invokeAppQuit()">{{ t("common.quit") }}</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  </footer>
</template>
