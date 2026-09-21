import { ref } from "vue";
import { useUiStore } from "@/stores/ui";
import { useSessionsStore } from "@/stores/sessions";

export type ToolTab = "modbus" | "json" | "history" | "ascii" | "more" | "parse" | "net";

export const toolTab = ref<ToolTab>("modbus");
export const pendingModbusParse = ref<string | null>(null);
export const pendingFrameParse = ref<string | null>(null);
export const jsonSeed = ref("");

function revealTool(tab: ToolTab) {
  const ui = useUiStore();
  const session = useSessionsStore().activeSession;
  toolTab.value = tab;
  if (ui.isChromeView || !session || session.protocol === "http" || session.protocol === "ssh" || session.protocol === "ftp" || session.protocol === "db" || session.protocol === "ai") {
    ui.setRail("tools");
    return;
  }
  ui.toolPanelCollapsed = false;
}

export function sendToModbusParser(hex: string) {
  pendingModbusParse.value = hex;
  revealTool("modbus");
}

export function sendToFrameParser(hex: string) {
  pendingFrameParse.value = hex;
  revealTool("parse");
}

export function openFrameParser() {
  revealTool("parse");
}

export function openJsonTool(text?: string) {
  if (text?.trim()) jsonSeed.value = text.trim();
  revealTool("json");
}

export function openNetWatch() {
  const ui = useUiStore();
  toolTab.value = "net";
  ui.setRail("tools");
}
