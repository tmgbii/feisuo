<script setup lang="ts">
import { computed, reactive, ref, watch } from "vue";
import { Eraser, Plus, Radar, Sparkles, Trash2 } from "@lucide/vue";
import { toast } from "vue-sonner";
import { t } from "@/i18n";
import { insertToComposer } from "@/lib/composer-insert";
import { pendingModbusParse } from "@/lib/tool-bridge";
import { lastModbusStart } from "@/lib/frame-modbus";
import {
  buildModbusFrame,
  modbusFrameReady,
  normalizeModbusInput,
  parseModbus,
  type ModbusMode,
  type ModbusParseResult,
} from "@/lib/modbus";
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

function plainValue(value: string) {
  return value.replace(/\s*\((?:0x)?[0-9A-Fa-f ]+\)\s*$/, "").trim();
}

function pointAddr(item: DecodedPoint) {
  if (item.span && item.span > 1) return `${item.address}–${item.address + item.span - 1}`;
  return String(item.address);
}

type MbSpan = {
  key: string;
  label: string;
  offset: number;
  size: number;
  tone: number;
  role: "field" | "checksum" | "data";
};

const FIELD_TONES = ["bg-primary/40", "bg-primary/20", "bg-foreground/20", "bg-primary/12", "bg-foreground/10"];
const hover = ref("");

const parseSkip = computed(() => new Set([
  t("tools.regsHex"),
  t("tools.regsDec"),
  t("tools.data"),
  t("tools.proto"),
  t("tools.direction"),
  "CRC16",
  "LRC",
]));

const parseDirection = computed(
  () => parsed.value?.fields.find((field) => field.label === t("tools.direction"))?.value ?? "",
);

const parseCheck = computed(() => {
  const field = parsed.value?.fields.find((item) => item.label === "CRC16" || item.label === "LRC");
  if (!field) return null;
  const ok = field.value.startsWith("OK ");
  return {
    ok,
    text: ok ? `${t("tools.crcOk")} ${field.value.slice(3)}` : field.value,
  };
});

const parseTokens = computed(() => (parsed.value?.wire ?? "").trim().split(/\s+/).filter(Boolean));

const parseSpans = computed(() => {
  const result = parsed.value;
  const len = parseTokens.value.length;
  if (!result || !len) return [] as MbSpan[];
  const spans: MbSpan[] = [];
  let tone = 0;
  const push = (key: string, label: string, offset: number, size: number, role: MbSpan["role"] = "field") => {
    if (offset < 0 || size <= 0 || offset >= len) return;
    spans.push({
      key,
      label,
      offset,
      size: Math.min(size, len - offset),
      tone: role === "field" ? tone++ : 0,
      role,
    });
  };
  const base = result.mode === "TCP" ? 7 : 1;
  if (result.mode === "TCP") {
    push("tid", t("tools.tid"), 0, 2);
    push("proto", t("tools.protoId"), 2, 2);
    push("len", t("tools.length"), 4, 2);
    push("slave", t("lab.slave"), 6, 1);
  } else {
    push("slave", t("lab.slave"), 0, 1);
    const crcAt = result.mode === "ASCII" ? 1 : 2;
    push("crc", t("composer.checksum"), len - crcAt, crcAt, "checksum");
  }
  if (base != null && result.role !== "exception") {
    const func = result.func & 0x7f;
    const read = [0x01, 0x02, 0x03, 0x04].includes(func);
    const writeMulti = func === 0x0f || func === 0x10;
    const writeSingle = func === 0x05 || func === 0x06;
    push("func", t("tools.funcCode"), base, 1);
    const inFrame = !(read && result.role === "response");
    if (result.address != null && inFrame && (read || writeMulti || writeSingle)) {
      const addrLabel = result.fields.some((field) => field.label === t("lab.addr")) ? t("lab.addr") : t("tools.startAddr");
      push("addr", addrLabel, base + 1, 2);
    }
    if (result.quantity != null && inFrame && (read || writeMulti)) push("qty", t("lab.qty"), base + 3, 2);
    if (writeSingle) push("val", func === 0x05 ? t("tools.coil") : t("tools.value"), base + 3, 2);
    if (result.payload && result.role === "response" && read) push("count", t("tools.byteCount"), base + 1, 1);
    if (result.payload && writeMulti && result.role === "request") push("count", t("tools.byteCount"), base + 5, 1);
  } else if (base != null && result.role === "exception") {
    push("func", t("tools.funcCode"), base, 1);
    push("exc", t("tools.excCode"), base + 1, 1);
  }
  if (result.payload && result.payloadAt != null) {
    const coils = result.payload.kind === "coils";
    push("data", coils ? t("tools.coilBits") : t("tools.data"), result.payloadAt, result.payload.bytes.length, coils ? "field" : "data");
  }
  return spans;
});

