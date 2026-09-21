<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { Plus, X } from "@lucide/vue";
import { t } from "@/i18n";
import type { Session } from "@/types";
import { useSessionsStore } from "@/stores/sessions";
import AppSelect from "@/components/common/AppSelect.vue";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";

const props = defineProps<{ session: Session }>();
const sessions = useSessionsStore();

const topic = ref("");
const qos = ref<0 | 1 | 2>(0);
const subs = computed(() => sessions.mqttSubs[props.session.id] ?? []);

watch(
  () => props.session.id,
  () => {
    topic.value = "";
    qos.value = 0;
  },
);

function subscribe() {
  void sessions.subscribeMqtt(props.session.id, topic.value, qos.value);
}
</script>

<template>
  <div class="flex flex-wrap items-center gap-2 border-b border-border bg-bg-1/25 px-3 py-1.5">
    <Input
      v-model="topic"
      class="h-7 w-44 text-xs"
      placeholder="sensor/#"
      @keydown.enter.prevent="subscribe"
    />
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
    <Button size="xs" :disabled="!topic.trim()" @click="subscribe">
      <Plus class="size-3.5" />
      {{ t("mqtt.sub") }}
    </Button>
    <div v-if="subs.length === 0" class="text-[11px] text-muted-foreground">{{ t("mqtt.none") }}</div>
    <Badge
      v-for="sub in subs"
      :key="sub.topic"
      variant="outline"
      class="gap-1 pr-1 font-mono text-[11px]"
    >
      {{ sub.topic }}
      <span class="text-muted-foreground">q{{ sub.qos }}</span>
      <Button
        variant="ghost"
        size="icon-xs"
        class="size-5 text-muted-foreground hover:text-err"
        :title="t('mqtt.unsub')"
        @click="sessions.unsubscribeMqtt(session.id, sub.topic)"
      >
        <X class="size-3" />
      </Button>
    </Badge>
  </div>
</template>
