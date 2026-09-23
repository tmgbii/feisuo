<script setup lang="ts">
import { computed, nextTick, reactive, ref, watch } from "vue";
import { Plus, Trash2 } from "@lucide/vue";
import { toast } from "vue-sonner";
import { t } from "@/i18n";
import { parseFrames, type FrameSpan } from "@/lib/frame-engine";
import { formatHexDump, takeHexPaste } from "@/lib/hex";
import { enrichModbusFrame, lastModbusStart, schemaLooksModbus, type ShownFrame } from "@/lib/frame-modbus";
import { parseModbus } from "@/lib/modbus";
import {
  blankField,
  blankSchema,
  CHECKSUM_ALGOS,
  FIELD_TYPES,
  schemaLabel,
  type FrameEndian,
  type FrameField,
  type FrameSchema,
} from "@/lib/frame-schema";
import { BUILTIN_SCHEMAS, SCHEMA_PROMPT } from "@/lib/frame-builtins";
import { exportFrameSchemas, importFrameSchemas } from "@/lib/frame-pack";
import { pendingFrameParse } from "@/lib/tool-bridge";
import { useFrameSchemasStore } from "@/stores/frame-schemas";
import { useSessionsStore } from "@/stores/sessions";
import { useUiStore } from "@/stores/ui";
import type { DecodedPoint } from "@/lib/point-table";
import AppSelect from "@/components/common/AppSelect.vue";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

const props = defineProps<{ compact?: boolean }>();
const store = useFrameSchemasStore();
const sessions = useSessionsStore();
const ui = useUiStore();
const openingSample = BUILTIN_SCHEMAS[0]?.sample ?? "";
const hex = ref(openingSample);
const frames = ref<ShownFrame[]>([]);
const jsonText = ref("");
const showJson = ref(false);
const useLength = ref(true);
const useChecksum = ref(true);
const schemaOpen = ref(false);
const hover = ref("");
let lastSample = openingSample;

const FIELD_TONES = ["bg-primary/40", "bg-primary/20", "bg-foreground/20", "bg-primary/12", "bg-foreground/10"];

const draft = reactive<FrameSchema>(clone(store.active ?? blankSchema()));

function clone(item: FrameSchema): FrameSchema {
  return JSON.parse(JSON.stringify(item)) as FrameSchema;
}

const readonly = computed(() => Boolean(store.active?.builtin));
const schemaOptions = computed(() =>
  store.sorted.map((s) => ({ value: s.schemaId, label: schemaLabel(s.name) })),
);
const endianOptions = computed(() => [
  { value: "big", label: t("tools.big") },
  { value: "little", label: t("tools.little") },
]);
const fieldEndianOptions = computed(() => [
  { value: "default", label: t("tools.endianDef") },
  { value: "big", label: t("tools.big") },
  { value: "little", label: t("tools.little") },
]);

watch(
  () => store.active,
  (item) => {
    if (!item) return;
    Object.assign(draft, clone(item));
    if (!draft.frame) draft.frame = { head: "", tail: "" };
    if (!draft.fields) draft.fields = [];
    useLength.value = Boolean(draft.frame.lengthField);
    useChecksum.value = Boolean(draft.frame.checksum);
    const sample = item.sample?.trim();
    if (sample && (!hex.value.trim() || hex.value.trim() === lastSample)) hex.value = sample;
    lastSample = sample || "";
  },
  { immediate: true },
);

watch(
  () => sessions.visibleMessages.length,
  () => {
    if (frames.value.length && hex.value.trim()) run();
  },
);

watch(
  pendingFrameParse,
  (text) => {
    if (!text) return;
    hex.value = text;
    pendingFrameParse.value = null;
    run();
  },
  { immediate: true },
);

function syncFlags() {
  if (useLength.value) {
    draft.frame.lengthField ??= { offset: 2, size: 1, includes: "body" };
  } else {
    draft.frame.lengthField = undefined;
  }
  if (useChecksum.value) {
    draft.frame.checksum ??= { offset: -2, size: 1, algo: "sum8" };
  } else {
    draft.frame.checksum = undefined;
  }
}

function schemaForParse(): FrameSchema {
  syncFlags();
  return clone(draft);
}

function firstPointAddr(): number | undefined {
  const point = ui.modbusPoints[0];
  return point && Number.isFinite(point.address) ? point.address : undefined;
}

function startHintFor(frameHex: string): number {
  const fromTable = firstPointAddr();
  if (fromTable != null) return fromTable;
  try {
    const mb = parseModbus(frameHex);
    return lastModbusStart(sessions.visibleMessages, {
      slave: mb.slave,
      func: mb.func,
    }) ?? 0;
  } catch {
    return lastModbusStart(sessions.visibleMessages) ?? 0;
  }
}

