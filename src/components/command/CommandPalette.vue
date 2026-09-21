<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { protocolLabel, protocolShort } from "@/lib/protocol";
import { exportSessions, importSessions } from "@/lib/session-pack";
import { openFrameParser, openJsonTool, openNetWatch } from "@/lib/tool-bridge";
import type { ProtocolType } from "@/types";
import { t } from "@/i18n";
import { useSessionsStore } from "@/stores/sessions";
import { useUiStore } from "@/stores/ui";
import { Input } from "@/components/ui/input";

interface Action {
  id: string;
  label: string;
  hint?: string;
  run: () => void;
}

const ui = useUiStore();
const sessions = useSessionsStore();
const query = ref("");
const active = ref(0);
const inputRef = ref<{ $el?: HTMLInputElement } | null>(null);

const createActions = computed(() =>
  (["serial", "tcp", "udp", "websocket", "mqtt", "http", "ssh", "ftp", "db", "ai"] as ProtocolType[]).map(
    (protocol) => ({
      id: `new-${protocol}`,
      label: t("command.new", { name: protocolLabel(protocol) }),
      hint: "Ctrl+N",
      run: () => sessions.createSession(protocol),
    }),
  ),
);

const actions = computed(() => {
  const list: Action[] = [
    ...createActions.value,
    ...sessions.sessions.map((session) => ({
      id: `go-${session.id}`,
      label: t("command.go", { name: session.name }),
      hint: protocolShort(session.protocol),
      run: () => sessions.selectSession(session.id),
    })),
    {
      id: "json",
      label: t("command.json"),
      run: () => openJsonTool(),
    },
    {
      id: "parse",
      label: t("command.parse"),
      run: () => openFrameParser(),
    },
    {
      id: "net",
      label: t("command.net"),
      run: () => openNetWatch(),
    },
    {
      id: "modbus-lab",
      label: t("command.lab"),
      run: () => ui.setRail("modbus"),
    },
    {
      id: "ssh-hosts",
      label: t("command.hosts"),
      run: () => {
        sessions.activeId = null;
        ui.setRail("ssh");
      },
    },
    {
      id: "ftp",
      label: "FTP",
      run: () => sessions.activateRail("ftp"),
    },
    {
      id: "db",
      label: "DB",
      run: () => sessions.activateRail("db"),
    },
    {
      id: "ai",
      label: "AI",
      run: () => sessions.activateRail("ai"),
    },
    {
      id: "tools",
      label: t("command.tools"),
      run: () => ui.setRail("tools"),
    },
    {
      id: "settings",
      label: t("command.settings"),
      run: () => ui.setRail("settings"),
    },
    {
      id: "export-sessions",
      label: t("command.export"),
      run: () => {
        void exportSessions();
      },
    },
    {
      id: "import-sessions",
      label: t("command.import"),
      run: () => {
        void importSessions();
      },
    },
    {
      id: "help",
      label: t("command.guide"),
      run: () => {
        ui.helpOpen = true;
      },
    },
    {
      id: "about",
      label: t("command.about"),
      run: () => {
        ui.aboutOpen = true;
      },
    },
    ...(sessions.activeSession
      ? [
          {
            id: "close-session",
            label: t("command.close", { name: sessions.activeSession.name }),
            hint: "Ctrl+W",
            run: () => {
              if (sessions.activeId) sessions.requestClose(sessions.activeId);
            },
          },
        ]
      : []),
    {
      id: "sidebar",
      label: ui.sessionListCollapsed ? t("command.expand") : t("command.collapse"),
      hint: "Ctrl+B",
      run: () => ui.toggleSessionList(),
    },
  ];
  const q = query.value.trim().toLowerCase();
  if (!q) return list;
  return list.filter((a) => a.label.toLowerCase().includes(q));
});

watch(actions, () => {
  active.value = 0;
});

watch(
  () => ui.commandOpen,
  (open) => {
    if (open) {
      query.value = "";
      active.value = 0;
      requestAnimationFrame(() => inputRef.value?.$el?.focus());
    }
  },
);

function run(action: Action) {
  action.run();
  ui.commandOpen = false;
}

function onKey(e: KeyboardEvent) {
  if (e.key === "ArrowDown") {
    e.preventDefault();
    active.value = (active.value + 1) % Math.max(actions.value.length, 1);
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    active.value =
      (active.value - 1 + actions.value.length) % Math.max(actions.value.length, 1);
  } else if (e.key === "Enter") {
    e.preventDefault();
    const item = actions.value[active.value];
    if (item) run(item);
  } else if (e.key === "Escape") {
    ui.commandOpen = false;
  }
}

onMounted(() => {
  inputRef.value?.$el?.focus();
});
</script>

<template>
  <div
    v-if="ui.commandOpen"
    class="absolute inset-0 z-50 flex items-start justify-center bg-black/40 pt-[15vh]"
    @click.self="ui.commandOpen = false"
  >
    <div class="w-[520px] overflow-hidden rounded-lg border border-border bg-bg-1 shadow-2xl">
      <Input
        ref="inputRef"
        v-model="query"
        class="h-11 rounded-none border-0 border-b border-border bg-transparent px-4 text-sm shadow-none focus-visible:ring-0"
        :placeholder="t('command.placeholder')"
        @keydown="onKey"
      />
      <div class="max-h-80 overflow-auto py-1">
        <button
          v-for="(action, i) in actions"
          :key="action.id"
          type="button"
          class="flex w-full items-center justify-between px-4 py-2 text-left text-[13px]"
          :class="i === active ? 'bg-primary/12 text-foreground' : 'text-muted-foreground hover:bg-foreground/5'"
          @mouseenter="active = i"
          @click="run(action)"
        >
          <span>{{ action.label }}</span>
          <span v-if="action.hint" class="font-mono text-[10px] opacity-60">{{ action.hint }}</span>
        </button>
        <div v-if="actions.length === 0" class="px-4 py-6 text-center text-xs text-muted-foreground">
          {{ t("command.empty") }}
        </div>
      </div>
    </div>
  </div>
</template>
