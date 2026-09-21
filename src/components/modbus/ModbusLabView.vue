<script setup lang="ts">
import { computed, onMounted, onUnmounted } from "vue";
import { toast } from "vue-sonner";
import { t } from "@/i18n";
import { useModbusLabStore } from "@/stores/modbus-lab";
import { useSessionsStore } from "@/stores/sessions";
import { type LabFault, type LabTransport } from "@/lib/modbus-lab";
import { WORD_ORDER_OPTIONS, type WordOrder } from "@/lib/point-table";
import AppSelect from "@/components/common/AppSelect.vue";
import RadixInput from "@/components/common/RadixInput.vue";
import RegisterTable from "@/components/modbus/RegisterTable.vue";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import PageHelp from "@/components/common/PageHelp.vue";
import { formatRadix } from "@/lib/radix";

const lab = useModbusLabStore();
const sessions = useSessionsStore();

const holdCount = computed({
  get: () => lab.pool.hold.length,
  set: (n: number) => lab.resizeHold(n),
});
const passCount = computed(() => lab.tests.filter((t) => t.ok).length);
const looping = computed(() => lab.masterOn && lab.slaveOn && lab.polling);
const external = computed(() => lab.transport !== "loopback");
const coilFn = computed(() => {
  const f = lab.activeDef?.func ?? 3;
  return f === 1 || f === 2 || f === 5 || f === 15;
});
const transportOptions = computed(() => [
  { value: "loopback", label: t("lab.loopback") },
  { value: "tcp", label: "TCP" },
  { value: "serial", label: t("lab.serial") },
]);
const masterPortOptions = computed(() =>
  sessions.serialPorts.map((p) => ({ value: p.name, label: t("lab.masterN", { name: p.label }) })),
);
const slavePortOptions = computed(() =>
  sessions.serialPorts.map((p) => ({ value: p.name, label: t("lab.slaveN", { name: p.label }) })),
);
const faultOptions = computed(() => [
  { value: 0, label: t("lab.faultOk") },
  { value: 1, label: t("lab.fault01") },
  { value: 2, label: t("lab.fault02") },
  { value: 3, label: t("lab.fault03") },
  { value: -1, label: t("lab.faultNone") },
]);
const funcOptions = computed(() => [
  { value: 1, label: t("lab.fnCoil") },
  { value: 2, label: t("lab.fnDiscrete") },
  { value: 3, label: t("lab.fnHold") },
  { value: 4, label: t("lab.fnInput") },
  { value: 5, label: t("lab.fnWCoil") },
  { value: 6, label: t("lab.fnWReg") },
  { value: 15, label: t("lab.fnWCoils") },
  { value: 16, label: t("lab.fnWRegs") },
]);
const wordOrderOptions = computed(() =>
  WORD_ORDER_OPTIONS.map((o) => ({ value: o.value, label: t(`tools.${o.value.toLowerCase()}`) })),
);

onMounted(() => {
  if (!sessions.serialPorts.length) void sessions.bindBackend();
  if (lab.transport === "loopback" && !looping.value) void lab.startLoop();
});
onUnmounted(() => {
  void lab.dispose();
});

function patchDef(patch: Record<string, unknown>) {
  const d = lab.activeDef;
  if (!d) return;
  Object.assign(d, patch);
}

function setTransport(value: string) {
  const next = value as LabTransport;
  if (lab.transport === next) return;
  void lab.stopLoop();
  lab.transport = next;
}

async function toggleLoop() {
  if (looping.value) await lab.stopLoop();
  else await lab.startLoop();
}

async function onCell(addr: number, value: number) {
  await lab.writeReg(addr, value);
}

async function onPool(addr: number, value: number) {
  const i = addr - lab.pool.holdStart;
  if (i >= 0 && i < lab.pool.hold.length) lab.pool.hold[i] = value & 0xffff;
}

async function onCoil(addr: number, on: boolean) {
  await lab.writeCoil(addr, on);
}

function copyHex(hex?: string) {
  if (!hex) return;
  void navigator.clipboard.writeText(hex);
  toast.success(t("common.copied"));
}
</script>

