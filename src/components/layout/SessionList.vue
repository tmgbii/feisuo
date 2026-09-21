<script setup lang="ts">
import { computed, nextTick, ref } from "vue";
import { Cable, Database, Folder, Globe, Network, Plus, Radio, Terminal, Trash2, Bot } from "@lucide/vue";
import type { ProtocolType } from "@/types";
import { protocolLabel, sessionSummary, statusLabel } from "@/lib/protocol";
import { t } from "@/i18n";
import { cn } from "@/lib/utils";
import { useSessionsStore } from "@/stores/sessions";
import { useUiStore } from "@/stores/ui";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

const ui = useUiStore();
const sessions = useSessionsStore();
const editingId = ref<string | null>(null);
const draft = ref("");
const inputRef = ref<{ $el?: HTMLInputElement } | null>(null);

const createOptions = computed(() => {
  if (ui.rail === "serial") return ["serial"] as ProtocolType[];
  if (ui.rail === "network") return ["tcp", "udp", "websocket"] as ProtocolType[];
  if (ui.rail === "mqtt") return ["mqtt"] as ProtocolType[];
  if (ui.rail === "http") return ["http"] as ProtocolType[];
  if (ui.rail === "ssh") return ["ssh"] as ProtocolType[];
  if (ui.rail === "ftp") return ["ftp"] as ProtocolType[];
  if (ui.rail === "db") return ["db"] as ProtocolType[];
  if (ui.rail === "ai") return ["ai"] as ProtocolType[];
  return ["serial", "tcp", "udp", "websocket", "mqtt", "http", "ssh", "ftp", "db", "ai"] as ProtocolType[];
});

const title = computed(() => {
  switch (ui.rail) {
    case "serial":
      return t("list.serial");
    case "network":
      return t("list.network");
    case "mqtt":
      return t("list.mqtt");
    case "http":
      return t("list.http");
    case "ssh":
      return t("list.ssh");
    case "ftp":
      return t("list.ftp");
    case "db":
      return t("list.db");
    case "ai":
      return t("list.ai");
    default:
      return t("list.session");
  }
});

function statusClass(status: string) {
  if (status === "connected") return "bg-rx";
  if (status === "connecting") return "bg-warn animate-pulse";
  if (status === "error") return "bg-err";
  return "bg-muted-foreground/50";
}

function iconFor(protocol: ProtocolType) {
  switch (protocol) {
    case "serial":
      return Cable;
    case "mqtt":
      return Radio;
    case "http":
      return Globe;
    case "ssh":
      return Terminal;
    case "ftp":
      return Folder;
    case "db":
      return Database;
    case "ai":
      return Bot;
    default:
      return Network;
  }
}

async function startRename(id: string, name: string) {
  editingId.value = id;
  draft.value = name;
  await nextTick();
  inputRef.value?.$el?.focus();
  inputRef.value?.$el?.select();
}

function commitRename() {
  if (!editingId.value) return;
  sessions.renameSession(editingId.value, draft.value);
  editingId.value = null;
}

function createDefault() {
  sessions.createSession(createOptions.value[0]);
}
</script>

<template>
  <aside
    class="flex w-60 shrink-0 flex-col border-r border-border bg-bg-1/45"
  >
    <div class="flex h-10 items-center justify-between px-3">
      <span class="text-xs font-medium text-muted-foreground">{{ title }}</span>
      <DropdownMenu>
        <DropdownMenuTrigger as-child>
          <Button variant="ghost" size="icon-xs" class="text-muted-foreground">
            <Plus class="size-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" class="min-w-36">
          <DropdownMenuItem
            v-for="protocol in createOptions"
            :key="protocol"
            @click="sessions.createSession(protocol)"
          >
            {{ protocolLabel(protocol) }}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>

    <div v-if="sessions.filteredSessions.length === 0" class="px-3 py-8 text-center">
      <p class="text-xs text-muted-foreground">{{ t("dash.empty") }}</p>
      <Button size="sm" class="mt-3" @click="createDefault">{{ t("common.new") }}</Button>
    </div>

    <div v-else class="flex-1 space-y-1 overflow-auto px-2 pb-3">
      <div
        v-for="session in sessions.filteredSessions"
        :key="session.id"
        :class="cn(
          'group relative flex cursor-pointer items-center gap-2 rounded-md px-2 py-2 transition-colors duration-150',
          sessions.activeId === session.id
            ? 'bg-primary/10'
            : 'hover:bg-foreground/5',
        )"
        @click="sessions.selectSession(session.id)"
        @dblclick.stop="startRename(session.id, session.name)"
      >
        <span
          v-if="sessions.activeId === session.id"
          class="absolute top-1.5 bottom-1.5 left-0 w-0.5 rounded-full bg-primary"
        />
        <span :class="cn('size-2 shrink-0 rounded-full', statusClass(session.status))" />
        <component :is="iconFor(session.protocol)" class="size-3.5 shrink-0 text-muted-foreground" />
        <div class="min-w-0 flex-1">
          <Input
            v-if="editingId === session.id"
            ref="inputRef"
            v-model="draft"
            class="h-5 rounded-sm px-1 text-[13px] shadow-none"
            @blur="commitRename"
            @keydown.enter.prevent="commitRename"
            @keydown.esc="editingId = null"
            @click.stop
          />
          <div v-else class="truncate text-[13px] leading-5">{{ session.name }}</div>
          <div class="truncate text-[11px] text-muted-foreground">
            {{ sessionSummary(session) }}
          </div>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          class="shrink-0 text-muted-foreground hover:bg-foreground/8 hover:text-err"
          :title="`${t('closeDlg.title')} · ${statusLabel(session.status)}`"
          @click.stop="sessions.requestClose(session.id)"
        >
          <Trash2 class="size-3.5" />
        </Button>
      </div>
    </div>

    <div class="border-t border-border p-2">
      <Button variant="outline" size="sm" class="w-full justify-start text-xs" @click="createDefault">
        <Plus class="size-3.5" />
        {{ t("common.new") }}
        <kbd class="ml-auto font-mono text-[10px] text-muted-foreground">Ctrl+N</kbd>
      </Button>
    </div>
  </aside>
</template>
