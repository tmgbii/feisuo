<script setup lang="ts">
import { computed, reactive, ref, watch } from "vue";
import { Eraser, Plus, Radar, Sparkles, Trash2 } from "@lucide/vue";
import { toast } from "vue-sonner";
import { t } from "@/i18n";
import { insertToComposer } from "@/lib/composer-insert";
import { pendingModbusParse } from "@/lib/tool-bridge";
import { buildModbusFrame, parseModbus, type ModbusMode, type ModbusParseResult } from "@/lib/modbus";
import {
  decodePoints,
  importPoints,
  newPoint,
  pointRange,
  AI_POINT_PROMPT,
  POINT_TYPE_OPTIONS,
  isWideType,
  type DecodedPoint,
} from "@/lib/point-table";
import { useSessionsStore } from "@/stores/sessions";
import { useUiStore } from "@/stores/ui";
import AppSelect from "@/components/common/AppSelect.vue";
import RadixBytes from "@/components/common/RadixBytes.vue";
import RadixInput from "@/components/common/RadixInput.vue";
import { type NumericRadix } from "@/lib/radix";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

const FUNC_CODES = ["01", "02", "03", "04", "05", "06", "0F", "10"] as const;

const sessions = useSessionsStore();
const ui = useUiStore();
const pane = ref<"build" | "parse" | "points">("build");
const form = reactive({
  mode: "RTU" as ModbusMode,
  slave: 1,
  func: "03",
  address: 0,
  quantity: 1,
});
const qtyRadix = ref<NumericRadix>("DEC");
const preview = ref("");
const parseInput = ref("");
const parseMode = ref<"auto" | ModbusMode>("auto");
const parsed = ref<ModbusParseResult | null>(null);
const startAddr = ref(0);
const decoded = ref<DecodedPoint[]>([]);
const importText = ref("");
const showImport = ref(false);
const scanning = ref(false);
const scanAt = ref(-1);
const scanFound = ref<number[]>([]);
let scanStop = false;

const canSend = computed(
  () => Boolean(sessions.activeSession && sessions.activeSession.protocol !== "http" && sessions.activeSession.protocol !== "ai"),
);

const funcOptions = computed(() =>
  FUNC_CODES.map((value) => ({
    value,
    label: `${t(`tools.fc${value}`)} (0x${value})`,
  })),
);
const pointTypeOptions = computed(() =>
  POINT_TYPE_OPTIONS.map((o) => ({
    ...o,
    label: o.value === "bcd32" ? t("tools.bcd32") : o.label,
  })),
);
const wordOrderOptions = computed(() => [
  { value: "ABCD", label: t("tools.abcd") },
  { value: "CDAB", label: t("tools.cdab") },
  { value: "BADC", label: t("tools.badc") },
  { value: "DCBA", label: t("tools.dcba") },
]);
const parseModeOptions = computed(() => [
  { value: "auto", label: t("tools.auto") },
  { value: "RTU", label: "RTU" },
  { value: "ASCII", label: "ASCII" },
  { value: "TCP", label: "TCP" },
]);

function lastTxStart(): number | null {
  for (const message of [...sessions.visibleMessages].reverse()) {
    if (message.direction !== "tx") continue;
    try {
      const result = parseModbus(message.hex);
      if (result.address != null) return result.address;
    } catch {
      /* skip */
    }
  }
  return null;
}

function parseForm() {
  const slave = Number(form.slave);
  const func = Number.parseInt(form.func, 16);
  const address = Number(form.address);
  const quantity = Number(form.quantity);
  if ([slave, func, address, quantity].some((n) => !Number.isFinite(n))) {
    throw new Error(t("err.badModbusFields"));
  }
  return buildModbusFrame({
    mode: form.mode,
    slave,
    func,
    address,
    quantity,
  });
}

function generate() {
  try {
    const frame = parseForm();
    preview.value = frame.ascii ?? frame.hex;
    insertToComposer(frame.hex, "hex");
  } catch (err) {
    toast.error(err instanceof Error ? err.message : String(err));
  }
}

