import { computed, ref } from "vue";
import { defineStore } from "pinia";
import type { AppSettings, LocalePref, RailId, SshAnsiTheme } from "@/types";
import type { ModbusPoint } from "@/lib/point-table";
import { setLocalePref } from "@/i18n";

export function sshThemeFor(theme: AppSettings["theme"]): SshAnsiTheme {
  return theme === "light" ? "light" : "tango";
}

export function applyTheme(theme: AppSettings["theme"]) {
  const light = theme === "light";
  const root = document.documentElement;
  root.classList.toggle("dark", !light);
  root.classList.toggle("light", light);
  document.body.classList.toggle("dark", !light);
  document.body.classList.toggle("light", light);
  root.style.colorScheme = light ? "light" : "dark";
}

export const useUiStore = defineStore("ui", () => {
  const rail = ref<RailId>("serial");
  const sessionListCollapsed = ref(false);
  const toolPanelCollapsed = ref(false);
  const commandOpen = ref(false);
  const helpOpen = ref(false);
  const aboutOpen = ref(false);
  const pendingCloseId = ref<string | null>(null);
  const modbusPoints = ref<ModbusPoint[]>([]);
  const settings = ref<AppSettings>({
    theme: "dark",
    locale: "system",
    startup: "restore",
    logLimit: 10000,
    defaultEncoding: "utf8",
    httpTimeoutMs: 30000,
    sshAnsiTheme: "tango",
    sshScrollback: 5000,
    sshAutoReconnect: false,
    sshReconnectMs: 3000,
    sshEditMaxMb: 2,
    ftpFileView: "list",
    aiBaseUrl: "",
    aiApiKey: "",
    aiModel: "",
  });

  const isChromeView = computed(
    () => rail.value === "tools" || rail.value === "settings" || rail.value === "modbus",
  );

  function setRail(next: RailId) {
    rail.value = next;
  }

  function toggleSessionList() {
    sessionListCollapsed.value = !sessionListCollapsed.value;
  }

  function toggleToolPanel() {
    toolPanelCollapsed.value = !toolPanelCollapsed.value;
  }

  function setTheme(theme: AppSettings["theme"]) {
    settings.value.theme = theme;
    settings.value.sshAnsiTheme = sshThemeFor(theme);
    applyTheme(theme);
  }

  function setLocale(next: LocalePref) {
    settings.value.locale = next;
    setLocalePref(next);
  }

  return {
    rail,
    sessionListCollapsed,
    toolPanelCollapsed,
    commandOpen,
    helpOpen,
    aboutOpen,
    pendingCloseId,
    modbusPoints,
    settings,
    isChromeView,
    setRail,
    setTheme,
    setLocale,
    toggleSessionList,
    toggleToolPanel,
  };
});
