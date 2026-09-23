<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import type { HTMLAttributes } from "vue";
import { bytesToHex, hexToBytes, takeHexPaste } from "@/lib/hex";
import { toggleRadix, type NumericRadix } from "@/lib/radix";
import { cn } from "@/lib/utils";
import { Textarea } from "@/components/ui/textarea";
import RadixToggle from "@/components/common/RadixToggle.vue";

const props = defineProps<{
  modelValue: string;
  placeholder?: string;
  class?: HTMLAttributes["class"];
  formatPaste?: (text: string) => string | null;
}>();

const emit = defineEmits<{
  "update:modelValue": [value: string];
}>();

const radix = ref<NumericRadix>("HEX");
const focused = ref(false);
const draft = ref("");

function toDec(hex: string): string {
  const bytes = hexToBytes(hex);
  return bytes.length ? bytes.join(" ") : "";
}

function toHex(dec: string): string | null {
  const parts = dec.trim().split(/[\s,]+/).filter(Boolean);
  if (!parts.length) return "";
  const bytes: number[] = [];
  for (const part of parts) {
    const n = Number.parseInt(part, 10);
    if (Number.isNaN(n) || n < 0 || n > 255) return null;
    bytes.push(n);
  }
  return bytesToHex(bytes);
}

const shown = computed(() => {
  if (focused.value) return draft.value;
  if (radix.value === "HEX") return props.modelValue;
  return toDec(props.modelValue);
});

watch(
  () => props.modelValue,
  (hex) => {
    if (focused.value) return;
    draft.value = radix.value === "HEX" ? hex : toDec(hex);
  },
);

function onFocus() {
  draft.value = radix.value === "HEX" ? props.modelValue : toDec(props.modelValue);
  focused.value = true;
}

function commit(raw: string) {
  if (radix.value === "HEX") {
    emit("update:modelValue", raw);
    return;
  }
  const hex = toHex(raw);
  if (hex == null) return;
  emit("update:modelValue", hex);
}

function onInput(raw: string) {
  draft.value = raw;
  commit(raw);
}

function onPaste(event: ClipboardEvent) {
  if (radix.value !== "HEX") return;
  const clip = event.clipboardData?.getData("text") ?? "";
  const el = event.target as HTMLTextAreaElement | null;
  const current = shown.value;
  const start = el?.selectionStart ?? current.length;
  const end = el?.selectionEnd ?? start;
  const merged = current.slice(0, start) + clip + current.slice(end);
  if (props.formatPaste && merged.trim().startsWith(":")) {
    const text = props.formatPaste(merged);
    if (text) {
      event.preventDefault();
      draft.value = text;
      commit(text);
      void nextTick(() => el?.setSelectionRange(text.length, text.length));
      return;
    }
  }
  const next = takeHexPaste(event, shown.value);
  if (!next) return;
  event.preventDefault();
  draft.value = next.text;
  commit(next.text);
  void nextTick(() => el?.setSelectionRange(next.caret, next.caret));
}

function onBlur() {
  commit(draft.value);
  focused.value = false;
}

onBeforeUnmount(() => {
  if (focused.value) commit(draft.value);
});

function onToggle() {
  let hex = props.modelValue;
  if (radix.value === "HEX") {
    hex = focused.value ? draft.value : props.modelValue;
    emit("update:modelValue", hex);
  } else {
    const converted = toHex(focused.value ? draft.value : shown.value);
    if (converted != null) {
      hex = converted;
      emit("update:modelValue", hex);
    }
  }
  radix.value = toggleRadix(radix.value);
  draft.value = radix.value === "HEX" ? hex : toDec(hex);
}
</script>

<template>
  <div :class="cn('relative', props.class)">
    <Textarea
      :model-value="shown"
      :placeholder="placeholder ?? (radix === 'HEX' ? '01 03 00 00 00 01 84 0A' : '1 3 0 0 0 1 132 10')"
      class="min-h-16 pr-10 font-mono text-[12px]"
      @focus="onFocus"
      @blur="onBlur"
      @update:model-value="onInput(String($event))"
      @paste="onPaste"
    />
    <RadixToggle
      class="absolute top-2 right-2 z-10"
      :radix="radix"
      @click="onToggle"
    />
  </div>
</template>
