<script setup lang="ts">
import { computed, ref } from "vue";
import { Ellipsis, RefreshCw } from "@lucide/vue";
import type { Session } from "@/types";
import { t } from "@/i18n";
import { isTauri } from "@/lib/ipc";
import { randomClientId } from "@/lib/protocol";
import { useSessionsStore } from "@/stores/sessions";
import AppSelect from "@/components/common/AppSelect.vue";
import PageHelp from "@/components/common/PageHelp.vue";
import type { PageHelpId } from "@/lib/page-help";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

const props = defineProps<{ session: Session }>();
const sessions = useSessionsStore();
const mqttMore = ref(false);

const serial = computed(() =>
  props.session.config.kind === "serial" ? props.session.config : null,
);
const tcp = computed(() =>
  props.session.config.kind === "tcp" ? props.session.config : null,
);
const udp = computed(() =>
  props.session.config.kind === "udp" ? props.session.config : null,
);
const ws = computed(() =>
  props.session.config.kind === "websocket" ? props.session.config : null,
);
const mqtt = computed(() =>
  props.session.config.kind === "mqtt" ? props.session.config : null,
);

const helpPage = computed<PageHelpId>(() => {
  const k = props.session.config.kind;
  if (k === "serial" || k === "tcp" || k === "udp" || k === "websocket" || k === "mqtt") return k;
  return "serial";
});

const connected = computed(() => props.session.status === "connected");
const connecting = computed(() => props.session.status === "connecting");
const locked = computed(() => connected.value || connecting.value);

const bauds = [9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600];

const portOptions = computed(() => {
  const ports = sessions.serialPorts.map((p) => ({ value: p.name, label: p.label || p.name }));
  const current = serial.value?.port;
  if (current && ports.length && !ports.some((p) => p.value === current)) {
    ports.unshift({ value: current, label: current });
  }
  return ports;
});

function patch<T extends object>(data: T) {
  if (locked.value) return;
  sessions.updateConfig(props.session.id, data);
}

function patchTls(on: boolean) {
  const extra: { tls: boolean; port?: number } = { tls: on };
  if (on && mqtt.value?.port === 1883) extra.port = 8883;
  if (!on && mqtt.value?.port === 8883) extra.port = 1883;
  patch(extra);
}

const parityOptions = computed(() => [
  { value: "none", label: t("bar.parityNone") },
  { value: "even", label: t("bar.parityEven") },
  { value: "odd", label: t("bar.parityOdd") },
]);
const stopOptions = computed(() => [
  { value: 1, label: t("bar.stop1") },
  { value: 2, label: t("bar.stop2") },
]);
const flowOptions = computed(() => [
  { value: "none", label: t("bar.flowNone") },
  { value: "hardware", label: t("bar.flowHw") },
  { value: "software", label: t("bar.flowSw") },
]);
const heartbeatOptions = computed(() => [
  { value: "off", label: t("bar.hbOff") },
  { value: "on", label: t("bar.hbOn") },
]);
const mqttSessionOptions = computed(() => [
  { value: "1", label: t("bar.cleanSession") },
  { value: "0", label: t("bar.persistSession") },
]);
const mqttTlsOptions = computed(() => [
  { value: "0", label: "TCP" },
  { value: "1", label: "TLS" },
]);
</script>

