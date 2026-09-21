<script setup lang="ts">
import { computed, reactive, ref, watch } from "vue";
import { Plus, Trash2 } from "@lucide/vue";
import { toast } from "vue-sonner";
import { t } from "@/i18n";
import { parseFrames } from "@/lib/frame-engine";
import { enrichModbusFrame, schemaLooksModbus, type ShownFrame } from "@/lib/frame-modbus";
import { parseModbus } from "@/lib/modbus";
import {
  blankField,
  blankSchema,
  CHECKSUM_ALGOS,
  FIELD_TYPES,
  METER_FIXTURE,
  METER_FIXTURE_HEX,
  schemaLabel,
  type FrameEndian,
  type FrameField,
  type FrameSchema,
} from "@/lib/frame-schema";
import { SCHEMA_PROMPT } from "@/lib/frame-builtins";
import { exportFrameSchemas, importFrameSchemas } from "@/lib/frame-pack";
import { pendingFrameParse } from "@/lib/tool-bridge";
import { useFrameSchemasStore } from "@/stores/frame-schemas";
import { useSessionsStore } from "@/stores/sessions";
import { useUiStore } from "@/stores/ui";
import AppSelect from "@/components/common/AppSelect.vue";
import ToolFold from "@/components/tools/ToolFold.vue";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

const props = defineProps<{ compact?: boolean }>();
const store = useFrameSchemasStore();
const sessions = useSessionsStore();
const ui = useUiStore();
const hex = ref(METER_FIXTURE_HEX);
const frames = ref<ShownFrame[]>([]);
const jsonText = ref("");
const showJson = ref(false);
const useLength = ref(true);
const useChecksum = ref(true);
const fold = ref("");
let lastSample = METER_FIXTURE.sample ?? METER_FIXTURE_HEX;

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

function lastTxStart(): number {
  for (const message of [...sessions.visibleMessages].reverse()) {
    if (message.direction !== "tx") continue;
    try {
      const addr = parseModbus(message.hex).address;
      if (addr != null) return addr;
    } catch {
      /* skip */
    }
  }
  return 0;
}

function run() {
  syncFlags();
  if (!hex.value.trim()) {
    frames.value = [];
    return;
  }
  const schema = schemaForParse();
  const parsed = parseFrames(schema, hex.value);
  frames.value = schemaLooksModbus(schema)
    ? parsed.map((frame) => enrichModbusFrame(frame, ui.modbusPoints, lastTxStart()))
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
  if (props.compact) fold.value = "schema";
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
        >
          <header class="mb-1 flex flex-wrap items-center gap-2 text-[11px]">
            <span :class="kindClass(frame.kind)">{{ kindLabel(frame.kind) }}</span>
            <span v-if="frame.note" class="text-muted-foreground">{{ frame.note }}</span>
            <span
              v-if="frame.checksumOk != null"
              :class="frame.checksumOk ? 'text-rx' : 'text-err'"
            >
              {{ frame.checksumOk ? t("tools.crcOk") : t("tools.crcBad", { expect: frame.checksumExpect ?? "", got: frame.checksumGot ?? "" }) }}
            </span>
          </header>
          <pre class="font-mono text-[12px] break-all whitespace-pre-wrap text-muted-foreground">{{ frame.hex }}</pre>
          <div v-if="frame.points?.length" class="mt-2 space-y-1 rounded-md border border-primary/30 bg-primary/5 px-2 py-1.5">
            <div
              v-for="item in frame.points"
              :key="`${item.name}-${item.address}`"
              class="flex items-baseline justify-between gap-2 text-[12px]"
            >
              <span class="text-muted-foreground">{{ item.name }}</span>
              <span class="font-mono">
                {{ item.text }}
                <span v-if="item.unit" class="text-muted-foreground">{{ item.unit }}</span>
              </span>
            </div>
          </div>
          <table v-if="frame.fields.length" class="mt-2 w-full text-[12px]">
            <thead class="text-[11px] text-muted-foreground">
              <tr>
                <th class="py-0.5 text-left font-medium">{{ t("tools.field") }}</th>
                <th class="py-0.5 text-left font-medium">{{ t("tools.value") }}</th>
                <th class="py-0.5 text-left font-medium">{{ t("tools.raw") }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="field in frame.fields" :key="field.name" class="border-t border-border/60">
                <td class="py-0.5 pr-2">{{ schemaLabel(field.name) }}</td>
                <td class="py-0.5 pr-2 font-mono">{{ field.value }}</td>
                <td class="py-0.5 font-mono text-muted-foreground">{{ field.raw }}</td>
              </tr>
            </tbody>
          </table>
        </article>
      </section>

      <ToolFold v-if="props.compact" v-model="fold" title="schema" class="shrink-0">
        <div class="max-h-64 space-y-2 overflow-auto">
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
            class="space-y-1 rounded-md border border-border p-1.5"
          >
            <div class="flex gap-1">
              <Input :model-value="readonly ? schemaLabel(field.name) : field.name" class="h-7 min-w-0 flex-1" :placeholder="t('tools.fieldName')" :disabled="readonly" @update:model-value="field.name = String($event)" />
              <Button size="icon-xs" variant="ghost" class="text-err" :disabled="readonly" @click="removeField(i)">
                <Trash2 class="size-3.5" />
              </Button>
            </div>
            <div class="grid grid-cols-3 gap-1">
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
            </div>
            <div class="grid grid-cols-2 gap-1">
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
            </div>
          </div>
        </div>
      </ToolFold>

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