function onHexPaste(event: ClipboardEvent) {
  const next = takeHexPaste(event, hex.value);
  if (!next) return;
  event.preventDefault();
  hex.value = next.text;
  const el = event.target as HTMLTextAreaElement;
  void nextTick(() => el.setSelectionRange(next.caret, next.caret));
}

function run() {
  syncFlags();
  const formatted = formatHexDump(hex.value);
  if (formatted) hex.value = formatted;
  if (!hex.value.trim()) {
    frames.value = [];
    return;
  }
  const schema = schemaForParse();
  const parsed = parseFrames(schema, hex.value);
  frames.value = schemaLooksModbus(schema)
    ? parsed.map((frame) => enrichModbusFrame(frame, ui.modbusPoints, startHintFor(frame.hex)))
    : parsed;
}

function save() {
  if (readonly.value) return;
  syncFlags();
  if (!draft.name.trim()) {
    toast.error(t("pack.unnamed"));
    return;
  }
  store.upsert(clone(draft));
  toast.success(t("tools.saved"));
}

function loadJson() {
  try {
    const parsed = JSON.parse(jsonText.value) as FrameSchema;
    if (!parsed?.frame && !parsed?.fields) throw new Error(t("err.jsonMissing"));
    Object.assign(draft, {
      ...clone({ ...blankSchema(), ...parsed, schemaId: draft.schemaId, builtin: false }),
    });
    useLength.value = Boolean(draft.frame.lengthField);
    useChecksum.value = Boolean(draft.frame.checksum);
  } catch (err) {
    toast.error(err instanceof Error ? err.message : t("pack.badJson"));
  }
}

function dumpJson() {
  syncFlags();
  jsonText.value = JSON.stringify(
    {
      name: draft.name,
      endian: draft.endian,
      frame: draft.frame,
      fields: draft.fields,
    },
    null,
    2,
  );
  showJson.value = true;
}

async function copyPrompt() {
  try {
    await navigator.clipboard.writeText(SCHEMA_PROMPT);
    toast.success(t("common.copied"));
  } catch {
    toast.error(t("err.copyFail"));
  }
}

function addField() {
  const last = draft.fields[draft.fields.length - 1];
  const next = blankField();
  if (last && last.size !== "rest") next.offset = last.offset + Number(last.size);
  draft.fields.push(next);
}

function removeField(i: number) {
  draft.fields.splice(i, 1);
}

function fieldSize(field: FrameField) {
  return field.size === "rest" ? "rest" : String(field.size);
}

function setFieldSize(field: FrameField, raw: string | number) {
  const t = String(raw).trim().toLowerCase();
  field.size = t === "rest" ? "rest" : Math.max(0, Number(t) || 0);
}

function numOrEmpty(n: number | undefined) {
  return n == null || Number.isNaN(n) ? "" : String(n);
}

function kindClass(kind: ShownFrame["kind"]) {
  if (kind === "ok") return "text-rx";
  if (kind === "partial") return "text-warn";
  return "text-err";
}

function kindLabel(kind: ShownFrame["kind"]) {
  if (kind === "ok") return t("tools.frameOk");
  if (kind === "partial") return t("tools.framePartial");
  return t("tools.frameMiss");
}

function hexTokens(value: string) {
  return value.trim() ? value.trim().split(/\s+/) : [];
}

function statusNote(frame: ShownFrame) {
  if (!frame.note || frame.note === kindLabel(frame.kind)) return "";
  return frame.note;
}

function spanCovered(span: FrameSpan, spans: FrameSpan[]) {
  if (span.role !== "field" || span.size <= 1) return false;
  const smaller = spans.filter((item) => item.role === "field" && item.key !== span.key && item.size < span.size);
  for (let i = span.offset; i < span.offset + span.size; i += 1) {
    if (!smaller.some((item) => i >= item.offset && i < item.offset + item.size)) return false;
  }
  return true;
}

function legendOf(frame: ShownFrame) {
  const spans = frame.spans ?? [];
  const fields = spans.filter((span) => span.role === "field" && !spanCovered(span, spans));
  return spans
    .filter((span) => {
      if (spanCovered(span, spans)) return false;
      if (span.role === "field") return true;
      return !fields.some((field) => field.offset === span.offset && field.size === span.size);
    })
    .sort((a, b) => a.offset - b.offset || a.size - b.size);
}

function directionOf(frame: ShownFrame) {
  return frame.fields.find((field) => field.name === t("tools.direction"))?.value ?? "";
}