<template>
  <div class="flex items-start gap-2 border-b border-border bg-bg-1/40 px-3 py-2">
    <div class="flex min-w-0 flex-1 flex-wrap items-center gap-2">
      <template v-if="serial">
        <AppSelect
          v-if="sessions.serialPorts.length"
          :model-value="serial.port"
          :options="portOptions"
          :disabled="locked"
          :placeholder="t('bar.pickPort')"
          class="w-[220px]"
          @update:model-value="patch({ port: String($event) })"
        />
        <Input
          v-else
          :model-value="serial.port"
          :disabled="locked"
          class="h-7 w-44 text-xs"
          :placeholder="isTauri() ? t('bar.noPorts') : 'COM3 / /dev/ttyUSB0'"
          @update:model-value="patch({ port: String($event) })"
        />
        <AppSelect
          :model-value="serial.baudRate"
          :options="bauds"
          :disabled="locked"
          class="w-[92px]"
          @update:model-value="patch({ baudRate: Number($event) })"
        />
        <AppSelect
          :model-value="serial.dataBits"
          :options="[8, 7, 6, 5]"
          :disabled="locked"
          class="w-14"
          @update:model-value="patch({ dataBits: Number($event) })"
        />
        <AppSelect
          :model-value="serial.parity"
          :options="parityOptions"
          :disabled="locked"
          class="w-[88px]"
          @update:model-value="patch({ parity: $event })"
        />
        <AppSelect
          :model-value="serial.stopBits"
          :options="stopOptions"
          :disabled="locked"
          class="w-[96px]"
          @update:model-value="patch({ stopBits: Number($event) })"
        />
        <AppSelect
          :model-value="serial.flowControl"
          :options="flowOptions"
          :disabled="locked"
          class="w-[108px]"
          @update:model-value="patch({ flowControl: $event })"
        />
      </template>

      <template v-else-if="tcp">
        <div class="flex rounded-md border border-border p-0.5 text-xs">
          <Button
            type="button"
            size="xs"
            :variant="tcp.mode === 'client' ? 'secondary' : 'ghost'"
            :disabled="locked"
            class="h-6 px-2"
            @click="patch({ mode: 'client' })"
          >
            Client
          </Button>
          <Button
            type="button"
            size="xs"
            :variant="tcp.mode === 'server' ? 'secondary' : 'ghost'"
            :disabled="locked"
            class="h-6 px-2"
            @click="patch({ mode: 'server' })"
          >
            Server
          </Button>
        </div>
        <Input
          v-if="tcp.mode === 'client'"
          :model-value="tcp.host"
          :disabled="locked"
          class="h-7 w-40 text-xs"
          placeholder="127.0.0.1"
          @update:model-value="patch({ host: String($event) })"
        />
        <Input
          :model-value="tcp.port"
          :disabled="locked"
          class="h-7 w-20 text-xs"
          @update:model-value="patch({ port: Number($event) || 0 })"
        />
      </template>

      <template v-else-if="udp">
        <span class="text-[11px] text-muted-foreground">{{ t("bar.local") }}</span>
        <Input
          :model-value="udp.localPort"
          :disabled="locked"
          class="h-7 w-20 text-xs"
          @update:model-value="patch({ localPort: Number($event) || 0 })"
        />
        <span class="text-[11px] text-muted-foreground">{{ t("bar.remote") }}</span>
        <Input
          :model-value="udp.remoteHost"
          :disabled="locked"
          class="h-7 w-36 text-xs"
          @update:model-value="patch({ remoteHost: String($event) })"
        />
        <Input
          :model-value="udp.remotePort"
          :disabled="locked"
          class="h-7 w-20 text-xs"
          @update:model-value="patch({ remotePort: Number($event) || 0 })"
        />
      </template>

      <template v-else-if="ws">
        <Input
          :model-value="ws.url"
          :disabled="locked"
          class="h-7 min-w-64 flex-1 text-xs"
          placeholder="ws://127.0.0.1:8080"
          @update:model-value="patch({ url: String($event) })"
        />
        <div class="flex rounded-md border border-border p-0.5 text-xs">
          <Button
            type="button"
            size="xs"
            :variant="ws.messageMode === 'text' ? 'secondary' : 'ghost'"
            :disabled="locked"
            class="h-6 px-2"
            @click="patch({ messageMode: 'text' })"
          >
            Text
          </Button>
          <Button
            type="button"
            size="xs"
            :variant="ws.messageMode === 'binary' ? 'secondary' : 'ghost'"
            :disabled="locked"
            class="h-6 px-2"
            @click="patch({ messageMode: 'binary' })"
          >
            Binary
          </Button>
        </div>
        <AppSelect
          :model-value="ws.heartbeatEnabled ? 'on' : 'off'"
          :options="heartbeatOptions"
          :disabled="locked"
          class="w-[88px]"
          @update:model-value="patch({ heartbeatEnabled: $event === 'on' })"
        />
        <Input
          v-if="ws.heartbeatEnabled"
          :model-value="ws.heartbeatIntervalMs"
          :disabled="locked"
          class="h-7 w-24 text-xs"
          :placeholder="t('bar.hbMs')"
          @update:model-value="patch({ heartbeatIntervalMs: Number($event) || 30000 })"
        />
        <Input
          v-if="ws.heartbeatEnabled"
          :model-value="ws.heartbeatPayload"
          :disabled="locked"
          class="h-7 w-28 text-xs"
          :placeholder="t('bar.hbPayload')"
          @update:model-value="patch({ heartbeatPayload: String($event) })"
        />
      </template>

      <template v-else-if="mqtt">
        <Input
          :model-value="mqtt.broker"
          :disabled="locked"
          class="h-7 w-36 text-xs"
          placeholder="Broker"
          @update:model-value="patch({ broker: String($event) })"
        />
        <Input
          :model-value="mqtt.port"
          :disabled="locked"
          class="h-7 w-20 text-xs"
          @update:model-value="patch({ port: Number($event) || 0 })"
        />
        <Input
          :model-value="mqtt.clientId"
          :disabled="locked"
          class="h-7 w-36 text-xs"
          :placeholder="t('bar.randomId')"
          @update:model-value="patch({ clientId: String($event) })"
        />
        <Button
          type="button"
          size="icon-xs"
          variant="outline"
          :disabled="locked"
          :title="t('bar.randomId')"
          @click="patch({ clientId: randomClientId() })"
        >
          <RefreshCw class="size-3.5" />
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          :class="mqttMore ? 'text-foreground' : 'text-muted-foreground'"
          @click="mqttMore = !mqttMore"
        >
          <Ellipsis class="size-3.5" />
          {{ t("common.more") }}
        </Button>
        <template v-if="mqttMore">
          <Input
            :model-value="mqtt.username"
            :disabled="locked"
            class="h-7 w-28 text-xs"
            :placeholder="t('bar.username')"
            @update:model-value="patch({ username: String($event) })"
          />
          <Input
            :model-value="mqtt.password"
            :disabled="locked"
            class="h-7 w-28 text-xs"
            type="password"
            :placeholder="t('common.password')"
            @update:model-value="patch({ password: String($event) })"
          />
          <Input
            :model-value="mqtt.keepAlive"
            :disabled="locked"
            class="h-7 w-20 text-xs"
            placeholder="KeepAlive"
            @update:model-value="patch({ keepAlive: Number($event) || 60 })"
          />
          <AppSelect
            :model-value="mqtt.cleanSession ? '1' : '0'"
            :options="mqttSessionOptions"
            :disabled="locked"
            class="w-[108px]"
            @update:model-value="patch({ cleanSession: $event === '1' })"
          />
          <AppSelect
            :model-value="mqtt.tls ? '1' : '0'"
            :options="mqttTlsOptions"
            :disabled="locked"
            class="w-[88px]"
            @update:model-value="patchTls($event === '1')"
          />
        </template>
      </template>
    </div>

    <div class="flex shrink-0 items-center gap-1">
      <PageHelp :page="helpPage" />
      <Button
        size="sm"
        :variant="connected ? 'outline' : 'default'"
        :disabled="connecting"
        @click="sessions.toggleConnect(session.id)"
      >
        {{ connecting ? t("status.connectingEllipsis") : connected ? t("status.disconnect") : t("status.connect") }}
      </Button>
    </div>
  </div>
</template>
