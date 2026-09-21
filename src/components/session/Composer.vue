<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from "vue";
import { History, Repeat, Send, ShieldCheck } from "@lucide/vue";
import { toast } from "vue-sonner";
import { appendCrc16Modbus } from "@/lib/checksum";
import { pendingComposerInsert } from "@/lib/composer-insert";
import { t } from "@/i18n";
import { bytesToHex, hexLooksIllegal, hexToBytes, isValidHex, textToBytes } from "@/lib/hex";
import { useSessionsStore } from "@/stores/sessions";
import type { DataMode } from "@/types";
import PayloadField from "@/components/common/PayloadField.vue";
import AppSelect from "@/components/common/AppSelect.vue";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

const sessions = useSessionsStore();
const loopOn = ref(false);
const loopMs = ref(1000);
const checksumOn = ref(false);
let loopTimer = 0;

const draft = computed({
  get: () => (sessions.activeId ? sessions.composerOf(sessions.activeId).draft : ""),
  set: (value: string) => {
    if (sessions.activeId) sessions.composerOf(sessions.activeId).draft = value;
  },
});
const mode = computed({
  get: () => (sessions.activeId ? sessions.composerOf(sessions.activeId).mode : "hex"),
  set: (value: DataMode) => {
    if (sessions.activeId) sessions.composerOf(sessions.activeId).mode = value;
  },
});
const mqttTopic = computed({
  get: () => mqtt.value?.publishTopic ?? "test",
  set: (value: string) => {
    if (sessions.activeId && mqtt.value) {
      sessions.updateConfig(sessions.activeId, { publishTopic: value });
    }
  },
});
const mqttQos = computed({
  get: () => mqtt.value?.publishQos ?? 0,
  set: (value: 0 | 1 | 2) => {
    if (sessions.activeId && mqtt.value) {
      sessions.updateConfig(sessions.activeId, { publishQos: value });
    }
  },
});

const mqtt = computed(() =>
  sessions.activeSession?.config.kind === "mqtt" ? sessions.activeSession.config : null,
);

const illegal = computed(
  () => mode.value === "hex" && hexLooksIllegal(draft.value),
);
const canSend = computed(() => {
  if (!draft.value.trim()) return false;
  if (mode.value === "hex") return isValidHex(draft.value);
  return true;
});

watch(
  () => sessions.activeId,
  () => stopLoop(),
);

watch(
  () => (sessions.activeId ? sessions.topicFilter[sessions.activeId] : ""),
  (filter) => {
    if (!mqtt.value || !filter) return;
    if (filter.includes("#") || filter.includes("+")) return;
    mqttTopic.value = filter;
  },
);

watch(
  pendingComposerInsert,
  (item) => {
    if (!item) return;
    draft.value = item.content;
    mode.value = item.mode;
    pendingComposerInsert.value = null;
  },
  { immediate: true },
);

function payload() {
  if (!checksumOn.value) return { content: draft.value, mode: mode.value };
  const bytes = mode.value === "hex" ? hexToBytes(draft.value) : textToBytes(draft.value);
  return { content: bytesToHex(appendCrc16Modbus(bytes)), mode: "hex" as const };
}

async function send() {
  if (!sessions.activeId || !canSend.value) return false;
  if (sessions.sending[sessions.activeId]) return false;
  const next = payload();
  return sessions.sendToSession(
    sessions.activeId,
    next.content,
    next.mode,
    mqtt.value
      ? { mqttTopic: mqttTopic.value, mqttQos: mqttQos.value }
      : undefined,
  );
}

function stopLoop() {
  loopOn.value = false;
  window.clearInterval(loopTimer);
  loopTimer = 0;
}

function startLoop() {
  window.clearInterval(loopTimer);
  const tick = async () => {
    const ok = await send();
    if (!ok) stopLoop();
  };
  void tick();
  loopTimer = window.setInterval(() => {
    void tick();
  }, Math.max(50, Number(loopMs.value) || 1000));
}

