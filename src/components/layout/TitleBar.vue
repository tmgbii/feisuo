<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import { isTauri } from "@tauri-apps/api/core";
import { Minus, Square, Copy, X, PanelLeft, CircleHelp, Info, Download, Upload, Sun, Moon } from "@lucide/vue";
import { APP_NAME, appTagline } from "@/lib/brand";
import { exportSessions, importSessions } from "@/lib/session-pack";
import { protocolLabel } from "@/lib/protocol";
import { resolvedLocale, t } from "@/i18n";
import type { LocalePref } from "@/types";
import { useSessionsStore } from "@/stores/sessions";
import { useUiStore } from "@/stores/ui";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

const ui = useUiStore();
const sessions = useSessionsStore();
const isMac = navigator.userAgent.includes("Mac");
const maximized = ref(false);

const crumb = computed(() => {
  if (ui.rail === "tools") return t("title.tools");
  if (ui.rail === "settings") return t("title.settings");
  if (ui.rail === "modbus") return t("title.lab");
  if (ui.rail === "ai") {
    return sessions.activeSession?.protocol === "ai"
      ? sessions.activeSession.name
      : "AI";
  }
  if (ui.rail === "ssh") {
    return sessions.activeSession?.protocol === "ssh"
      ? sessions.activeSession.name
      : "SSH";
  }
  if (ui.rail === "ftp") {
    return sessions.activeSession?.protocol === "ftp"
      ? sessions.activeSession.name
      : "FTP";
  }
  if (ui.rail === "db") {
    return sessions.activeSession?.protocol === "db"
      ? sessions.activeSession.name
      : "DB";
  }
  if (sessions.activeSession) return sessions.activeSession.name;
  const proto =
    ui.rail === "network"
      ? "tcp"
      : ui.rail === "serial"
        ? "serial"
        : ui.rail === "mqtt"
          ? "mqtt"
          : "http";
  return protocolLabel(proto);
});

const localeMark = computed(() => (resolvedLocale.value === "en" ? "EN" : "中"));
const windowTitle = computed(() => `${APP_NAME} · ${appTagline()}`);

function pickLocale(next: LocalePref) {
  ui.setLocale(next);
}

async function currentWindow() {
  if (!isTauri()) return null;
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  return getCurrentWindow();
}

async function minimize() {
  const win = await currentWindow();
  if (!win) return;
  await win.hide();
  await win.setSkipTaskbar(true);
}

async function toggleMax() {
  const win = await currentWindow();
  if (!win) return;
  await win.toggleMaximize();
  maximized.value = await win.isMaximized();
}

async function close() {
  await minimize();
}

async function syncMax() {
  const win = await currentWindow();
  if (!win) return;
  maximized.value = await win.isMaximized();
}

function openHelp() {
  ui.helpOpen = true;
}

function openAbout() {
  ui.aboutOpen = true;
}

onMounted(() => {
  void syncMax();
  window.addEventListener("resize", syncMax);
});

onUnmounted(() => {
  window.removeEventListener("resize", syncMax);
});
</script>

