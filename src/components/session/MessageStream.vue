<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { Inbox } from "@lucide/vue";
import { t } from "@/i18n";
import { useSessionsStore } from "@/stores/sessions";
import MessageCard from "@/components/session/MessageCard.vue";

const sessions = useSessionsStore();
const scroller = ref<HTMLElement | null>(null);

const list = computed(() => sessions.visibleMessages);
const emptyAll = computed(() => sessions.activeMessages.length === 0);

async function scrollIfNeeded() {
  const id = sessions.activeId;
  if (!id || !sessions.autoScroll[id]) return;
  await nextTick();
  const el = scroller.value;
  if (!el) return;
  el.scrollTop = el.scrollHeight;
}

function onScroll() {
  const id = sessions.activeId;
  const el = scroller.value;
  if (!id || !el) return;
  const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
  sessions.setAutoScroll(id, nearBottom);
}

watch(
  () => list.value.length,
  () => {
    void scrollIfNeeded();
  },
);
</script>

<template>
  <div
    v-if="list.length === 0"
    class="flex h-full flex-col items-center justify-center text-muted-foreground"
  >
    <Inbox class="mb-3 size-8 opacity-40" />
    <p class="text-sm">{{ emptyAll ? t("stream.wait") : t("stream.noTopic") }}</p>
  </div>
  <div
    v-else
    ref="scroller"
    class="h-full space-y-2 overflow-auto px-3 py-3"
    @scroll="onScroll"
  >
    <MessageCard
      v-for="message in list"
      :key="message.id"
      :message="message"
      :mode="sessions.displayMode[message.sessionId] ?? 'hex'"
      :selected="sessions.isSelected(message.sessionId, message.id)"
      @select="sessions.selectMessage(message.sessionId, message.id, $event)"
    />
  </div>
</template>
