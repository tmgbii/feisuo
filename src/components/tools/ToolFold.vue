<script setup lang="ts">
import { computed } from "vue";
import { ChevronDown } from "@lucide/vue";

const props = defineProps<{
  title: string;
  modelValue: string;
}>();

const emit = defineEmits<{
  "update:modelValue": [value: string];
}>();

const open = computed(() => props.modelValue === props.title);

function toggle() {
  emit("update:modelValue", open.value ? "" : props.title);
}
</script>

<template>
  <section class="overflow-hidden rounded-md border border-border">
    <button
      type="button"
      class="flex w-full items-center justify-between gap-2 px-2 py-1.5 text-left hover:bg-foreground/5"
      @click="toggle"
    >
      <span class="text-[11px] font-medium">{{ title }}</span>
      <ChevronDown
        class="size-3.5 shrink-0 text-muted-foreground transition-transform"
        :class="open ? 'rotate-180' : ''"
      />
    </button>
    <div v-show="open" class="space-y-2 border-t border-border px-2 py-2">
      <slot />
    </div>
  </section>
</template>
