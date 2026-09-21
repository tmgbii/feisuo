<script setup lang="ts">
import { t } from "@/i18n";
import type { Radix } from "@/lib/radix";

const props = withDefaults(
  defineProps<{
    radix: Radix;
    other?: Exclude<Radix, "HEX">;
  }>(),
  { other: "DEC" },
);

defineEmits<{
  click: [];
}>();

const next = () => (props.radix === "HEX" ? props.other : "HEX");
</script>

<template>
  <button
    type="button"
    class="inline-flex shrink-0 cursor-pointer items-center border-0 bg-transparent p-0 font-mono text-[9px] leading-none font-medium tracking-wide text-muted-foreground transition-colors select-none hover:text-primary"
    :title="t('common.switchTo', { v: next() })"
    @pointerdown.stop
    @mousedown.stop
    @click.stop.prevent="$emit('click')"
  >
    {{ radix }}
  </button>
</template>
