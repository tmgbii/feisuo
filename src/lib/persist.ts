import { watch } from "vue";
import { loadAppState, saveAppState } from "@/lib/ipc";
import { PROTOCOL_META } from "@/lib/protocol";
import { setLocalePref } from "@/i18n";
import { useSessionsStore } from "@/stores/sessions";
import { useAiStore } from "@/stores/ai";
import { applyTheme, sshThemeFor, useUiStore } from "@/stores/ui";
import { useModbusLabStore } from "@/stores/modbus-lab";
import { useHostsStore } from "@/stores/hosts";
import { useFrameSchemasStore } from "@/stores/frame-schemas";

let persistReady = false;
let lastGoodSessions: ReturnType<ReturnType<typeof useSessionsStore>["snapshot"]> = [];
let lastGoodActiveId: string | null = null;

function restoreAiChats(data: { aiMessages?: unknown; aiChats?: Record<string, { role: string; content: string }[]> }) {
  const ai = useAiStore();
  if (data.aiChats) ai.hydrateMap(data.aiChats);
  const raw = data.aiMessages;
  if (!raw) return;
  if (Array.isArray(raw) && raw[0] && typeof raw[0] === "object" && "role" in (raw[0] as object)) {
    const sid = useSessionsStore().sessions.find((s) => s.protocol === "ai")?.id;
    const list = raw as { role: "user" | "assistant"; content: string }[];
    if (sid && !ai.messagesOf(sid).length) ai.hydrateSession(sid, list);
    else if (!sid) ai.hydrate(list);
    return;
  }
  if (typeof raw === "object" && !Array.isArray(raw)) {
    ai.hydrateMap(raw as Record<string, { role: "user" | "assistant"; content: string }[]>);
  }
}

export async function restoreApp() {
  try {
    const raw = await loadAppState();
    if (!raw) return;
    const data = JSON.parse(raw) as {
      settings?: Partial<ReturnType<typeof useUiStore>["settings"]>;
      sessions?: ReturnType<ReturnType<typeof useSessionsStore>["snapshot"]>;
      activeId?: string | null;
      rail?: ReturnType<typeof useUiStore>["rail"];
      modbusPoints?: ReturnType<typeof useUiStore>["modbusPoints"];
      history?: ReturnType<typeof useSessionsStore>["history"];
      modbusLab?: ReturnType<ReturnType<typeof useModbusLabStore>["snapshot"]>;
      aiMessages?: unknown;
      aiChats?: ReturnType<ReturnType<typeof useAiStore>["snapshot"]>;
      sshHosts?: ReturnType<ReturnType<typeof useHostsStore>["snapshot"]>;
      frameSchemas?: ReturnType<ReturnType<typeof useFrameSchemasStore>["snapshot"]>;
    };
    const ui = useUiStore();
    if (data.settings) {
      Object.assign(ui.settings, data.settings);
      ui.settings.sshScrollback = ui.settings.sshScrollback || 5000;
      ui.settings.sshReconnectMs = ui.settings.sshReconnectMs || 3000;
      ui.settings.sshEditMaxMb = ui.settings.sshEditMaxMb || 2;
      ui.settings.ftpFileView = ui.settings.ftpFileView === "icons" ? "icons" : "list";
      ui.settings.sshAutoReconnect = ui.settings.sshAutoReconnect === true;
      ui.settings.aiBaseUrl = ui.settings.aiBaseUrl || "";
      ui.settings.aiApiKey = ui.settings.aiApiKey || "";
      ui.settings.aiModel = ui.settings.aiModel || "";
      const loc = ui.settings.locale;
      ui.settings.locale = loc === "zh" || loc === "en" ? loc : "system";
      setLocalePref(ui.settings.locale);
    } else {
      setLocalePref("system");
    }
    if (ui.settings.theme !== "light") ui.settings.theme = "dark";
    ui.settings.sshAnsiTheme = sshThemeFor(ui.settings.theme);
    applyTheme(ui.settings.theme);
    if (data.modbusPoints?.length) {
      ui.modbusPoints = data.modbusPoints.map((p) =>
        (p.type as string) === "bcd16" ? { ...p, type: "bcd32" } : p,
      );
    }
    if (data.modbusLab) useModbusLabStore().hydrate(data.modbusLab);
    if (data.sshHosts?.length) useHostsStore().hydrate(data.sshHosts);
    if (data.sessions?.length) {
      lastGoodSessions = data.sessions;
      lastGoodActiveId = data.activeId ?? null;
    }
    if (data.frameSchemas?.length) useFrameSchemasStore().hydrate(data.frameSchemas);
    if (ui.settings.startup === "restore" && data.sessions?.length) {
      const sessions = useSessionsStore();
      sessions.hydrate(data.sessions, data.activeId ?? null, data.history);
      const rail = data.rail as string | undefined;
      if (
        rail === "serial" ||
        rail === "network" ||
        rail === "mqtt" ||
        rail === "http" ||
        rail === "ssh" ||
        rail === "ftp" ||
        rail === "db" ||
        rail === "ai"
      ) {
        sessions.activateRail(rail);
      } else if (rail === "modbus" || rail === "tools" || rail === "settings") {
        ui.setRail(rail);
      } else {
        const active = sessions.activeSession;
        if (active) ui.setRail(PROTOCOL_META[active.protocol].rail);
      }
    } else if ((data.rail as string | undefined) === "modbus") {
      ui.setRail("modbus");
    } else if ((data.rail as string | undefined) === "ai") {
      useSessionsStore().activateRail("ai");
    } else if ((data.rail as string | undefined) === "ssh") {
      ui.setRail("ssh");
    } else if ((data.rail as string | undefined) === "ftp") {
      ui.setRail("ftp");
    } else if ((data.rail as string | undefined) === "db") {
      ui.setRail("db");
    }
    restoreAiChats(data);
  } catch {
    /* ignore broken state */
  } finally {
    persistReady = true;
  }
}

export function watchPersist() {
  const ui = useUiStore();
  const sessions = useSessionsStore();
  const lab = useModbusLabStore();
  const ai = useAiStore();
  const hosts = useHostsStore();
  const frames = useFrameSchemasStore();
  let timer = 0;
  const flush = () => {
    if (!persistReady) return;
    window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      const list = sessions.snapshot();
      if (list.length > 0) {
        lastGoodSessions = list;
        lastGoodActiveId = sessions.activeId;
      }
      void saveAppState(
        JSON.stringify({
          settings: ui.settings,
          sessions: list.length > 0 ? list : lastGoodSessions,
          activeId: list.length > 0 ? sessions.activeId : lastGoodActiveId,
          rail: ui.rail,
          modbusPoints: ui.modbusPoints,
          history: sessions.history,
          modbusLab: lab.snapshot(),
          aiChats: ai.snapshot(),
          sshHosts: hosts.snapshot(),
          frameSchemas: frames.snapshot(),
        }),
      );
    }, 400);
  };
  watch(
    () =>
      JSON.stringify({
        settings: ui.settings,
        sessions: sessions.snapshot(),
        activeId: sessions.activeId,
        rail: ui.rail,
        modbusPoints: ui.modbusPoints,
        history: sessions.history,
        modbusLab: lab.snapshot(),
        aiChats: ai.snapshot(),
        sshHosts: hosts.snapshot(),
        frameSchemas: frames.snapshot(),
      }),
    flush,
  );
}
