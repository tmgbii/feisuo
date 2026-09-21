<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { Pause, Pencil, Play, Plus, Trash2, X } from "@lucide/vue";
import type { Session } from "@/types";
import { useSessionsStore } from "@/stores/sessions";
import AppSelect from "@/components/common/AppSelect.vue";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { t } from "@/i18n";
import { cn } from "@/lib/utils";

const props = defineProps<{ session: Session }>();
const sessions = useSessionsStore();

const topic = ref("");
const qos = ref<0 | 1 | 2>(0);
const editingFrom = ref<string | null>(null);
const entries = computed(() => sessions.mqttTopicEntries(props.session.id));
const filter = computed(() => sessions.topicFilter[props.session.id] ?? "");
const allCount = computed(
  () => (sessions.messages[props.session.id] ?? []).filter((m) => m.topic).length,
);

watch(
  () => props.session.id,
  () => {
    topic.value = "";
    qos.value = 0;
    editingFrom.value = null;
  },
);

function subscribe() {
  void sessions.subscribeMqtt(props.session.id, topic.value, qos.value);
}

function startEdit(entry: { topic: string; qos?: 0 | 1 | 2 }) {
  editingFrom.value = entry.topic;
  topic.value = entry.topic;
  qos.value = entry.qos ?? 0;
}

function cancelEdit() {
  editingFrom.value = null;
  topic.value = "";
  qos.value = 0;
}

function submit() {
  if (editingFrom.value) {
    void sessions.replaceMqttSub(props.session.id, editingFrom.value, topic.value, qos.value);
    cancelEdit();
    return;
  }
  subscribe();
}

function select(next: string) {
  sessions.setTopicFilter(props.session.id, next);
}
</script>

<template>
  <aside class="flex w-56 shrink-0 flex-col border-r border-border bg-bg-1/30">
    <div class="space-y-2 border-b border-border p-2">
      <Input
        v-model="topic"
        class="h-7 text-xs"
        placeholder="sensor/#"
        @keydown.enter.prevent="submit"
        @keydown.escape.prevent="cancelEdit"
      />
      <div class="flex gap-1">
        <AppSelect
          :model-value="qos"
          :options="[
            { value: 0, label: 'QoS 0' },
            { value: 1, label: 'QoS 1' },
            { value: 2, label: 'QoS 2' },
          ]"
          class="w-[88px]"
          @update:model-value="qos = Number($event) as 0 | 1 | 2"
        />
        <Button
          size="xs"
          class="flex-1"
          :disabled="!topic.trim()"
          @click="submit"
        >
          <Plus v-if="!editingFrom" class="size-3.5" />
          {{ editingFrom ? t("common.save") : t("mqtt.sub") }}
        </Button>
        <Button
          v-if="editingFrom"
          size="icon-xs"
          variant="ghost"
          :title="t('common.cancel')"
          @click="cancelEdit"
        >
          <X class="size-3.5" />
        </Button>
      </div>
    </div>

    <ScrollArea class="min-h-0 flex-1">
      <div class="space-y-0.5 p-1.5">
        <button
          type="button"
          :class="cn(
            'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs',
            filter === '' ? 'bg-primary/12 text-foreground' : 'text-muted-foreground hover:bg-foreground/5',
          )"
          @click="select('')"
        >
          <span class="size-2 rounded-full bg-foreground/40" />
          <span class="min-w-0 flex-1 truncate">{{ t("mqtt.all") }}</span>
          <span class="font-mono text-[10px] opacity-70">{{ allCount }}</span>
        </button>

        <div
          v-if="entries.length === 0"
          class="px-2 py-6 text-center text-[11px] text-muted-foreground"
        >
          {{ t("mqtt.hint") }}
        </div>

        <div
          v-for="entry in entries"
          :key="entry.topic"
          :class="cn(
            'group flex items-center gap-1 rounded-md px-1 py-0.5',
            editingFrom === entry.topic || filter === entry.topic ? 'bg-primary/12' : 'hover:bg-foreground/5',
            entry.enabled ? '' : 'opacity-50',
          )"
        >
          <button
            type="button"
            class="flex min-w-0 flex-1 items-center gap-2 px-1 py-1 text-left text-xs"
            @click="select(entry.topic)"
            @dblclick="entry.isSub && startEdit(entry)"
          >
            <span class="size-2 shrink-0 rounded-full" :style="{ background: entry.color }" />
            <span class="min-w-0 flex-1 truncate font-mono" :title="entry.topic">{{ entry.topic }}</span>
            <span v-if="entry.isSub" class="text-[10px] text-muted-foreground">q{{ entry.qos }}</span>
            <span class="font-mono text-[10px] text-muted-foreground">{{ entry.count }}</span>
          </button>
          <Button
            v-if="entry.isSub"
            variant="ghost"
            size="icon-xs"
            class="size-6 shrink-0 text-muted-foreground"
            :title="t('common.edit')"
            @click="startEdit(entry)"
          >
            <Pencil class="size-3" />
          </Button>
          <Button
            variant="ghost"
            size="icon-xs"
            class="size-6 shrink-0 text-muted-foreground"
            :title="entry.enabled ? t('mqtt.disable') : t('mqtt.enable')"
            @click="sessions.toggleMqttTopic(session.id, entry.topic)"
          >
            <Pause v-if="entry.enabled" class="size-3" />
            <Play v-else class="size-3" />
          </Button>
          <Button
            v-if="entry.isSub"
            variant="ghost"
            size="icon-xs"
            class="size-6 shrink-0 text-muted-foreground hover:text-err"
            :title="t('mqtt.unsub')"
            @click="sessions.unsubscribeMqtt(session.id, entry.topic)"
          >
            <Trash2 class="size-3" />
          </Button>
        </div>
      </div>
    </ScrollArea>
  </aside>
</template>