function shownFields(frame: ShownFrame) {
  const spans = frame.spans ?? [];
  const direction = t("tools.direction");
  return frame.fields.filter((field) => {
    if (field.name === direction) return false;
    const span = spans.find((item) => item.key === field.spanKey);
    return !span || !spanCovered(span, spans);
  });
}

function plainValue(value: string) {
  return value.replace(/\s*\((?:0x)?[0-9A-Fa-f ]+\)\s*$/, "").trim();
}

function spanLabel(span: FrameSpan) {
  if (span.role === "head") return t("tools.head");
  if (span.role === "tail") return t("tools.tail");
  if (span.role === "length") return t("tools.lenField");
  if (span.role === "checksum") return t("composer.checksum");
  return schemaLabel(span.name);
}

function spanClass(span: FrameSpan, checksumOk?: boolean) {
  if (span.role === "checksum") return checksumOk === false ? "bg-err/40" : "bg-rx/25";
  if (span.role === "head") return "bg-tx/20";
  if (span.role === "tail") return "ring-1 ring-inset ring-foreground/40";
  if (span.role === "length") return "bg-warn/25";
  return FIELD_TONES[(span.tone ?? 0) % FIELD_TONES.length] ?? FIELD_TONES[0];
}

function covering(spans: FrameSpan[], index: number) {
  return spans.filter((span) => index >= span.offset && index < span.offset + span.size);
}

function activeKey(frameIndex: number) {
  const prefix = `${frameIndex}:`;
  return hover.value.startsWith(prefix) ? hover.value.slice(prefix.length) : "";
}

function byteClass(frame: ShownFrame, frameIndex: number, byteIndex: number) {
  const spans = frame.spans ?? [];
  const cover = covering(spans, byteIndex);
  const active = activeKey(frameIndex);
  if (active.startsWith("point:")) {
    const point = frame.points?.[Number(active.slice(6))];
    const on = point?.byteOffset != null
      && point.byteSize != null
      && byteIndex >= point.byteOffset
      && byteIndex < point.byteOffset + point.byteSize;
    return on ? "bg-primary/35" : "opacity-30";
  }
  if (active) {
    const span = spans.find((item) => item.key === active);
    const on = span != null && byteIndex >= span.offset && byteIndex < span.offset + span.size;
    return on && span ? spanClass(span, frame.checksumOk) : "opacity-30";
  }
  if (cover.some((span) => span.role === "checksum") && frame.checksumOk === false) return "bg-err/40";
  const fields = cover.filter((span) => span.role === "field");
  if (fields.length) {
    const specific = [...fields].sort((a, b) => a.size - b.size)[0];
    return specific ? spanClass(specific, frame.checksumOk) : "";
  }
  const structural = cover.find((span) => span.role === "checksum")
    ?? cover.find((span) => span.role === "head")
    ?? cover.find((span) => span.role === "tail")
    ?? cover.find((span) => span.role === "length");
  return structural ? spanClass(structural, frame.checksumOk) : "";
}

function enter(frameIndex: number, key?: string) {
  hover.value = key ? `${frameIndex}:${key}` : "";
}

function enterByte(frame: ShownFrame, frameIndex: number, byteIndex: number) {
  const fields = covering(frame.spans ?? [], byteIndex).filter((span) => span.role === "field");
  const key = (fields.length ? [...fields].sort((a, b) => a.size - b.size)[0] : covering(frame.spans ?? [], byteIndex)[0])?.key;
  enter(frameIndex, key);
}

function pointAddr(item: DecodedPoint) {
  if (item.span && item.span > 1) return `${item.address}–${item.address + item.span - 1}`;
  return String(item.address);
}

function pointTitle(item: DecodedPoint) {
  return [pointAddr(item), item.raw, item.error].filter(Boolean).join(" · ");
}

function showRaw(value: string, raw: string) {
  return Boolean(raw) && raw !== value;
}
</script>

