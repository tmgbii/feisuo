<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import type { HTMLAttributes } from "vue";
import { cn } from "@/lib/utils";
import { formatRadix, parseRadix, toggleRadix, type NumericRadix } from "@/lib/radix";
import { Input } from "@/components/ui/input";
import RadixToggle from "@/components/common/RadixToggle.vue";

const props = withDefaults(
  defineProps<{
    modelValue?: string | number;
    radix?: NumericRadix;
    hexDigits?: number;
    placeholder?: string;
    class?: HTMLAttributes["class"];
    title?: string;
    hideToggle?: boolean;
  }>(),
  {
    radix: "DEC",
    hexDigits: 2,
  },
);

const emit = defineEmits<{
  "update:modelValue": [value: number];
  "update:radix": [value: NumericRadix];
}>();

const current = ref<NumericRadix>(props.radix);
const focused = ref(false);
const draft = ref("");

watch(
  () => props.radix,
  (value) => {
    current.value = value;
  },
);

const numeric = computed(() => {
  if (typeof props.modelValue === "number") return props.modelValue;
  if (props.modelValue == null || props.modelValue === "") return null;
  return parseRadix(String(props.modelValue), current.value);
});

const shown = computed(() => {
  if (focused.value) return draft.value;
  if (numeric.value == null) return "";
  return formatRadix(numeric.value, current.value, props.hexDigits);
});

function commit(raw: string) {
  const n = parseRadix(raw, current.value);
  if (n == null) return;
  emit("update:modelValue", n);
}

function onFocus() {
  focused.value = true;
  draft.value =
    numeric.value == null ? "" : formatRadix(numeric.value, current.value, props.hexDigits);
}

function onBlur() {
  commit(draft.value);
  focused.value = false;
}

onBeforeUnmount(() => {
  if (focused.value) commit(draft.value);
});

function onToggle() {
  const n = parseRadix(focused.value ? draft.value : shown.value, current.value) ?? numeric.value;
  current.value = toggleRadix(current.value);
  emit("update:radix", current.value);
  if (n != null) {
    emit("update:modelValue", n);
    draft.value = formatRadix(n, current.value, props.hexDigits);
  }
}
</script>

<template>
  <div :class="cn('relative min-w-0', props.class)">
    <Input
      :model-value="shown"
      :placeholder="placeholder"
      :title="title"
      :class="hideToggle ? 'h-7 pr-2 font-mono text-xs' : 'h-7 pr-8 font-mono text-xs'"
      @focus="onFocus"
      @blur="onBlur"
      @update:model-value="draft = String($event); commit(draft)"
    />
    <RadixToggle
      v-if="!hideToggle"
      class="absolute top-1/2 right-1.5 z-10 -translate-y-1/2"
      :radix="current"
      @click="onToggle"
    />
  </div>
</template>