const parseRows = computed(() => {
  const tokens = parseTokens.value;
  const spanned = parseSpans.value.filter((span) => span.role === "field");
  if (spanned.length) {
    return spanned.map((span) => {
      const field = parsed.value?.fields.find((item) => item.label === span.label);
      const raw = tokens.slice(span.offset, span.offset + span.size).join(" ");
      return { ...span, value: field ? plainValue(field.value) : raw, raw };
    });
  }
  return (parsed.value?.fields ?? [])
    .filter((field) => !parseSkip.value.has(field.label))
    .map((field) => ({ key: field.label, label: field.label, value: plainValue(field.value), raw: "" }));
});

const shownPoints = computed(() => decoded.value.map((point) => ({
  ...point,
  byteOffset: parsed.value?.payloadAt != null && point.byteOffset != null
    ? parsed.value.payloadAt + point.byteOffset
    : undefined,
})));

const registerRows = computed(() => {
  const payload = parsed.value?.payload;
  if (!payload || payload.kind !== "registers") return [];
  const start = Number(startAddr.value);
  const base = Number.isFinite(start) ? start : 0;
  const at = parsed.value?.payloadAt ?? 0;
  const rows: { addr: number; dec: number; hex: string; offset: number }[] = [];
  for (let i = 0; i + 1 < payload.bytes.length; i += 2) {
    const hi = payload.bytes[i] ?? 0;
    const lo = payload.bytes[i + 1] ?? 0;
    rows.push({
      addr: base + i / 2,
      dec: (hi << 8) | lo,
      hex: `${hi.toString(16).toUpperCase().padStart(2, "0")} ${lo.toString(16).toUpperCase().padStart(2, "0")}`,
      offset: at + i,
    });
  }
  return rows;
});

const parseLegend = computed(() => [...parseSpans.value].sort((a, b) => a.offset - b.offset || a.size - b.size));

function spanClass(span: MbSpan) {
  if (span.role === "checksum") return parseCheck.value?.ok === false ? "bg-err/40" : "bg-rx/25";
  if (span.role === "data") return "bg-foreground/15";
  return FIELD_TONES[span.tone % FIELD_TONES.length] ?? FIELD_TONES[0];
}

function covering(index: number) {
  return parseSpans.value.filter((span) => index >= span.offset && index < span.offset + span.size);
}

function byteClass(index: number) {
  const active = hover.value;
  if (active.startsWith("point:")) {
    const point = shownPoints.value[Number(active.slice(6))];
    const on = point?.byteOffset != null && point.byteSize != null && index >= point.byteOffset && index < point.byteOffset + point.byteSize;
    return on ? "bg-primary/35" : "opacity-30";
  }
  if (active.startsWith("reg:")) {
    const row = registerRows.value[Number(active.slice(4))];
    const on = row != null && index >= row.offset && index < row.offset + 2;
    return on ? "bg-primary/35" : "opacity-30";
  }
  if (active) {
    const span = parseSpans.value.find((item) => item.key === active);
    const on = span != null && index >= span.offset && index < span.offset + span.size;
    return on && span ? spanClass(span) : "opacity-30";
  }
  const cover = covering(index);
  if (cover.some((span) => span.role === "checksum") && parseCheck.value?.ok === false) return "bg-err/40";
  const specific = [...cover].sort((a, b) => a.size - b.size)[0];
  return specific ? spanClass(specific) : "";
}