watch(loopOn, (on) => {
  if (!on) {
    window.clearInterval(loopTimer);
    loopTimer = 0;
    return;
  }
  if (!canSend.value || sessions.activeSession?.status !== "connected") {
    loopOn.value = false;
    if (!canSend.value) toast.message(t("composer.empty"));
    else toast.error(t("err.notConnected"));
    return;
  }
  startLoop();
});

watch(loopMs, () => {
  if (loopOn.value) startLoop();
});

watch(
  () => [sessions.activeId, sessions.activeSession?.status] as const,
  () => {
    if (sessions.activeSession?.status !== "connected") stopLoop();
  },
);

onUnmounted(stopLoop);

function onKeydown(e: KeyboardEvent) {
  if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
    e.preventDefault();
    void send();
  }
}
</script>

<template>
  <div class="border-t border-border bg-bg-1/50 p-3">
    <div v-if="mqtt || illegal || checksumOn" class="mb-2 flex flex-wrap items-center gap-2">
      <template v-if="mqtt">
        <Input
          v-model="mqttTopic"
          class="h-7 w-44 text-xs"
          :placeholder="t('composer.topic')"
        />
        <AppSelect
          :model-value="mqttQos"
          :options="[
            { value: 0, label: 'QoS 0' },
            { value: 1, label: 'QoS 1' },
            { value: 2, label: 'QoS 2' },
          ]"
          class="w-[88px]"
          @update:model-value="mqttQos = Number($event) as 0 | 1 | 2"
        />
      </template>
      <span v-if="illegal" class="text-[11px] text-err">{{ t("composer.badHex") }}</span>
      <span v-else-if="checksumOn" class="text-[11px] text-muted-foreground">{{ t("composer.crc") }}</span>
    </div>

    <PayloadField
      v-model="draft"
      v-model:mode="mode"
      :invalid="illegal"
      :placeholder="mode === 'hex' ? '01 03 00 00 00 01' : t('composer.text')"
      @keydown="onKeydown"
    />

    <div class="mt-2 flex items-center gap-1">
      <DropdownMenu>
        <DropdownMenuTrigger as-child>
          <Button variant="outline" size="sm" class="text-muted-foreground">
            <History class="size-3.5" />
            {{ t("common.history") }}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" class="min-w-64">
          <div v-if="sessions.history.length === 0" class="px-2 py-3 text-xs text-muted-foreground">
            {{ t("composer.noHistory") }}
          </div>
          <DropdownMenuItem
            v-for="item in sessions.history.slice(0, 10)"
            :key="item.id"
            class="font-mono text-xs"
            @click="draft = item.content; mode = item.mode"
          >
            {{ item.content }}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <Button
        variant="outline"
        size="sm"
        :class="loopOn ? 'text-primary' : 'text-muted-foreground'"
        @click="loopOn = !loopOn"
      >
        <Repeat class="size-3.5" />
        {{ t("composer.loop") }}
      </Button>
      <Input
        v-if="loopOn"
        v-model="loopMs"
        class="h-7 w-20 text-xs"
        :title="t('composer.interval')"
      />
      <Button
        variant="outline"
        size="sm"
        :class="checksumOn ? 'text-primary' : 'text-muted-foreground'"
        @click="checksumOn = !checksumOn"
      >
        <ShieldCheck class="size-3.5" />
        {{ t("composer.checksum") }}
      </Button>
      <Button
        class="ml-auto"
        size="sm"
        :disabled="!canSend || sessions.activeSession?.status !== 'connected' || Boolean(sessions.activeId && sessions.sending[sessions.activeId])"
        @click="send"
      >
        <Send class="size-3.5" />
        {{ t("common.send") }}
        <kbd class="ml-1 font-mono text-[10px] opacity-70">Ctrl+Enter</kbd>
      </Button>
    </div>
  </div>
</template>