<template>
  <header
    class="flex h-10 shrink-0 items-center border-b border-border bg-bg-1/70 px-3"
  >
    <div
      class="flex min-w-0 flex-1 items-center gap-2 self-stretch text-[13px]"
      :class="isMac ? 'pl-[76px]' : ''"
      data-tauri-drag-region
    >
      <img src="/icon.png" alt="" class="size-4 shrink-0 rounded-[4px]" :title="windowTitle" />
      <span class="min-w-0 truncate tracking-tight" :title="windowTitle">
        <span class="font-medium text-foreground/90">{{ APP_NAME }}</span><span class="text-muted-foreground"> · {{ appTagline() }}</span>
      </span>
      <span class="shrink-0 text-muted-foreground">›</span>
      <span class="truncate text-muted-foreground">{{ crumb }}</span>
    </div>

    <Tooltip>
      <TooltipTrigger as-child>
        <Button
          variant="ghost"
          size="icon-xs"
          class="no-drag text-muted-foreground"
          @click="ui.toggleSessionList()"
        >
          <PanelLeft class="size-3.5" />
        </Button>
      </TooltipTrigger>
      <TooltipContent>{{ ui.sessionListCollapsed ? t("title.expandList") : t("title.collapseList") }} Ctrl+B</TooltipContent>
    </Tooltip>

    <Tooltip>
      <TooltipTrigger as-child>
        <Button
          variant="ghost"
          size="icon-xs"
          class="no-drag text-muted-foreground"
          @click="importSessions()"
        >
          <Upload class="size-3.5" />
        </Button>
      </TooltipTrigger>
      <TooltipContent>{{ t("title.importAll") }}</TooltipContent>
    </Tooltip>

    <Tooltip>
      <TooltipTrigger as-child>
        <Button
          variant="ghost"
          size="icon-xs"
          class="no-drag text-muted-foreground"
          @click="exportSessions()"
        >
          <Download class="size-3.5" />
        </Button>
      </TooltipTrigger>
      <TooltipContent>{{ t("title.exportAll") }}</TooltipContent>
    </Tooltip>

    <Tooltip>
      <TooltipTrigger as-child>
        <Button
          variant="ghost"
          size="icon-xs"
          class="no-drag text-muted-foreground"
          @click="ui.setTheme(ui.settings.theme === 'light' ? 'dark' : 'light')"
        >
          <Sun v-if="ui.settings.theme === 'dark'" class="size-3.5" />
          <Moon v-else class="size-3.5" />
        </Button>
      </TooltipTrigger>
      <TooltipContent>{{ ui.settings.theme === 'dark' ? t("title.light") : t("title.dark") }}</TooltipContent>
    </Tooltip>

    <DropdownMenu>
      <DropdownMenuTrigger as-child>
        <Button
          variant="ghost"
          size="icon-xs"
          class="no-drag w-7 text-[11px] font-medium text-muted-foreground"
          :title="t('locale.language')"
        >
          {{ localeMark }}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" class="min-w-28">
        <DropdownMenuItem
          :class="ui.settings.locale === 'system' ? 'text-foreground' : ''"
          @click="pickLocale('system')"
        >
          {{ t("locale.system") }}
        </DropdownMenuItem>
        <DropdownMenuItem
          :class="ui.settings.locale === 'zh' ? 'text-foreground' : ''"
          @click="pickLocale('zh')"
        >
          {{ t("locale.zh") }}
        </DropdownMenuItem>
        <DropdownMenuItem
          :class="ui.settings.locale === 'en' ? 'text-foreground' : ''"
          @click="pickLocale('en')"
        >
          {{ t("locale.en") }}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>

    <Tooltip>
      <TooltipTrigger as-child>
        <Button
          variant="ghost"
          size="icon-xs"
          class="no-drag text-muted-foreground"
          @click="openHelp"
        >
          <CircleHelp class="size-3.5" />
        </Button>
      </TooltipTrigger>
      <TooltipContent>{{ t("title.guide") }}</TooltipContent>
    </Tooltip>

    <Tooltip>
      <TooltipTrigger as-child>
        <Button
          variant="ghost"
          size="icon-xs"
          class="no-drag text-muted-foreground"
          @click="openAbout"
        >
          <Info class="size-3.5" />
        </Button>
      </TooltipTrigger>
      <TooltipContent>{{ t("title.about") }}</TooltipContent>
    </Tooltip>

    <button
      class="no-drag mr-1 flex h-7 items-center gap-2 rounded-md border border-border bg-bg-2/80 px-2.5 text-xs text-muted-foreground transition-colors duration-150 hover:border-foreground/15 hover:text-foreground"
      @click="ui.commandOpen = true"
    >
      <span>{{ t("title.search") }}</span>
      <kbd class="rounded bg-foreground/6 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">Ctrl+K</kbd>
    </button>

    <div v-if="!isMac" class="no-drag ml-1 flex items-center">
      <Tooltip>
        <TooltipTrigger as-child>
          <Button variant="ghost" size="icon-sm" class="text-muted-foreground" @click="minimize">
            <Minus class="size-3.5" />
          </Button>
        </TooltipTrigger>
            <TooltipContent>{{ t("title.minimize") }}</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger as-child>
          <Button variant="ghost" size="icon-sm" class="text-muted-foreground" @click="toggleMax">
            <Copy v-if="maximized" class="size-3.5" />
            <Square v-else class="size-3.5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>{{ maximized ? t("title.restore") : t("title.maximize") }}</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger as-child>
          <Button
            variant="ghost"
            size="icon-sm"
            class="text-muted-foreground hover:bg-err/20 hover:text-err"
            @click="close"
          >
            <X class="size-3.5" />
          </Button>
        </TooltipTrigger>
            <TooltipContent>{{ t("title.closeTray") }}</TooltipContent>
      </Tooltip>
    </div>
  </header>
</template>