function enterByte(index: number) {
  const specific = [...covering(index)].sort((a, b) => a.size - b.size)[0];
  hover.value = specific?.key ?? "";
}

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
  { value: "ABCD", label: "ABCD" },
  { value: "CDAB", label: "CDAB" },
  { value: "BADC", label: "BADC" },
  { value: "DCBA", label: "DCBA" },
]);

function orderHint(order: string) {
  return t(`tools.${order.toLowerCase()}`);
}
const parseModeOptions = computed(() => [
  { value: "auto", label: t("tools.auto") },
  { value: "RTU", label: "RTU" },
  { value: "ASCII", label: "ASCII" },
  { value: "TCP", label: "TCP" },
]);

function lastTxStart(match?: { slave?: number; func?: number; beforeTs?: number }): number | null {
  return lastModbusStart(sessions.visibleMessages, match);
}

function firstPointAddr(): number | undefined {
  const point = ui.modbusPoints[0];
  return point && Number.isFinite(point.address) ? point.address : undefined;
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
  let start: number | undefined = result.address ?? firstPointAddr();
  if (start == null) {
    start = lastTxStart({ slave: result.slave, func: result.func }) ?? undefined;
  }
  if (start == null) {
    const typed = Number(startAddr.value);
    start = Number.isFinite(typed) ? typed : undefined;
  }
  if (start == null || !Number.isFinite(start)) return;
  startAddr.value = start;
  decoded.value = decodePoints(ui.modbusPoints, start, result.payload);
}

const parsedKey = ref("");

function runParse(raw = parseInput.value, quiet = false) {
  try {
    const formatted = normalizeModbusInput(raw) ?? raw.trim();
    if (!formatted) throw new Error(t("tools.noData"));
    const result = parseModbus(formatted, parseMode.value);
    parsed.value = result;
    parsedKey.value = `${parseMode.value}\0${formatted}`;
    if (parseInput.value !== formatted) parseInput.value = formatted;
    if (result.address != null) startAddr.value = result.address;
    applyPointTable(result);
    if (!quiet && result.errors.length) toast.message(result.errors[0] ?? t("err.warn"));
  } catch (err) {
    parsed.value = null;
    decoded.value = [];
    parsedKey.value = "";
    if (!quiet) toast.error(err instanceof Error ? err.message : String(err));
  }
}

function syncParse() {
  const text = normalizeModbusInput(parseInput.value);
  if (!text || !modbusFrameReady(text)) {
    parsed.value = null;
    decoded.value = [];
    parsedKey.value = "";
    return;
  }
  if (`${parseMode.value}\0${text}` === parsedKey.value) return;
  runParse(text, true);
}

watch([parseInput, parseMode], syncParse);

