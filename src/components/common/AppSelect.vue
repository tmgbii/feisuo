<script setup lang="ts">
import { computed } from "vue";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import RadixToggle from "@/components/common/RadixToggle.vue";
import { toggleRadix, type NumericRadix } from "@/lib/radix";
import { cn } from "@/lib/utils";

export type SelectOption = string | number | { value: string | number; label: string };

const props = withDefaults(
  defineProps<{
    modelValue: string | number;
    options: SelectOption[];
    placeholder?: string;
    class?: string;
    size?: "sm" | "default";
    disabled?: boolean;
    radix?: NumericRadix;
  }>(),
  {
    size: "sm",
  },
);

const emit = defineEmits<{
  "update:modelValue": [value: string];
  "update:radix": [value: NumericRadix];
}>();

const items = computed(() =>
  props.options.map((opt) =>
    typeof opt === "object"
      ? { value: String(opt.value), label: opt.label }
      : { value: String(opt), label: String(opt) },
  ),
);

function onChange(value: string | number | bigint | Record<string, unknown> | null) {
  if (value == null) return;
  emit("update:modelValue", String(value));
}
</script>

<template>
  <Select
    :model-value="String(modelValue)"
    :disabled="disabled"
    @update:model-value="onChange"
  >
    <SelectTrigger
      :size="size"
      :class="cn('text-xs', props.class)"
    >
      <SelectValue :placeholder="placeholder" />
      <template #trailing>
        <RadixToggle
          v-if="radix"
          :radix="radix"
          @click="emit('update:radix', toggleRadix(radix))"
        />
      </template>
    </SelectTrigger>
    <SelectContent position="popper" class="min-w-[var(--reka-select-trigger-width)]">
      <SelectItem
        v-for="item in items"
        :key="item.value"
        :value="item.value"
        class="text-xs"
      >
        {{ item.label }}
      </SelectItem>
    </SelectContent>
  </Select>
</template>
