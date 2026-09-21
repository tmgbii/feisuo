<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { Copy, RotateCcw, ScanSearch, ScanText } from "@lucide/vue";
import { toast } from "vue-sonner";
import { t } from "@/i18n";
import type { DataMode, LogMessage } from "@/types";
import { formatClock } from "@/lib/format";
import { payloadFromMode } from "@/lib/radix";
import { sendToFrameParser, sendToModbusParser } from "@/lib/tool-bridge";
import { useSessionsStore } from "@/stores/sessions";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import RadixToggle from "@/components/common/RadixToggle.vue";

const props = defineProps<{
  message: LogMessage;
  mode: DataMode;
  selected?: boolean;
}>();

const emit = defineEmits<{
  select: [shift: boolean];
}>();

const sessions = useSessionsStore();
const view = ref<DataMode>(props.mode);

watch(
  () => props.mode,
  (mode) => {
    view.value = mode;
  },
);

function toggleView() {
  view.value = view.value === "hex" ? "ascii" : "hex";
}

const shown = computed(() => (view.value === "hex" ? props.message.hex : props.message.ascii));

const color = {
  rx: "bg-rx",
  tx: "bg-tx",
  error: "bg-err",
};

async function copyText(text: string) {
  await navigator.clipboard.writeText(text);
  toast.success(t("common.copied"));
}
</script>

<template>
  <article
    class="group relative rounded-md bg-bg-1/80 px-3 py-2"
    :class="[
      message.direction === 'rx' ? 'cursor-pointer' : '',
      selected ? 'bg-primary/8 ring-1 ring-primary/50' : '',
    ]"
    @click="message.direction === 'rx' && emit('select', $event.shiftKey)"
  >
    <span
      class="absolute top-1.5 bottom-1.5 left-0 w-0.5 rounded-full"
      :class="message.color ? undefined : color[message.direction]"
      :style="message.color ? { background: message.color } : undefined"
    />
    <header class="mb-1 flex items-center gap-2 pl-1 text-[11px] leading-4 text-muted-foreground">
      <span
        class="font-medium"
        :class="{
          'text-rx': message.direction === 'rx',
          'text-tx': message.direction === 'tx',
          'text-err': message.direction === 'error',
        }"
      >
        {{ message.direction === "rx" ? "↓ RX" : message.direction === "tx" ? "↑ TX" : "× ERR" }}
      </span>
      <span>{{ formatClock(message.timestamp) }}</span>
      <span>{{ message.byteLength }}B</span>
      <Badge
        v-if="message.topic"
        variant="outline"
        class="h-4 cursor-pointer px-1.5 font-mono text-[10px] hover:border-primary/50"
        :style="message.color ? { borderColor: message.color, color: message.color } : undefined"
        :title="t('mqtt.only', { topic: message.topic })"
        @click.stop="sessions.setTopicFilter(message.sessionId, message.topic)"
      >
        {{ message.topic }}
      </Badge>
      <span v-if="message.sourceLabel" class="font-mono">{{ message.sourceLabel }}</span>
    </header>
    <div class="relative">
      <pre class="selectable pr-8 pl-1 font-mono text-[13px] leading-5 break-all whitespace-pre-wrap text-foreground/90">{{ shown }}</pre>
      <RadixToggle
        class="absolute top-0 right-0 z-10"
        :radix="payloadFromMode(view)"
        other="STR"
        @click="toggleView"
      />
    </div>
    <div
      class="pointer-events-none absolute top-1.5 right-2 z-20 flex items-center gap-0.5 bg-bg-1/95 opacity-0 group-hover:pointer-events-auto group-hover:opacity-100"
    >
      <Button
        variant="ghost"
        size="icon-xs"
        class="size-5 text-muted-foreground hover:text-foreground"
        :title="t('msg.parse')"
        @click.stop="sendToFrameParser(message.hex)"
      >
        <ScanText class="size-3.5" />
      </Button>
      <Button
        variant="ghost"
        size="icon-xs"
        class="size-5 text-muted-foreground hover:text-foreground"
        :title="t('msg.modbus')"
        @click.stop="sendToModbusParser(message.hex)"
      >
        <ScanSearch class="size-3.5" />
      </Button>
      <Button
        variant="ghost"
        size="icon-xs"
        class="size-5 text-muted-foreground hover:text-foreground"
        :title="t('common.copy')"
        @click.stop="copyText(shown)"
      >
        <Copy class="size-3.5" />
      </Button>
      <Button
        variant="ghost"
        size="icon-xs"
        class="size-5 text-muted-foreground hover:text-foreground"
        :title="t('msg.resend')"
        @click.stop="sessions.resend(message)"
      >
        <RotateCcw class="size-3.5" />
      </Button>
    </div>
  </article>
</template>