<template>
  <div :class="cn('flex h-full min-h-0', props.compact ? 'flex-col gap-2' : 'gap-3')">
    <div v-if="props.compact" class="shrink-0 space-y-1">
      <div class="flex gap-1">
        <AppSelect
          class="min-w-0 flex-1"
          :model-value="store.activeId"
          :options="schemaOptions"
          @update:model-value="store.select($event)"
        />
        <Button size="icon-xs" variant="outline" :title="t('common.new')" @click="store.create()">
          <Plus class="size-3.5" />
        </Button>
      </div>
      <div class="flex flex-wrap gap-1">
        <Button size="xs" variant="outline" @click="store.duplicate(store.activeId)">{{ t("common.copy") }}</Button>
        <Button size="xs" variant="outline" @click="importFrameSchemas()">{{ t("common.import") }}</Button>
        <Button size="xs" variant="outline" @click="exportFrameSchemas(store.snapshot())">{{ t("common.export") }}</Button>
        <Button size="xs" variant="outline" @click="copyPrompt">{{ t("tools.prompt") }}</Button>
        <Button
          size="xs"
          variant="ghost"
          class="text-err"
          :disabled="readonly"
          @click="store.active && store.remove(store.active.schemaId)"
        >
          {{ t("common.delete") }}
        </Button>
      </div>
    </div>
    <aside v-else class="flex w-44 shrink-0 flex-col border-r border-border pr-2">
      <div class="mb-2 flex items-center justify-between">
        <span class="text-xs text-muted-foreground">schema</span>
        <Button size="icon-xs" variant="ghost" :title="t('common.new')" @click="store.create()">
          <Plus class="size-3.5" />
        </Button>
      </div>
      <div class="min-h-0 flex-1 space-y-0.5 overflow-auto">
        <button
          v-for="item in store.sorted"
          :key="item.schemaId"
          type="button"
          :class="cn(
            'w-full truncate rounded-md px-2 py-1.5 text-left text-[13px]',
            store.activeId === item.schemaId ? 'bg-primary/12 text-primary' : 'text-muted-foreground hover:bg-foreground/5 hover:text-foreground',
          )"
          @click="store.select(item.schemaId)"
        >
          {{ schemaLabel(item.name) }}
        </button>
      </div>
      <div class="mt-2 flex flex-col gap-1">
        <Button size="xs" variant="outline" @click="store.duplicate(store.activeId)">{{ t("common.copy") }}</Button>
        <Button size="xs" variant="outline" @click="importFrameSchemas()">{{ t("common.import") }}</Button>
        <Button size="xs" variant="outline" @click="exportFrameSchemas(store.snapshot())">{{ t("common.export") }}</Button>
        <Button size="xs" variant="outline" @click="copyPrompt">{{ t("tools.prompt") }}</Button>
        <Button
          size="xs"
          variant="ghost"
          class="text-err"
          :disabled="readonly"
          @click="store.active && store.remove(store.active.schemaId)"
        >
          {{ t("common.delete") }}
        </Button>
      </div>
    </aside>

    <div :class="cn('flex min-h-0 min-w-0 flex-1 flex-col gap-2', props.compact ? '' : 'gap-3 overflow-auto')">
      <section class="shrink-0 space-y-1.5">
        <div class="flex items-center justify-between">
          <span class="text-[11px] text-muted-foreground">HEX</span>
          <div class="flex gap-1">
            <Button size="xs" variant="outline" @click="dumpJson">JSON</Button>
            <Button size="sm" @click="run">{{ t("common.parse") }}</Button>
          </div>
        </div>
        <Textarea
          v-model="hex"
          :class="cn('font-mono text-[13px]', props.compact ? 'min-h-20 resize-none' : 'min-h-24')"
          @paste="onHexPaste"
        />
        <div v-if="showJson" class="space-y-1">
          <Textarea v-model="jsonText" class="min-h-24 font-mono text-[12px]" :disabled="readonly" />
          <Button size="xs" variant="outline" :disabled="readonly" @click="loadJson">{{ t("tools.applyJson") }}</Button>
        </div>
      </section>

      <section :class="cn('space-y-2', props.compact ? 'min-h-0 flex-1 overflow-auto' : '')">
        <span class="text-[11px] text-muted-foreground">{{ t("tools.result") }}</span>
        <div v-if="!frames.length" class="rounded-md border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">
          —
        </div>
        <article
          v-for="(frame, i) in frames"
          :key="i"
          class="rounded-md border border-border bg-bg-1/70 px-3 py-2"
          @mouseleave="hover = ''"
        >
          <header class="mb-1 flex flex-wrap items-baseline gap-x-2 text-[11px]">
            <span :class="kindClass(frame.kind)">{{ kindLabel(frame.kind) }}</span>
            <span v-if="directionOf(frame)">{{ directionOf(frame) }}</span>
            <span v-if="statusNote(frame)" class="text-muted-foreground">{{ statusNote(frame) }}</span>
            <span v-if="frame.checksumOk != null" :class="frame.checksumOk ? 'text-rx' : 'text-err'">
              <template v-if="frame.checksumOk">
                {{ t("tools.crcOk") }}
                <span class="font-mono tabular-nums">{{ frame.checksumGot }}</span>
              </template>
              <template v-else>
                {{ t("tools.crcBad", { expect: frame.checksumExpect ?? "", got: frame.checksumGot ?? "" }) }}
              </template>
            </span>
          </header>
          <div class="selectable flex flex-wrap gap-x-1 gap-y-0.5 font-mono text-[12px] tabular-nums leading-5">
            <span
              v-for="(byte, bi) in hexTokens(frame.hex)"
              :key="bi"
              class="rounded-sm px-0.5"
              :class="byteClass(frame, i, bi)"
              @mouseenter="enterByte(frame, i, bi)"
            >{{ byte }}</span>
          </div>
          <div v-if="legendOf(frame).length" class="mt-1 flex flex-wrap gap-1">
            <span
              v-for="span in legendOf(frame)"
              :key="span.key"
              class="inline-flex items-center gap-1 rounded px-1 py-0.5 text-[10px] text-muted-foreground"
              @mouseenter="enter(i, span.key)"
            >
              <span class="inline-block size-2 rounded-sm" :class="spanClass(span, frame.checksumOk)" />
              {{ spanLabel(span) }}
            </span>
          </div>
          <table v-if="frame.points?.length" class="mt-2 w-full text-[12px]">
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
                v-for="(item, pi) in frame.points"
                :key="`${item.name}-${item.address}`"
                class="border-t border-border/60"
                :class="activeKey(i) === `point:${pi}` ? 'bg-primary/10' : ''"
                @mouseenter="enter(i, item.byteOffset == null ? undefined : `point:${pi}`)"
              >
                <td class="whitespace-nowrap py-0.5 pr-3" :title="pointTitle(item)">
                  <span class="mr-1 font-mono text-[11px] tabular-nums text-muted-foreground">{{ pointAddr(item) }}</span>
                  {{ item.name }}
                </td>
                <td class="py-0.5 pr-2 font-mono tabular-nums" :title="pointTitle(item)">{{ item.text }}</td>
                <td class="py-0.5 text-muted-foreground">{{ item.unit }}</td>
              </tr>
            </tbody>
          </table>
          <div
            v-if="shownFields(frame).length"
            :class="frame.points?.length ? 'mt-3 border-t border-border pt-2' : 'mt-2'"
          >
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
                v-for="(field, fi) in shownFields(frame)"
                :key="field.spanKey ?? `${field.name}-${fi}`"
                class="border-t border-border/60"
                :class="field.spanKey && activeKey(i) === field.spanKey ? 'bg-primary/10' : ''"
                @mouseenter="enter(i, field.spanKey)"
              >
                <td class="whitespace-nowrap py-0.5 pr-3">{{ schemaLabel(field.name) }}</td>
                <template v-if="showRaw(plainValue(field.value), field.raw)">
                  <td class="whitespace-nowrap py-0.5 pr-3 font-mono tabular-nums">
                    {{ plainValue(field.value) }}
                    <span v-if="field.unit" class="text-muted-foreground">{{ field.unit }}</span>
                  </td>
                  <td class="py-0.5 font-mono tabular-nums text-muted-foreground">{{ field.raw }}</td>
                </template>
                <td v-else colspan="2" class="py-0.5 font-mono tabular-nums">{{ field.raw || field.value }}</td>
              </tr>
            </tbody>
          </table>
          </div>
        </article>
      </section>

      <div v-if="props.compact" class="flex shrink-0 items-center gap-2 rounded-md border border-border px-2 py-1.5">
        <span class="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">schema · {{ schemaLabel(draft.name) }}</span>
        <Button size="xs" variant="outline" @click="schemaOpen = true">{{ t("common.edit") }}</Button>
      </div>
      <Dialog v-if="props.compact" v-model:open="schemaOpen">
        <DialogContent class="flex max-h-[min(640px,85vh)] w-[min(560px,92vw)] flex-col gap-3 overflow-hidden sm:max-w-[560px]">
          <DialogHeader>
            <DialogTitle class="text-sm">schema</DialogTitle>
          </DialogHeader>
          <div class="min-h-0 flex-1 space-y-2 overflow-auto">
          <div class="flex gap-1">
            <Input :model-value="readonly ? schemaLabel(draft.name) : draft.name" class="h-7 min-w-0 flex-1" :disabled="readonly" :placeholder="t('common.name')" @update:model-value="draft.name = String($event)" />
            <AppSelect
              class="w-20"
              :model-value="draft.endian ?? 'big'"
              :options="endianOptions"
              :disabled="readonly"
              @update:model-value="draft.endian = $event as FrameEndian"
            />
            <Button size="xs" :disabled="readonly" @click="save">{{ t("common.save") }}</Button>
          </div>
          <div class="grid grid-cols-2 gap-1.5">
            <Input v-model="draft.frame.head" class="h-7 font-mono" :disabled="readonly" :placeholder="t('tools.head')" />
            <Input v-model="draft.frame.tail" class="h-7 font-mono" :disabled="readonly" :placeholder="t('tools.tail')" />
          </div>
          <div class="flex gap-3 text-[11px] text-muted-foreground">
            <label class="flex items-center gap-1">
              <input v-model="useLength" type="checkbox" :disabled="readonly" @change="syncFlags" />
              {{ t("tools.lenField") }}
            </label>
            <label class="flex items-center gap-1">
              <input v-model="useChecksum" type="checkbox" :disabled="readonly" @change="syncFlags" />
              {{ t("composer.checksum") }}
            </label>
          </div>
          <div v-if="useLength" class="grid grid-cols-2 gap-1.5">
            <Input
              class="h-7 font-mono"
              :model-value="String(draft.frame.lengthField?.offset ?? 0)"
              :disabled="readonly"
              :placeholder="t('tools.lenOff')"
              @update:model-value="(draft.frame.lengthField ??= { offset: 0, size: 1 }).offset = Number($event) || 0"
            />
            <Input
              class="h-7 font-mono"
              :model-value="String(draft.frame.lengthField?.size ?? 1)"
              :disabled="readonly"
              :placeholder="t('tools.lenSize')"
              @update:model-value="(draft.frame.lengthField ??= { offset: 0, size: 1 }).size = Math.max(1, Number($event) || 1)"
            />
            <AppSelect
              :model-value="draft.frame.lengthField?.includes ?? 'body'"
              :options="[
                { value: 'body', label: 'body' },
                { value: 'after', label: 'after' },
                { value: 'frame', label: 'frame' },
              ]"
              :disabled="readonly"
              @update:model-value="(draft.frame.lengthField ??= { offset: 0, size: 1 }).includes = $event as 'body' | 'after' | 'frame'"
            />
            <Input
              class="h-7 font-mono"
              :model-value="String(draft.frame.lengthField?.adjust ?? 0)"
              :disabled="readonly"
              placeholder="adjust"
              @update:model-value="(draft.frame.lengthField ??= { offset: 0, size: 1 }).adjust = Number($event) || 0"
            />
          </div>
          <div v-if="useChecksum" class="grid grid-cols-2 gap-1.5">
            <Input
              class="h-7 font-mono"
              :model-value="String(draft.frame.checksum?.offset ?? -2)"
              :disabled="readonly"
              :placeholder="t('tools.crcOff')"
              @update:model-value="(draft.frame.checksum ??= { offset: -2, size: 1, algo: 'sum8' }).offset = Number($event) || 0"
            />
            <Input
              class="h-7 font-mono"
              :model-value="String(draft.frame.checksum?.size ?? 1)"
              :disabled="readonly"
              :placeholder="t('tools.crcSize')"
              @update:model-value="(draft.frame.checksum ??= { offset: -2, size: 1, algo: 'sum8' }).size = Math.max(1, Number($event) || 1)"
            />
            <AppSelect
              class="col-span-2"
              :model-value="draft.frame.checksum?.algo ?? 'sum8'"
              :options="[...CHECKSUM_ALGOS]"
              :disabled="readonly"
              @update:model-value="(draft.frame.checksum ??= { offset: -2, size: 1, algo: 'sum8' }).algo = $event"
            />
          </div>
          <div class="flex items-center justify-between">
            <span class="text-[11px] text-muted-foreground">{{ t("tools.field") }}</span>
            <Button size="xs" variant="outline" :disabled="readonly" @click="addField">{{ t("common.add") }}</Button>
          </div>
          <div v-if="!draft.fields.length" class="px-1 py-2 text-center text-[11px] text-muted-foreground">{{ t("tools.noFields") }}</div>
          <div
            v-for="(field, i) in draft.fields"
            :key="i"
            class="space-y-1 rounded-md border border-border px-2 py-1.5"
          >
            <div class="flex items-center gap-1">
              <Input :model-value="readonly ? schemaLabel(field.name) : field.name" class="h-7 min-w-0 flex-1" :placeholder="t('tools.fieldName')" :disabled="readonly" @update:model-value="field.name = String($event)" />
              <Input
                class="h-7 w-14 shrink-0 font-mono"
                :model-value="String(field.offset)"
                :disabled="readonly"
                placeholder="off"
                :title="t('tools.lenOff')"
                @update:model-value="field.offset = Number($event) || 0"
              />
              <Input
                class="h-7 w-12 shrink-0 font-mono"
                :model-value="fieldSize(field)"
                :disabled="readonly"
                placeholder="size"
                :title="t('tools.lenSize')"
                @update:model-value="setFieldSize(field, $event)"
              />
              <AppSelect
                class="w-auto shrink-0"
                :model-value="field.type"
                :options="FIELD_TYPES"
                :disabled="readonly"
                @update:model-value="field.type = $event as FrameField['type']"
              />
              <Button size="icon-xs" variant="ghost" class="text-err" :disabled="readonly" @click="removeField(i)">
                <Trash2 class="size-3.5" />
              </Button>
            </div>
            <div class="flex items-center gap-1">
              <AppSelect
                class="w-[4.75rem] shrink-0"
                :model-value="field.endian ?? 'default'"
                :options="fieldEndianOptions"
                :disabled="readonly"
                @update:model-value="field.endian = $event === 'default' ? undefined : ($event as FrameEndian)"
              />
              <Input
                class="h-7 w-16 shrink-0 font-mono"
                :model-value="numOrEmpty(field.scale)"
                :disabled="readonly"
                placeholder="scale"
                :title="t('tools.scale')"
                @update:model-value="field.scale = $event === '' ? undefined : Number($event)"
              />
              <Input
                class="h-7 w-16 shrink-0 font-mono"
                :model-value="numOrEmpty(field.bias)"
                :disabled="readonly"
                placeholder="bias"
                @update:model-value="field.bias = $event === '' ? undefined : Number($event)"
              />
              <Input v-model="field.unit" class="h-7 min-w-0 flex-1" :placeholder="t('tools.unit')" :disabled="readonly" />
            </div>
          </div>
          </div>
        </DialogContent>
      </Dialog>

      <template v-else>
        <section class="space-y-2">
          <div class="flex flex-wrap items-end gap-2">
            <label class="min-w-40 flex-1 text-[11px] text-muted-foreground">
              {{ t("common.name") }}
              <Input :model-value="readonly ? schemaLabel(draft.name) : draft.name" class="mt-1 h-7" :disabled="readonly" @update:model-value="draft.name = String($event)" />
            </label>
            <label class="w-28 text-[11px] text-muted-foreground">
              {{ t("tools.endian") }}
              <AppSelect
                class="mt-1"
                :model-value="draft.endian ?? 'big'"
                :options="endianOptions"
                :disabled="readonly"
                @update:model-value="draft.endian = $event as FrameEndian"
              />
            </label>
            <Button size="sm" :disabled="readonly" @click="save">{{ t("common.save") }}</Button>
          </div>
          <div class="grid grid-cols-4 gap-2">
            <label class="text-[11px] text-muted-foreground">
              {{ t("tools.head") }}
              <Input v-model="draft.frame.head" class="mt-1 h-7 font-mono" :disabled="readonly" />
            </label>
            <label class="text-[11px] text-muted-foreground">
              {{ t("tools.tail") }}
              <Input v-model="draft.frame.tail" class="mt-1 h-7 font-mono" :disabled="readonly" />
            </label>
            <label class="flex items-end gap-2 text-[11px] text-muted-foreground">
              <input v-model="useLength" type="checkbox" class="mb-1.5" :disabled="readonly" @change="syncFlags" />
              {{ t("tools.lenField") }}
            </label>
            <label class="flex items-end gap-2 text-[11px] text-muted-foreground">
              <input v-model="useChecksum" type="checkbox" class="mb-1.5" :disabled="readonly" @change="syncFlags" />
              {{ t("composer.checksum") }}
            </label>
          </div>
          <div v-if="useLength" class="grid grid-cols-4 gap-2">
            <label class="text-[11px] text-muted-foreground">
              {{ t("tools.lenOff") }}
              <Input
                class="mt-1 h-7 font-mono"
                :model-value="String(draft.frame.lengthField?.offset ?? 0)"
                :disabled="readonly"
                @update:model-value="(draft.frame.lengthField ??= { offset: 0, size: 1 }).offset = Number($event) || 0"
              />
            </label>
            <label class="text-[11px] text-muted-foreground">
              {{ t("tools.lenSize") }}
              <Input
                class="mt-1 h-7 font-mono"
                :model-value="String(draft.frame.lengthField?.size ?? 1)"
                :disabled="readonly"
                @update:model-value="(draft.frame.lengthField ??= { offset: 0, size: 1 }).size = Math.max(1, Number($event) || 1)"
              />
            </label>
            <label class="text-[11px] text-muted-foreground">
              {{ t("tools.includes") }}
              <AppSelect
                class="mt-1"
                :model-value="draft.frame.lengthField?.includes ?? 'body'"
                :options="[
                  { value: 'body', label: 'body' },
                  { value: 'after', label: 'after' },
                  { value: 'frame', label: 'frame' },
                ]"
                :disabled="readonly"
                @update:model-value="(draft.frame.lengthField ??= { offset: 0, size: 1 }).includes = $event as 'body' | 'after' | 'frame'"
              />
            </label>
            <label class="text-[11px] text-muted-foreground">
              adjust
              <Input
                class="mt-1 h-7 font-mono"
                :model-value="String(draft.frame.lengthField?.adjust ?? 0)"
                :disabled="readonly"
                @update:model-value="(draft.frame.lengthField ??= { offset: 0, size: 1 }).adjust = Number($event) || 0"
              />
            </label>
          </div>
          <div v-if="useChecksum" class="grid grid-cols-4 gap-2">
            <label class="text-[11px] text-muted-foreground">
              {{ t("tools.crcOff") }}
              <Input
                class="mt-1 h-7 font-mono"
                :model-value="String(draft.frame.checksum?.offset ?? -2)"
                :disabled="readonly"
                @update:model-value="(draft.frame.checksum ??= { offset: -2, size: 1, algo: 'sum8' }).offset = Number($event) || 0"
              />
            </label>
            <label class="text-[11px] text-muted-foreground">
              {{ t("tools.crcSize") }}
              <Input
                class="mt-1 h-7 font-mono"
                :model-value="String(draft.frame.checksum?.size ?? 1)"
                :disabled="readonly"
                @update:model-value="(draft.frame.checksum ??= { offset: -2, size: 1, algo: 'sum8' }).size = Math.max(1, Number($event) || 1)"
              />
            </label>
            <label class="col-span-2 text-[11px] text-muted-foreground">
              {{ t("tools.algo") }}
              <AppSelect
                class="mt-1"
                :model-value="draft.frame.checksum?.algo ?? 'sum8'"
                :options="[...CHECKSUM_ALGOS]"
                :disabled="readonly"
                @update:model-value="(draft.frame.checksum ??= { offset: -2, size: 1, algo: 'sum8' }).algo = $event"
              />
            </label>
          </div>
        </section>
        <section>
          <div class="mb-1 flex items-center justify-between">
            <span class="text-[11px] text-muted-foreground">{{ t("tools.field") }}</span>
            <Button size="xs" variant="outline" :disabled="readonly" @click="addField">{{ t("tools.addField") }}</Button>
          </div>
          <div v-if="!draft.fields.length" class="rounded-md border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground">
            {{ t("tools.noFields") }}
          </div>
          <div v-else class="space-y-1 pb-4">
            <div
              v-for="(field, i) in draft.fields"
              :key="i"
              class="grid grid-cols-[1fr_4.5rem_4.5rem_6.5rem_5.5rem_4.5rem_4.5rem_4rem_1.5rem] items-center gap-1"
            >
              <Input :model-value="readonly ? schemaLabel(field.name) : field.name" class="h-7" :placeholder="t('tools.fieldName')" :disabled="readonly" @update:model-value="field.name = String($event)" />
              <Input
                class="h-7 font-mono"
                :model-value="String(field.offset)"
                :disabled="readonly"
                placeholder="off"
                @update:model-value="field.offset = Number($event) || 0"
              />
              <Input
                class="h-7 font-mono"
                :model-value="fieldSize(field)"
                :disabled="readonly"
                placeholder="size"
                @update:model-value="setFieldSize(field, $event)"
              />
              <AppSelect
                :model-value="field.type"
                :options="FIELD_TYPES"
                :disabled="readonly"
                @update:model-value="field.type = $event as FrameField['type']"
              />
              <AppSelect
                :model-value="field.endian ?? 'default'"
                :options="fieldEndianOptions"
                :disabled="readonly"
                @update:model-value="field.endian = $event === 'default' ? undefined : ($event as FrameEndian)"
              />
              <Input
                class="h-7 font-mono"
                :model-value="numOrEmpty(field.scale)"
                :disabled="readonly"
                placeholder="scale"
                @update:model-value="field.scale = $event === '' ? undefined : Number($event)"
              />
              <Input
                class="h-7 font-mono"
                :model-value="numOrEmpty(field.bias)"
                :disabled="readonly"
                placeholder="bias"
                @update:model-value="field.bias = $event === '' ? undefined : Number($event)"
              />
              <Input v-model="field.unit" class="h-7" :placeholder="t('tools.unit')" :disabled="readonly" />
              <Button size="icon-xs" variant="ghost" class="text-err" :disabled="readonly" @click="removeField(i)">
                <Trash2 class="size-3.5" />
              </Button>
            </div>
          </div>
        </section>
      </template>
    </div>
  </div>
</template>
