<script setup lang="ts">
import { computed } from "vue";
import { toast } from "vue-sonner";
import { Braces, Copy, Eraser, Layers, ScanSearch, ScanText } from "@lucide/vue";
import type { Session } from "@/types";
import { t } from "@/i18n";
import { concatHex, concatText } from "@/lib/merge-rx";
import { payloadFromMode } from "@/lib/radix";
import { openJsonTool, sendToFrameParser, sendToModbusParser } from "@/lib/tool-bridge";
import { useSessionsStore } from "@/stores/sessions";
import { Button } from "@/components/ui/button";
import RadixToggle from "@/components/common/RadixToggle.vue";
import ConnectionBar from "@/components/session/ConnectionBar.vue";
import TcpClientsBar from "@/components/session/TcpClientsBar.vue";
import MqttTopicList from "@/components/session/MqttTopicList.vue";
import MessageStream from "@/components/session/MessageStream.vue";
import Composer from "@/components/session/Composer.vue";

const props = defineProps<{ session: Session }>();
const sessions = useSessionsStore();

const mode = computed(() => sessions.displayMode[props.session.id] ?? "hex");
const tcpServer = computed(
  () => props.session.config.kind === "tcp" && props.session.config.mode === "server",
);
const mqtt = computed(() => props.session.protocol === "mqtt");
const serial = computed(() => props.session.protocol === "serial");
const topicFilter = computed(() => sessions.topicFilter[props.session.id] || t("mqtt.all"));
const selectedCount = computed(() => sessions.selectedCount);

function merged() {
  return sessions.selectedRx(props.session.id);
}

async function copyMerged() {
  const list = merged();
  if (!list.length) return;
  const text = mode.value === "hex" ? concatHex(list) : concatText(list);
  await navigator.clipboard.writeText(text);
  toast.success(t("stream.copiedN", { n: list.length }));
}

function parseMerged() {
  const list = merged();
  if (!list.length) return;
  sendToModbusParser(concatHex(list));
}

function jsonMerged() {
  const list = merged();
  if (!list.length) return;
  openJsonTool(concatText(list));
}

function pickAfterTx() {
  sessions.selectAfterLastTx(props.session.id);
  const n = sessions.selectedRx(props.session.id).length;
  toast.message(n ? t("stream.selected", { n }) : t("stream.noReply"));
}
</script>

<template>
  <div class="flex h-full min-w-0 flex-col">
    <ConnectionBar :session="session" />
    <TcpClientsBar v-if="tcpServer" :session="session" />
    <div class="flex min-h-0 flex-1">
      <MqttTopicList v-if="mqtt" :session="session" />
      <div class="flex min-w-0 flex-1 flex-col">
        <div class="flex items-center justify-between gap-2 border-b border-border px-3 py-1.5">
          <div class="flex min-w-0 flex-wrap items-center gap-2">
            <button
              type="button"
              class="relative inline-flex h-7 w-11 cursor-pointer items-center justify-center rounded-md border border-input bg-transparent"
              :title="t('stream.toggleView')"
              @click="sessions.setDisplayMode(session.id, mode === 'hex' ? 'ascii' : 'hex')"
            >
              <RadixToggle
                :radix="payloadFromMode(mode)"
                other="STR"
                @click="sessions.setDisplayMode(session.id, mode === 'hex' ? 'ascii' : 'hex')"
              />
            </button>
            <span v-if="mqtt" class="max-w-48 truncate font-mono text-[11px] text-muted-foreground">
              {{ topicFilter }}
            </span>
            <Button
              v-if="serial"
              variant="outline"
              size="xs"
              class="text-muted-foreground"
              :title="t('stream.selectRx')"
              @click="pickAfterTx"
            >
              <Layers class="size-3.5" />
              {{ t("stream.mergeRx") }}
            </Button>
            <template v-if="selectedCount">
              <span class="text-[11px] text-primary">{{ t("stream.selected", { n: selectedCount }) }}</span>
              <Button variant="outline" size="xs" @click="copyMerged">
                <Copy class="size-3.5" />
                {{ t("stream.copyMerge") }}
              </Button>
              <Button variant="outline" size="xs" @click="parseMerged">
                <ScanSearch class="size-3.5" />
                Modbus
              </Button>
              <Button variant="outline" size="xs" @click="sendToFrameParser(concatHex(merged()))">
                <ScanText class="size-3.5" />
                {{ t("stream.parse") }}
              </Button>
              <Button variant="outline" size="xs" @click="jsonMerged">
                <Braces class="size-3.5" />
                JSON
              </Button>
              <Button variant="outline" size="xs" class="text-muted-foreground" @click="sessions.clearSelection(session.id)">
                {{ t("common.cancel") }}
              </Button>
            </template>
          </div>
          <Button
            variant="outline"
            size="xs"
            class="shrink-0 text-muted-foreground"
            @click="sessions.clearMessages(session.id)"
          >
            <Eraser class="size-3.5" />
            {{ t("common.clear") }}
          </Button>
        </div>
        <div class="min-h-0 flex-1">
          <MessageStream />
        </div>
      </div>
    </div>
    <Composer />
  </div>
</template>
