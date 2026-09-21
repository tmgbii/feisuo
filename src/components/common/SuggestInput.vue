<script setup lang="ts">
import { computed, ref } from "vue";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

const props = defineProps<{
  modelValue: string;
  options: string[];
  placeholder?: string;
  class?: string;
}>();

const emit = defineEmits<{
  "update:modelValue": [value: string];
}>();

const open = ref(false);

const filtered = computed(() => {
  const q = props.modelValue.trim().toLowerCase();
  if (!q) return props.options;
  const hit = props.options.filter((item) => item.toLowerCase().includes(q));
  return hit.length ? hit : props.options;
});

function pick(value: string) {
  emit("update:modelValue", value);
  open.value = false;
}
</script>

<template>
  <div class="relative min-w-0 flex-1">
    <Input
      :model-value="modelValue"
      :placeholder="placeholder"
      :class="cn('h-7 text-xs', props.class)"
      autocomplete="off"
      @update:model-value="emit('update:modelValue', String($event))"
      @focus="open = true"
      @blur="open = false"
    />
    <div
      v-if="open && filtered.length"
      class="absolute z-30 mt-1 max-h-48 w-full overflow-auto rounded-md border border-border bg-popover py-1 shadow-md"
    >
      <button
        v-for="item in filtered"
        :key="item"
        type="button"
        class="flex w-full px-2 py-1 text-left font-mono text-[11px] text-foreground hover:bg-accent"
        :class="item === modelValue ? 'bg-accent' : ''"
        @mousedown.prevent="pick(item)"
      >
        {{ item }}
      </button>
    </div>
  </div>
</template>