async function send() {
  if (!sessions.activeId || !canSend.value) return;
  try {
    const frame = parseForm();
    preview.value = frame.ascii ?? frame.hex;
    await sessions.sendToSession(sessions.activeId, frame.hex, "hex");
  } catch (err) {
    toast.error(err instanceof Error ? err.message : String(err));
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function replyFrom(sessionId: string, slave: number, afterTs: number): boolean {
  for (const message of sessions.messages[sessionId] ?? []) {
    if (message.direction !== "rx" || message.timestamp < afterTs) continue;
    try {
      const result = parseModbus(message.hex, form.mode);
      if (result.slave !== slave) continue;
      if (result.role === "response" || result.role === "exception") return true;
    } catch {
      /* 非 Modbus 帧 */
    }
  }
  return false;
}

async function waitReply(sessionId: string, slave: number, afterTs: number, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (scanStop) return false;
    if (replyFrom(sessionId, slave, afterTs)) return true;
    await sleep(16);
  }
  return replyFrom(sessionId, slave, afterTs);
}

async function scanSlaves() {
  const sessionId = sessions.activeId;
  if (!sessionId || !canSend.value) {
    toast.error(t("err.notConnected"));
    return;
  }
  if (sessions.activeSession?.status !== "connected") {
    toast.error(t("err.notConnected"));
    return;
  }
  scanning.value = true;
  scanStop = false;
  scanAt.value = 0;
  scanFound.value = [];
  try {
    for (let slave = 0; slave <= 255; slave += 1) {
      if (scanStop) break;
      scanAt.value = slave;
      const frame = buildModbusFrame({
        mode: form.mode,
        slave,
        func: 0x03,
        address: 0,
        quantity: 1,
      });
      const afterTs = Date.now();
      const ok = await sessions.sendToSession(sessionId, frame.hex, "hex", { skipHistory: true });
      if (!ok) break;
      if (await waitReply(sessionId, slave, afterTs, 100)) {
        scanFound.value = [...scanFound.value, slave];
      }
    }
    const n = scanFound.value.length;
    toast.message(
      scanStop
        ? t("err.scanStop", { n })
        : n
          ? t("err.scanFound", { n })
          : t("err.scanNone"),
    );
  } finally {
    scanning.value = false;
    scanAt.value = -1;
  }
}

function stopScan() {
  scanStop = true;
}

function pickSlave(id: number) {
  form.slave = id;
}

function applyPointTable(result: ModbusParseResult) {
  decoded.value = [];
  if (!result.payload || ui.modbusPoints.length === 0) return;
  let start = result.address;
  if (start == null) {
    const typed = Number(startAddr.value);
    start = Number.isFinite(typed) ? typed : Number(lastTxStart() ?? NaN);
  } else {
    startAddr.value = start;
  }
  if (!Number.isFinite(start)) return;
  decoded.value = decodePoints(ui.modbusPoints, start, result.payload);
}

function runParse(raw = parseInput.value) {
  try {
    const result = parseModbus(raw, parseMode.value);
    parsed.value = result;
    parseInput.value = raw.trim();
    if (result.address != null) startAddr.value = result.address;
    else if (!Number.isFinite(startAddr.value)) startAddr.value = lastTxStart() ?? 0;
    applyPointTable(result);
    if (result.errors.length) toast.message(result.errors[0] ?? t("err.warn"));
  } catch (err) {
    parsed.value = null;
    decoded.value = [];
    toast.error(err instanceof Error ? err.message : String(err));
  }
}

function parseLatestRx() {
  const last = [...sessions.visibleMessages].reverse().find((m) => m.direction === "rx");
  if (!last) {
    toast.message(t("err.emptyRx"));
    return;
  }
  pane.value = "parse";
  const txStart = lastTxStart();
  if (txStart && parsed.value?.address == null) startAddr.value = txStart;
  runParse(last.hex);
}

function applyToBuilder() {
  if (!parsed.value) return;
  form.slave = parsed.value.slave;
  form.func = parsed.value.func.toString(16).toUpperCase().padStart(2, "0");
  if (parsed.value.address != null) form.address = parsed.value.address;
  if (parsed.value.quantity != null) form.quantity = parsed.value.quantity;
  form.mode = parsed.value.mode;
  pane.value = "build";
}

function addPoint() {
  ui.modbusPoints = [...ui.modbusPoints, newPoint()];
}

function removePoint(id: string) {
  ui.modbusPoints = ui.modbusPoints.filter((p) => p.id !== id);
}

function clearPoints() {
  if (!ui.modbusPoints.length) return;
  const n = ui.modbusPoints.length;
  ui.modbusPoints = [];
  decoded.value = [];
  toast.success(t("err.clearedPoints", { n }));
}

async function copyAiPrompt() {
  await navigator.clipboard.writeText(AI_POINT_PROMPT);
  toast.success(t("common.copied"));
}

async function importAi() {
  if (showImport.value && importText.value.trim()) {
    runImport();
    return;
  }
  try {
    const clip = await navigator.clipboard.readText();
    const rows = importPoints(clip);
    if (rows.length) {
      ui.modbusPoints = rows;
      showImport.value = false;
      importText.value = "";
      toast.success(t("err.importedPoints", { n: rows.length }));
      return;
    }
  } catch {
    /* 无剪贴板权限时改手动粘贴 */
  }
  showImport.value = true;
  if (!importText.value) toast.message(t("err.pasteJson"));
}

function runImport() {
  try {
    const rows = importPoints(importText.value);
    if (!rows.length) throw new Error(t("err.noPointRows"));
    ui.modbusPoints = rows;
    showImport.value = false;
    importText.value = "";
    toast.success(t("err.importedPoints", { n: rows.length }));
  } catch (err) {
    toast.error(err instanceof Error ? err.message : t("err.importFail"));
  }
}

function readFromTable() {
  const range = pointRange(ui.modbusPoints);
  if (!range) {
    toast.message(t("err.noPoints"));
    return;
  }
  const coils = ui.modbusPoints.every((p) => p.type === "bool");
  form.func = coils ? "01" : "03";
  form.address = range.address;
  form.quantity = range.quantity;
  pane.value = "build";
  generate();
}

watch(pendingModbusParse, (hex) => {
  if (!hex) return;
  pane.value = "parse";
  const txStart = lastTxStart();
  if (txStart) startAddr.value = txStart;
  runParse(hex);
  pendingModbusParse.value = null;
}, { immediate: true });

watch(startAddr, () => {
  if (parsed.value) applyPointTable(parsed.value);
});

watch(
  () => form.func,
  (func) => {
    qtyRadix.value = func === "05" ? "HEX" : "DEC";
  },
);
</script>

<template>
  <div class="space-y-3 text-xs">
    <div class="flex rounded-md border border-border p-0.5">
      <Button
        type="button"
        size="xs"
        class="h-6 flex-1"
        :variant="pane === 'build' ? 'secondary' : 'ghost'"
        @click="pane = 'build'"
      >
        {{ t("common.generate") }}
      </Button>
      <Button
        type="button"
        size="xs"
        class="h-6 flex-1"
        :variant="pane === 'parse' ? 'secondary' : 'ghost'"
        @click="pane = 'parse'"
      >
        {{ t("common.parse") }}
      </Button>
      <Button
        type="button"
        size="xs"
        class="h-6 flex-1"
        :variant="pane === 'points' ? 'secondary' : 'ghost'"
        @click="pane = 'points'"
      >
        {{ t("tools.points") }}
      </Button>
    </div>

    <template v-if="pane === 'build'">
      <div class="grid grid-cols-2 gap-2">
        <label class="col-span-2 space-y-1">
          <span class="text-muted-foreground">{{ t("tools.func") }}</span>
          <AppSelect
            v-model="form.func"
            :options="funcOptions"
            class="w-full"
          />
        </label>
        <label class="space-y-1">
          <span class="text-muted-foreground">{{ t("tools.proto") }}</span>
          <AppSelect
            v-model="form.mode"
            :options="['RTU', 'ASCII', 'TCP']"
            class="w-full"
          />
        </label>
        <label class="space-y-1">
          <span class="text-muted-foreground">{{ t("lab.slave") }}</span>
          <RadixInput v-model="form.slave" radix="DEC" placeholder="1" />
        </label>
        <label class="space-y-1">
          <span class="text-muted-foreground">{{ t("tools.startAddress") }}</span>
          <RadixInput v-model="form.address" radix="DEC" :hex-digits="4" placeholder="0" />
        </label>
        <label class="space-y-1">
          <span class="text-muted-foreground">{{ form.func === "05" || form.func === "06" ? t("tools.value") : t("lab.qty") }}</span>
          <RadixInput
            v-model="form.quantity"
            v-model:radix="qtyRadix"
            :hex-digits="form.func === '05' || form.func === '06' ? 4 : 2"
            :placeholder="form.func === '05' ? 'FF00' : '1'"
          />
        </label>
      </div>
      <div v-if="preview" class="rounded-md border border-border px-2 py-1.5 font-mono text-[11px] break-all">
        {{ preview }}
      </div>
      <div class="flex gap-1">
        <Button size="sm" class="flex-1" @click="generate">{{ t("common.generate") }}</Button>
        <Button size="sm" variant="outline" :disabled="!canSend" @click="send">{{ t("common.send") }}</Button>
      </div>
      <div class="flex gap-1">
        <Button
          size="sm"
          variant="outline"
          class="flex-1"
          :disabled="!canSend || scanning"
          @click="scanSlaves"
        >
          <Radar class="size-3.5" />
          {{ scanning ? t("tools.scan", { n: scanAt }) : t("tools.scanSlaves") }}
        </Button>
        <Button v-if="scanning" size="sm" variant="ghost" @click="stopScan">{{ t("common.stop") }}</Button>
      </div>
      <p v-if="scanning || scanFound.length" class="text-[11px] text-muted-foreground">
        {{ t("tools.foundN", { n: scanFound.length }) }}
        <button
          v-for="id in scanFound"
          :key="id"
          type="button"
          class="ml-1 font-mono text-primary hover:underline"
          @click="pickSlave(id)"
        >
          {{ id }}
        </button>
      </p>
    </template>

    <template v-else-if="pane === 'parse'">
      <RadixBytes v-model="parseInput" placeholder="01 03 00 00 00 01 84 0A" />
      <div class="flex flex-wrap items-center gap-1">
        <AppSelect
          :model-value="parseMode"
          :options="parseModeOptions"
          class="w-[88px]"
          @update:model-value="parseMode = $event as typeof parseMode"
        />
        <RadixInput
          v-model="startAddr"
          radix="DEC"
          :hex-digits="4"
          class="w-24"
          :title="t('tools.replyAddr')"
          :placeholder="t('lab.addr')"
        />
        <Button size="sm" @click="runParse()">{{ t("common.parse") }}</Button>
        <Button size="sm" variant="outline" @click="parseLatestRx">{{ t("tools.latestRx") }}</Button>
      </div>
      <p class="text-[11px] text-muted-foreground">{{ t("tools.startHint") }}</p>
      <div v-if="decoded.length" class="space-y-1 rounded-md border border-primary/30 bg-primary/5 p-2">
        <div class="text-[11px] text-primary">{{ t("tools.decodePts") }}</div>
        <div
          v-for="item in decoded"
          :key="`${item.name}-${item.address}`"
          class="flex items-baseline justify-between gap-2"
        >
          <span class="text-muted-foreground">{{ item.name }}</span>
          <span class="font-mono">
            {{ item.text }}
            <span v-if="item.unit" class="text-muted-foreground">{{ item.unit }}</span>
          </span>
        </div>
      </div>
      <div v-else-if="parsed?.payload && ui.modbusPoints.length === 0" class="text-[11px] text-muted-foreground">
        {{ t("err.noPoints") }}
      </div>
      <div v-if="parsed" class="space-y-1.5 rounded-md border border-border p-2">
        <div class="flex items-center justify-between">
          <span :class="parsed.ok ? 'text-emerald-400' : 'text-amber-400'">
            {{ parsed.ok ? t("tools.parseOk") : t("err.warn") }}
          </span>
          <Button
            v-if="parsed.address != null"
            size="xs"
            variant="ghost"
            class="h-6"
            @click="applyToBuilder"
          >
            {{ t("tools.fillBuild") }}
          </Button>
        </div>
        <div
          v-for="field in parsed.fields"
          :key="field.label"
          class="grid grid-cols-[76px_1fr] gap-2"
        >
          <span class="text-muted-foreground">{{ field.label }}</span>
          <span class="font-mono break-all">{{ field.value }}</span>
        </div>
        <div v-if="parsed.errors.length" class="space-y-0.5 text-amber-400">
          <div v-for="err in parsed.errors" :key="err">{{ err }}</div>
        </div>
      </div>
    </template>

    <template v-else>
      <div class="flex flex-wrap gap-1">
        <Button size="sm" @click="copyAiPrompt">
          <Sparkles class="size-3.5" />
          {{ t("tools.copyPrompt") }}
        </Button>
        <Button size="sm" variant="outline" @click="importAi">{{ t("tools.importAi") }}</Button>
        <Button size="sm" variant="outline" @click="addPoint">
          <Plus class="size-3.5" />
          {{ t("common.add") }}
        </Button>
        <Button size="sm" variant="outline" :disabled="!ui.modbusPoints.length" @click="readFromTable">
          {{ t("tools.readTable") }}
        </Button>
        <Button
          size="sm"
          variant="outline"
          class="text-muted-foreground hover:text-err"
          :disabled="!ui.modbusPoints.length"
          @click="clearPoints"
        >
          <Eraser class="size-3.5" />
          {{ t("common.clear") }}
        </Button>
      </div>
      <div v-if="showImport" class="space-y-1">
        <Textarea
          v-model="importText"
          class="min-h-28 font-mono text-[11px]"
          :placeholder="t('tools.jsonArr')"
        />
        <Button size="sm" @click="runImport">{{ t("common.import") }}</Button>
      </div>
      <div v-if="ui.modbusPoints.length === 0 && !showImport" class="text-[11px] text-muted-foreground">
        {{ t("tools.noPoint") }}
      </div>
      <div
        v-for="point in ui.modbusPoints"
        :key="point.id"
        class="space-y-1 rounded-md border border-border p-2"
      >
        <div class="flex gap-1">
          <Input v-model="point.name" class="h-7 text-xs" :placeholder="t('common.name')" />
          <Button variant="ghost" size="icon-xs" @click="removePoint(point.id)">
            <Trash2 class="size-3" />
          </Button>
        </div>
        <div class="grid grid-cols-2 gap-1">
          <RadixInput
            v-model="point.address"
            radix="DEC"
            :hex-digits="4"
            :placeholder="t('lab.addr')"
          />
          <AppSelect
            :model-value="point.type"
            :options="pointTypeOptions"
            class="w-full"
            @update:model-value="point.type = $event as typeof point.type"
          />
          <AppSelect
            v-if="isWideType(point.type)"
            :model-value="point.order"
            :options="wordOrderOptions"
            class="w-full"
            @update:model-value="point.order = $event as typeof point.order"
          />
          <Input
            :model-value="point.scale"
            class="h-7 text-xs"
            :placeholder="t('tools.scale')"
            @update:model-value="point.scale = Number($event) || 1"
          />
          <Input v-model="point.unit" class="h-7 text-xs" :placeholder="t('tools.unit')" />
          <Input
            :model-value="point.digits"
            class="h-7 text-xs"
            :placeholder="t('tools.digits')"
            @update:model-value="point.digits = Number($event) || 0"
          />
        </div>
      </div>
    </template>
  </div>
</template>
