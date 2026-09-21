<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { Eraser, Send, Settings2 } from "@lucide/vue";
import type { Session } from "@/types";
import { t } from "@/i18n";
import { useAiStore } from "@/stores/ai";
import { useSessionsStore } from "@/stores/sessions";
import { useUiStore } from "@/stores/ui";
import PageHelp from "@/components/common/PageHelp.vue";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

const props = defineProps<{ session: Session }>();

const ai = useAiStore();
const sessions = useSessionsStore();
const ui = useUiStore();
const scroller = ref<HTMLElement | null>(null);

const cfg = computed(() => (props.session.config.kind === "ai" ? props.session.config : null));
const chat = computed(() => ai.of(props.session.id));
const streaming = computed(() => ai.streamingId === props.session.id);
const modelLabel = computed(() => cfg.value?.model.trim() || t("bar.notConfigured"));
const showSetup = ref(true);

watch(
  () => props.session.id,
  () => {
    const c = cfg.value;
    showSetup.value = !c?.baseUrl.trim() || !c.model.trim();
  },
  { immediate: true },
);

watch(
  () => {
    const last = chat.value.messages[chat.value.messages.length - 1];
    return `${props.session.id}:${chat.value.messages.length}:${last?.content.length ?? 0}`;
  },
  async () => {
    await nextTick();
    const el = scroller.value;
    if (el) el.scrollTop = el.scrollHeight;
  },
);

function patch(key: "baseUrl" | "apiKey" | "model", value: string) {
  sessions.updateConfig(props.session.id, { [key]: value });
  if (key === "baseUrl") ui.settings.aiBaseUrl = value;
  if (key === "apiKey") ui.settings.aiApiKey = value;
  if (key === "model") ui.settings.aiModel = value;
}

function onKey(e: KeyboardEvent) {
  if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
    e.preventDefault();
    if (streaming.value || !cfg.value) return;
    void ai.send(props.session.id, cfg.value);
  }
}
</script>

<template>
  <div v-if="cfg" class="flex h-full min-h-0 flex-col">
    <div class="flex h-11 shrink-0 items-center gap-2 border-b border-border px-4">
      <div class="min-w-0 flex-1">
        <div class="truncate text-[13px] font-medium tracking-tight">{{ session.name }}</div>
        <div class="truncate font-mono text-[11px] text-muted-foreground">{{ modelLabel }}</div>
      </div>
      <PageHelp page="ai" />
      <Button
        size="sm"
        variant="outline"
        class="text-muted-foreground"
        :class="showSetup ? 'text-foreground' : ''"
        :title="t('ai.endpoint')"
        @click="showSetup = !showSetup"
      >
        <Settings2 class="size-3.5" />
        {{ t("ai.endpoint") }}
      </Button>
      <Button
        size="sm"
        variant="outline"
        class="text-muted-foreground"
        :disabled="!chat.messages.length"
        @click="ai.clear(session.id)"
      >
        <Eraser class="size-3.5" />
        {{ t("common.clear") }}
      </Button>
    </div>

    <div v-if="showSetup" class="grid shrink-0 grid-cols-[1fr_10rem_10rem] gap-2 border-b border-border px-4 py-3">
      <label class="min-w-0 space-y-1">
        <span class="text-[11px] text-muted-foreground">{{ t("ai.endpoint") }}</span>
        <Input
          :model-value="cfg.baseUrl"
          class="h-8 font-mono text-xs"
          placeholder="http://127.0.0.1:11434/v1"
          @update:model-value="patch('baseUrl', String($event))"
        />
      </label>
      <label class="space-y-1">
        <span class="text-[11px] text-muted-foreground">{{ t("ai.model") }}</span>
        <Input
          :model-value="cfg.model"
          class="h-8 font-mono text-xs"
          placeholder="qwen2.5"
          @update:model-value="patch('model', String($event))"
        />
      </label>
      <label class="space-y-1">
        <span class="text-[11px] text-muted-foreground">{{ t("ai.key") }}</span>
        <Input
          :model-value="cfg.apiKey"
          class="h-8 font-mono text-xs"
          type="password"
          :placeholder="t('ai.keyPh')"
          @update:model-value="patch('apiKey', String($event))"
        />
      </label>
    </div>

    <div ref="scroller" class="min-h-0 flex-1 overflow-auto px-6 py-5">
      <div v-if="!chat.messages.length" class="flex h-full items-center justify-center">
        <p class="text-[13px] text-muted-foreground">{{ t("ai.empty") }}</p>
      </div>
      <div v-else class="mx-auto flex max-w-3xl flex-col gap-4">
        <div
          v-for="(msg, i) in chat.messages"
          :key="i"
          class="flex"
          :class="msg.role === 'user' ? 'justify-end' : 'justify-start'"
        >
          <div
            class="max-w-[78%] rounded-2xl px-3.5 py-2.5"
            :class="
              msg.role === 'user'
                ? 'rounded-br-md bg-primary/15 text-foreground'
                : 'rounded-bl-md bg-muted text-foreground'
            "
          >
            <div class="mb-1 text-[10px] tracking-wide text-muted-foreground">
              {{ msg.role === "user" ? t("ai.you") : t("ai.assistant") }}
            </div>
            <div class="selectable text-[13px] leading-6 whitespace-pre-wrap">
              {{
                msg.content ||
                (streaming && i === chat.messages.length - 1 ? "…" : "")
              }}
            </div>
          </div>
        </div>
      </div>
    </div>

    <div class="border-t border-border bg-bg-1/50 p-3">
      <Textarea
        :model-value="chat.draft"
        class="selectable min-h-20 resize-none font-mono text-[13px]"
        :placeholder="t('ai.text')"
        @update:model-value="chat.draft = String($event)"
        @keydown="onKey"
      />
      <div class="mt-2 flex items-center gap-1">
        <Button
          v-if="streaming"
          class="ml-auto"
          size="sm"
          variant="outline"
          @click="ai.stop"
        >
          {{ t("common.stop") }}
        </Button>
        <Button
          v-else
          class="ml-auto"
          size="sm"
          :disabled="!chat.draft.trim()"
          @click="ai.send(session.id, cfg)"
        >
          <Send class="size-3.5" />
          {{ t("common.send") }}
          <kbd class="ml-1 font-mono text-[10px] opacity-70">Ctrl+Enter</kbd>
        </Button>
      </div>
    </div>
  </div>
</template>
