import { defineStore } from "pinia";
import { reactive, ref } from "vue";
import { toast } from "vue-sonner";
import { errorMessage, invokeAiChat, invokeAiStop, isTauri } from "@/lib/ipc";
import { t } from "@/i18n";
import type { AiConfig } from "@/types";

export interface AiChatMessage {
  role: "user" | "assistant";
  content: string;
}

interface AiChat {
  messages: AiChatMessage[];
  draft: string;
}

const CAP = 80;

export const useAiStore = defineStore("ai", () => {
  const chats = reactive<Record<string, AiChat>>({});
  const streamingId = ref<string | null>(null);
  let leftover: AiChatMessage[] | null = null;
  let unlisten: Array<() => void> = [];
  let bound = false;

  function of(id: string): AiChat {
    if (!chats[id]) chats[id] = { messages: [], draft: "" };
    return chats[id];
  }

  function messagesOf(id: string): AiChatMessage[] {
    return of(id).messages.filter((m) => m.content.trim());
  }

  function hydrateSession(id: string, list: AiChatMessage[] | undefined) {
    of(id).messages = (list ?? [])
      .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
      .slice(-CAP);
  }

  function hydrate(list: AiChatMessage[]) {
    leftover = list.slice(-CAP);
  }

  function hydrateMap(map: Record<string, { role: string; content: string }[]>) {
    for (const [id, list] of Object.entries(map)) {
      if (!id || !Array.isArray(list)) continue;
      if (of(id).messages.length) continue;
      hydrateSession(id, list as AiChatMessage[]);
    }
  }

  function claimLegacy(id: string) {
    if (!leftover?.length || of(id).messages.length) return;
    of(id).messages = leftover.slice(-CAP);
    leftover = null;
  }

  function snapshot(): Record<string, AiChatMessage[]> {
    const out: Record<string, AiChatMessage[]> = {};
    for (const [id, chat] of Object.entries(chats)) {
      const msgs = chat.messages.filter((m) => m.content.trim());
      if (msgs.length) out[id] = msgs;
    }
    return out;
  }

  function drop(id: string) {
    if (streamingId.value === id) void stop();
    delete chats[id];
  }

  function clear(id: string) {
    of(id).messages = [];
  }

  async function bind() {
    if (bound || !isTauri()) return;
    bound = true;
    const { listen } = await import("@tauri-apps/api/event");
    unlisten.push(
      await listen<{ sessionId?: string; text: string }>("ai:delta", (event) => {
        const id = event.payload.sessionId;
        if (!id) return;
        const msgs = of(id).messages;
        const last = msgs[msgs.length - 1];
        if (!last || last.role !== "assistant") return;
        last.content += event.payload.text ?? "";
      }),
    );
    unlisten.push(
      await listen<{ sessionId?: string; error?: string | null; stopped?: boolean }>(
        "ai:done",
        (event) => {
          const id = event.payload.sessionId;
          if (!id) return;
          if (streamingId.value === id) streamingId.value = null;
          const msgs = of(id).messages;
          const last = msgs[msgs.length - 1];
          if (last?.role === "assistant" && !last.content.trim() && !event.payload.stopped) {
            of(id).messages.pop();
          }
        },
      ),
    );
  }

  function unbind() {
    for (const stop of unlisten) stop();
    unlisten = [];
    bound = false;
  }

  async function send(sessionId: string, config: AiConfig) {
    const chat = of(sessionId);
    const text = chat.draft.trim();
    if (!text) return;
    if (streamingId.value === sessionId) return;
    if (!config.baseUrl.trim()) {
      toast.error(t("err.missing_url"));
      return;
    }
    if (!config.model.trim()) {
      toast.error(t("err.missing_model"));
      return;
    }
    if (!isTauri()) {
      toast.error(t("err.needDesktop"));
      return;
    }
    chat.draft = "";
    chat.messages.push({ role: "user", content: text });
    const payload = chat.messages.filter((m) => m.content.trim());
    chat.messages.push({ role: "assistant", content: "" });
    if (chat.messages.length > CAP) {
      chat.messages.splice(0, chat.messages.length - CAP);
    }
    streamingId.value = sessionId;
    try {
      await invokeAiChat({
        sessionId,
        baseUrl: config.baseUrl.trim(),
        apiKey: config.apiKey,
        model: config.model.trim(),
        messages: payload,
      });
    } catch (err) {
      toast.error(errorMessage(err));
      const last = chat.messages[chat.messages.length - 1];
      if (last?.role === "assistant" && !last.content.trim()) chat.messages.pop();
    } finally {
      if (streamingId.value === sessionId) streamingId.value = null;
    }
  }

  async function stop() {
    if (!streamingId.value) return;
    await invokeAiStop();
  }

  return {
    chats,
    streamingId,
    of,
    messagesOf,
    hydrateSession,
    hydrate,
    hydrateMap,
    claimLegacy,
    snapshot,
    drop,
    clear,
    bind,
    unbind,
    send,
    stop,
  };
});