<template>
  <div class="flex h-full min-h-0 flex-col">
    <div class="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b border-border px-3 py-1.5">
      <AppSelect
        :model-value="lab.transport"
        :options="transportOptions"
        class="w-[108px]"
        @update:model-value="setTransport"
      />
      <AppSelect
        :model-value="lab.wire"
        :options="['TCP', 'RTU']"
        class="w-[72px]"
        @update:model-value="lab.wire = $event as typeof lab.wire"
      />
      <template v-if="lab.transport === 'tcp'">
        <Input v-model="lab.tcpHost" class="h-7 w-[108px] font-mono text-xs" placeholder="127.0.0.1" />
        <RadixInput v-model="lab.tcpPort" :hex-digits="4" placeholder="1502" class="w-28" />
      </template>
      <template v-else-if="lab.transport === 'serial'">
        <AppSelect
          :model-value="lab.serialMasterPort"
          :options="masterPortOptions"
          :placeholder="t('lab.masterPort')"
          class="w-[128px]"
          @update:model-value="lab.serialMasterPort = String($event)"
        />
        <AppSelect
          :model-value="lab.serialSlavePort"
          :options="slavePortOptions"
          :placeholder="t('lab.slavePort')"
          class="w-[128px]"
          @update:model-value="lab.serialSlavePort = String($event)"
        />
        <RadixInput v-model="lab.baudRate" placeholder="9600" class="w-[72px]" />
      </template>
      <span class="text-[11px] text-muted-foreground">{{ t("lab.timeout") }}</span>
      <RadixInput v-model="lab.timeoutMs" placeholder="ms" class="w-[72px]" :title="t('lab.timeoutMs')" />
      <label class="flex items-center gap-1 text-[11px] text-muted-foreground">
        <input v-model="lab.recordRaw" type="checkbox" class="accent-primary" />
        {{ t("lab.record") }}
      </label>
      <div class="ml-auto flex items-center gap-1">
        <PageHelp page="sim" />
        <Button
          size="sm"
          :variant="looping ? 'outline' : 'default'"
          @click="toggleLoop"
        >
          {{ looping ? t("common.stop") : t("common.start") }}
        </Button>
      </div>
    </div>

    <div class="flex min-h-0 flex-1">
      <section class="flex min-h-0 min-w-0 flex-1 flex-col border-r border-border">
        <header class="shrink-0 border-b border-border">
          <div class="flex flex-wrap items-center gap-x-2 gap-y-1 px-3 py-1">
            <span class="text-xs font-medium">{{ t("lab.slave") }}</span>
            <span
              class="size-1.5 rounded-full"
              :class="lab.slaveOn ? 'bg-rx' : 'bg-muted-foreground/40'"
            />
            <span class="text-[11px] text-muted-foreground">{{ lab.slaveOn ? t("lab.answering") : t("lab.stopped") }}</span>
            <template v-if="external">
              <Button v-if="!lab.slaveOn" size="xs" @click="lab.startSlave">{{ t("lab.listen") }}</Button>
              <Button v-else size="xs" variant="outline" @click="lab.stopSlave">{{ t("common.stop") }}</Button>
            </template>
          </div>
          <div class="flex flex-wrap items-center gap-x-2 gap-y-1 px-3 pb-1.5">
            <span class="text-[11px] text-muted-foreground">{{ t("lab.unit") }}</span>
            <RadixInput v-model="lab.pool.unit" class="w-[76px]" />
            <span class="text-[11px] text-muted-foreground">{{ t("lab.fault") }}</span>
            <AppSelect
              :model-value="lab.pool.fault"
              :options="faultOptions"
              class="w-[148px]"
              @update:model-value="lab.pool.fault = Number($event) as LabFault"
            />
            <span class="text-[11px] text-muted-foreground">{{ t("lab.startAddr") }}</span>
            <RadixInput v-model="lab.pool.holdStart" :hex-digits="4" class="w-[80px]" />
            <span class="text-[11px] text-muted-foreground">{{ t("lab.qty") }}</span>
            <RadixInput v-model="holdCount" class="w-[76px]" />
            <template v-if="coilFn">
              <span class="text-[11px] text-muted-foreground">{{ t("lab.coilStart") }}</span>
              <RadixInput v-model="lab.pool.coilStart" :hex-digits="4" class="w-[80px]" />
            </template>
          </div>
        </header>
        <div class="min-h-0 flex-1 overflow-auto px-2 py-1">
          <RegisterTable :values="lab.pool.hold" :start="lab.pool.holdStart" :radix="lab.gridRadix" @update:radix="lab.gridRadix = $event" @change="onPool" />
        </div>
      </section>

      <section class="flex min-h-0 min-w-0 flex-1 flex-col">
        <header class="shrink-0 border-b border-border">
          <div class="flex flex-wrap items-center gap-x-2 gap-y-1 px-3 py-1">
            <span class="text-xs font-medium">{{ t("lab.master") }}</span>
            <span
              class="size-1.5 rounded-full"
              :class="lab.polling ? 'bg-rx' : 'bg-muted-foreground/40'"
            />
            <span class="text-[11px] text-muted-foreground">{{ lab.polling ? t("lab.polling") : t("lab.stopped") }}</span>
            <template v-if="external">
              <Button v-if="!lab.masterOn" size="xs" @click="lab.startMaster">{{ t("status.connect") }}</Button>
              <Button v-else size="xs" variant="outline" @click="lab.stopMaster">{{ t("status.disconnect") }}</Button>
              <Button v-if="!lab.polling" size="xs" :disabled="!lab.masterOn" @click="lab.startPoll">{{ t("lab.poll") }}</Button>
              <Button v-else size="xs" variant="outline" @click="lab.stopPoll">{{ t("common.stop") }}</Button>
            </template>
            <template v-if="lab.defs.length > 1">
              <AppSelect
                :model-value="lab.activeDefId"
                :options="lab.defs.map((d) => ({ value: d.id, label: d.name }))"
                class="w-[120px]"
                @update:model-value="lab.activeDefId = String($event)"
              />
            </template>
            <Button size="xs" variant="ghost" @click="lab.addDef">+</Button>
            <Button v-if="lab.defs.length > 1" size="xs" variant="ghost" @click="lab.removeDef(lab.activeDefId)">−</Button>
            <label v-if="lab.activeDef" class="flex items-center gap-1 text-[11px] text-muted-foreground">
              <input v-model="lab.activeDef.enabled" type="checkbox" class="accent-primary" />
              {{ t("lab.enable") }}
            </label>
          </div>
          <div v-if="lab.activeDef" class="flex flex-wrap items-center gap-x-2 gap-y-1 px-3 pb-1.5">
            <AppSelect
              :model-value="lab.activeDef.func"
              :options="funcOptions"
              class="w-[148px]"
              @update:model-value="patchDef({ func: Number($event) })"
            />
            <span class="text-[11px] text-muted-foreground">{{ t("lab.slave") }}</span>
            <RadixInput v-model="lab.activeDef.slave" class="w-[76px]" />
            <span class="text-[11px] text-muted-foreground">{{ t("lab.addr") }}</span>
            <RadixInput v-model="lab.activeDef.address" :hex-digits="4" class="w-[80px]" />
            <span class="text-[11px] text-muted-foreground">{{ t("lab.qty") }}</span>
            <RadixInput v-model="lab.activeDef.quantity" class="w-[76px]" />
            <span class="text-[11px] text-muted-foreground">{{ t("lab.period") }}</span>
            <RadixInput v-model="lab.activeDef.scanMs" class="w-[76px]" />
            <AppSelect
              :model-value="lab.activeDef.view"
              :options="[
                { value: 'u16', label: 'uint16' },
                { value: 'i16', label: 'int16' },
                { value: 'u32', label: 'uint32' },
                { value: 'i32', label: 'int32' },
                { value: 'f32', label: 'float32' },
              ]"
              class="w-[92px]"
              @update:model-value="patchDef({ view: $event })"
            />
            <AppSelect
              :model-value="lab.activeDef.order"
              :options="wordOrderOptions"
              class="w-[120px]"
              @update:model-value="patchDef({ order: $event as WordOrder })"
            />
          </div>
        </header>
        <div class="min-h-0 flex-1 overflow-auto px-2 py-1">
          <RegisterTable
            v-if="lab.grid.length"
            :values="lab.grid"
            :start="lab.activeDef?.address ?? 0"
            :changed="lab.changed"
            :radix="lab.gridRadix"
            @update:radix="lab.gridRadix = $event"
            @change="onCell"
          />
          <div v-if="lab.coils.length" class="mt-1 grid grid-cols-8 gap-0.5">
            <button
              v-for="(b, i) in lab.coils"
              :key="i"
              type="button"
              class="h-6 rounded border font-mono text-[10px]"
              :class="b ? 'border-primary/40 bg-primary/15 text-primary' : 'border-border text-muted-foreground'"
              @click="onCoil((lab.activeDef?.address ?? 0) + i, !b)"
            >
              {{ formatRadix((lab.activeDef?.address ?? 0) + i, lab.gridRadix, 4) }}
            </button>
          </div>
          <p v-if="lab.decoded.length" class="mt-1 font-mono text-[11px] text-muted-foreground">
            {{ lab.decoded.join(" · ") }}
          </p>
        </div>
      </section>
    </div>

    <footer class="flex h-[38%] min-h-40 shrink-0 flex-col border-t border-border">
      <div class="flex shrink-0 items-center gap-2 px-3 py-1 text-[11px] text-muted-foreground">
        <span>
          {{ t("lab.log", { ok: lab.stats.ok, timeout: lab.stats.timeout, crc: lab.stats.crc, exc: lab.stats.exc }) }}
        </span>
        <span v-if="lab.tests.length">
          {{ t("lab.tests", { pass: passCount, total: lab.tests.length }) }}
        </span>
        <Button size="xs" variant="ghost" class="ml-auto h-5 px-1.5" @click="lab.runTests">{{ t("lab.runTests") }}</Button>
      </div>
      <div class="min-h-0 flex-1 overflow-auto px-3 pb-1">
        <ul v-if="lab.tests.length" class="mb-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px]">
          <li v-for="tc in lab.tests" :key="tc.name">
            <span :class="tc.ok ? 'text-rx' : 'text-destructive'">{{ tc.ok ? t("lab.pass") : t("lab.fail") }}</span>
            {{ tc.name }}
          </li>
        </ul>
        <ul class="space-y-0.5 font-mono text-[11px]">
          <li
            v-for="row in lab.logs"
            :key="row.id"
            class="cursor-pointer"
            :class="{
              'text-rx': row.tone === 'ok',
              'text-destructive': row.tone === 'err',
              'text-amber-500': row.tone === 'warn',
              'text-muted-foreground': row.tone === 'info',
            }"
            @click="copyHex(row.hex)"
          >
            {{ row.text }}
            <span v-if="row.hex" class="text-muted-foreground"> {{ row.hex }}</span>
          </li>
        </ul>
      </div>
    </footer>
  </div>
</template>