function parseLatestRx() {
  const last = [...sessions.visibleMessages].reverse().find((m) => m.direction === "rx");
  if (!last) {
    toast.message(t("err.emptyRx"));
    return;
  }
  pane.value = "parse";
  const fromTable = firstPointAddr();
  if (fromTable != null) startAddr.value = fromTable;
  else {
    const txStart = lastTxStart({ beforeTs: last.timestamp });
    if (txStart != null) startAddr.value = txStart;
  }
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

watch(
  () => ui.modbusPoints[0]?.address,
  (addr) => {
    if (addr != null && Number.isFinite(addr)) startAddr.value = addr;
  },
  { immediate: true },
);

watch(pendingModbusParse, (hex) => {
  if (!hex) return;
  pane.value = "parse";
  runParse(hex);
  pendingModbusParse.value = null;
}, { immediate: true });

watch(startAddr, () => {
  if (parsed.value) applyPointTable(parsed.value);
});

watch(
  () => sessions.visibleMessages.length,
  () => {
    if (parsed.value?.payload && parsed.value.address == null) applyPointTable(parsed.value);
  },
);

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
      <RadixBytes v-model="parseInput" :format-paste="normalizeModbusInput" placeholder="01 03 00 00 00 01 84 0A" />
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
      <div v-if="parsed" class="rounded-md border border-border bg-bg-1/70 px-3 py-2" @mouseleave="hover = ''">
        <div class="mb-1 flex items-center justify-between gap-2 text-[11px]">
          <span class="flex flex-wrap items-baseline gap-x-2">
            <span :class="parsed.ok ? 'text-rx' : 'text-warn'">{{ parsed.ok ? t("tools.parseOk") : t("err.warn") }}</span>
            <span>{{ parsed.mode }}</span>
            <span v-if="parseDirection">{{ parseDirection }}</span>
            <span v-if="parseCheck" class="font-mono tabular-nums" :class="parseCheck.ok ? 'text-rx' : 'text-err'">{{ parseCheck.text }}</span>
          </span>
          <Button
            v-if="parsed.address != null"
            size="xs"
            variant="ghost"
            class="h-6 shrink-0"
            @click="applyToBuilder"
          >
            {{ t("tools.fillBuild") }}
          </Button>
        </div>
        <div class="selectable flex flex-wrap gap-x-1 gap-y-0.5 font-mono text-[12px] tabular-nums leading-5">
          <span
            v-for="(byte, bi) in parseTokens"
            :key="bi"
            class="rounded-sm px-0.5"
            :class="byteClass(bi)"
            @mouseenter="enterByte(bi)"
          >{{ byte }}</span>
        </div>
        <div v-if="parseLegend.length" class="mt-1 flex flex-wrap gap-1">
          <span
            v-for="span in parseLegend"
            :key="span.key"
            class="inline-flex items-center gap-1 rounded px-1 py-0.5 text-[10px] text-muted-foreground"
            @mouseenter="hover = span.key"
          >
            <span class="inline-block size-2 rounded-sm" :class="spanClass(span)" />
            {{ span.label }}
          </span>
        </div>
        <table v-if="shownPoints.length" class="mt-2 w-full text-[12px]">
          <caption class="mb-0.5 text-left text-[11px] text-muted-foreground">{{ t("tools.points") }}</caption>
          <thead class="text-[11px] text-muted-foreground">
            <tr>
              <th class="py-0.5 text-left font-medium">{{ t("common.name") }}</th>
              <th class="py-0.5 text-left font-medium">{{ t("tools.value") }}</th>
              <th class="py-0.5 text-left font-medium">{{ t("tools.unit") }}</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="(item, pi) in shownPoints"
              :key="`${item.name}-${item.address}`"
              class="border-t border-border/60"
              :class="hover === `point:${pi}` ? 'bg-primary/10' : ''"
              @mouseenter="hover = item.byteOffset == null ? '' : `point:${pi}`"
            >
              <td class="whitespace-nowrap py-0.5 pr-3" :title="[pointAddr(item), item.raw].filter(Boolean).join(' · ')">
                <span class="mr-1 font-mono text-[11px] tabular-nums text-muted-foreground">{{ pointAddr(item) }}</span>
                {{ item.name }}
              </td>
              <td class="py-0.5 pr-2 font-mono tabular-nums">{{ item.text }}</td>
              <td class="py-0.5 text-muted-foreground">{{ item.unit }}</td>
            </tr>
          </tbody>
        </table>
        <div v-else-if="parsed.payload && ui.modbusPoints.length === 0" class="mt-2 text-[11px] text-muted-foreground">
          {{ t("err.noPoints") }}
        </div>
        <div v-if="registerRows.length" :class="shownPoints.length ? 'mt-3 border-t border-border pt-2' : 'mt-2'">
          <table class="w-full text-[12px]">
            <thead class="text-[11px] text-muted-foreground">
              <tr>
                <th class="w-[5.5rem] whitespace-nowrap py-0.5 pr-3 text-left font-medium">{{ t("lab.address") }}</th>
                <th class="whitespace-nowrap py-0.5 pr-3 text-left font-medium">{{ t("tools.value") }}</th>
                <th class="py-0.5 text-left font-medium">HEX</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="(row, ri) in registerRows"
                :key="row.addr"
                class="border-t border-border/60"
                :class="hover === `reg:${ri}` ? 'bg-primary/10' : ''"
                @mouseenter="hover = `reg:${ri}`"
              >
                <td class="whitespace-nowrap py-0.5 pr-3 font-mono tabular-nums text-muted-foreground">{{ row.addr }}</td>
                <td class="whitespace-nowrap py-0.5 pr-3 font-mono tabular-nums">{{ row.dec }}</td>
                <td class="py-0.5 font-mono tabular-nums text-muted-foreground">{{ row.hex }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <div v-if="parseRows.length" :class="shownPoints.length || registerRows.length ? 'mt-3 border-t border-border pt-2' : 'mt-2'">
          <table class="w-full text-[12px]">
            <thead class="text-[11px] text-muted-foreground">
              <tr>
                <th class="w-[5.5rem] whitespace-nowrap py-0.5 pr-3 text-left font-medium">{{ t("tools.field") }}</th>
                <th class="whitespace-nowrap py-0.5 pr-3 text-left font-medium">{{ t("tools.value") }}</th>
                <th class="py-0.5 text-left font-medium">HEX</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="row in parseRows"
                :key="row.key"
                class="border-t border-border/60"
                :class="hover === row.key ? 'bg-primary/10' : ''"
                @mouseenter="hover = row.key"
              >
                <td class="whitespace-nowrap py-0.5 pr-3">{{ row.label }}</td>
                <template v-if="row.raw && row.raw !== row.value">
                  <td class="whitespace-nowrap py-0.5 pr-3 font-mono tabular-nums">{{ row.value }}</td>
                  <td class="py-0.5 font-mono tabular-nums text-muted-foreground">{{ row.raw }}</td>
                </template>
                <td v-else colspan="2" class="py-0.5 font-mono tabular-nums">{{ row.raw || row.value }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <div v-if="parsed.errors.length" class="mt-2 space-y-0.5 text-[11px] text-warn">
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
        class="space-y-1 rounded-md border border-border px-2 py-1.5"
      >
        <div class="flex items-center gap-1">
          <Input v-model="point.name" class="h-7 min-w-0 flex-1 text-xs" :placeholder="t('common.name')" />
          <RadixInput
            v-model="point.address"
            radix="DEC"
            :hex-digits="4"
            class="w-[6.75rem] shrink-0"
            :placeholder="t('lab.addr')"
          />
          <Button variant="ghost" size="icon-xs" @click="removePoint(point.id)">
            <Trash2 class="size-3" />
          </Button>
        </div>
        <div class="flex items-center gap-1">
          <AppSelect
            :model-value="point.type"
            :options="pointTypeOptions"
            class="w-auto shrink-0"
            @update:model-value="point.type = $event as typeof point.type"
          />
          <span v-if="isWideType(point.type)" class="shrink-0" :title="orderHint(point.order)">
            <AppSelect
              :model-value="point.order"
              :options="wordOrderOptions"
              class="w-[5.5rem]"
              @update:model-value="point.order = $event as typeof point.order"
            />
          </span>
          <Input
            :model-value="point.scale"
            class="h-7 w-12 shrink-0 text-xs"
            :title="t('tools.scale')"
            :placeholder="t('tools.scale')"
            @update:model-value="point.scale = Number($event) || 1"
          />
          <Input v-model="point.unit" class="h-7 min-w-0 flex-1 text-xs" :placeholder="t('tools.unit')" />
          <Input
            :model-value="point.digits"
            class="h-7 w-10 shrink-0 text-xs"
            :title="t('tools.digits')"
            :placeholder="t('tools.digits')"
            @update:model-value="point.digits = Number($event) || 0"
          />
        </div>
      </div>
    </template>
  </div>
</template>
