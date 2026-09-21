<script setup lang="ts">
import { computed, ref } from "vue";
import { t } from "@/i18n";
import { insertToComposer } from "@/lib/composer-insert";
import { formatRadix, parseRadix, type NumericRadix } from "@/lib/radix";
import AppSelect from "@/components/common/AppSelect.vue";
import RadixToggle from "@/components/common/RadixToggle.vue";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

const width = ref<8 | 16>(8);
const radix = ref<NumericRadix>("HEX");
const raw = ref("A5");

const mask = computed(() => (width.value === 8 ? 0xff : 0xffff));
const hexWidth = computed(() => width.value / 4);
const bits = computed(() => Array.from({ length: width.value }, (_, i) => width.value - 1 - i));
const value = computed(() => {
  const n = parseRadix(raw.value, radix.value);
  return n == null ? 0 : n & mask.value;
});

function sync(n: number) {
  raw.value = formatRadix(n & mask.value, radix.value, hexWidth.value);
}

function onWidth(next: string | number) {
  width.value = Number(next) === 16 ? 16 : 8;
  sync(value.value);
}

function toggleShownRadix() {
  const n = value.value;
  radix.value = radix.value === "HEX" ? "DEC" : "HEX";
  sync(n);
}

function toggleBit(i: number) {
  sync(value.value ^ (1 << i));
}

function on(i: number): boolean {
  return (value.value & (1 << i)) !== 0;
}

function insertHex() {
  insertToComposer(formatRadix(value.value, "HEX", hexWidth.value), "hex");
}
</script>

<template>
  <div class="flex gap-1">
    <div class="relative min-w-0 flex-1">
      <Input v-model="raw" class="h-7 pr-8 font-mono text-xs" />
      <RadixToggle
        class="absolute top-1/2 right-1.5 z-10 -translate-y-1/2"
        :radix="radix"
        @click="toggleShownRadix"
      />
    </div>
    <AppSelect
      :model-value="width"
      :options="[
        { value: 8, label: 'uint8' },
        { value: 16, label: 'uint16' },
      ]"
      class="w-[92px]"
      @update:model-value="onWidth"
    />
  </div>
  <div class="flex flex-wrap gap-0.5">
    <button
      v-for="i in bits"
      :key="i"
      type="button"
      class="flex h-9 w-7 flex-col items-center justify-center rounded border font-mono text-[10px] transition-colors"
      :class="
        on(i)
          ? 'border-primary/40 bg-primary/15 text-primary'
          : 'border-border text-muted-foreground hover:bg-foreground/5'
      "
      @click="toggleBit(i)"
    >
      <span>{{ i }}</span>
      <span>{{ on(i) ? 1 : 0 }}</span>
    </button>
  </div>
  <div class="flex items-center justify-between font-mono text-[11px] text-muted-foreground">
    <span>BIN {{ value.toString(2).padStart(width, "0") }}</span>
    <Button size="sm" variant="outline" @click="insertHex">{{ t("tools.insertHex") }}</Button>
  </div>
</template>
