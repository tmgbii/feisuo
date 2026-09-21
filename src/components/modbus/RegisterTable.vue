<script setup lang="ts">
import { computed } from "vue";
import { t } from "@/i18n";
import RadixInput from "@/components/common/RadixInput.vue";
import RadixToggle from "@/components/common/RadixToggle.vue";
import { formatRadix, toggleRadix, type NumericRadix } from "@/lib/radix";

const COLS = 8;

const props = withDefaults(
  defineProps<{
    values: number[];
    start: number;
    changed?: Set<number>;
    radix?: NumericRadix;
  }>(),
  { radix: "DEC" },
);

const emit = defineEmits<{
  change: [addr: number, value: number];
  "update:radix": [value: NumericRadix];
}>();

const offsets = Array.from({ length: COLS }, (_, i) => i);

const rows = computed(() => {
  const out: { base: number; cells: { addr: number; value: number }[] }[] = [];
  for (let i = 0; i < props.values.length; i += COLS) {
    out.push({
      base: props.start + i,
      cells: props.values.slice(i, i + COLS).map((value, j) => ({
        addr: props.start + i + j,
        value,
      })),
    });
  }
  return out;
});

function label(n: number) {
  return formatRadix(n, props.radix, 4);
}
</script>

<template>
  <table class="w-full table-fixed border-collapse font-mono text-[11px]">
    <thead>
      <tr class="text-muted-foreground">
        <th class="w-[4.75rem] py-0.5 pr-1 text-right font-medium">
          <span class="inline-flex items-center justify-end gap-1">
            {{ t("lab.address") }}
            <RadixToggle :radix="radix" @click="emit('update:radix', toggleRadix(radix))" />
          </span>
        </th>
        <th v-for="n in offsets" :key="n" class="py-0.5 font-medium">+{{ n }}</th>
      </tr>
    </thead>
    <tbody>
      <tr v-for="row in rows" :key="row.base">
        <th class="py-0.5 pr-1 text-right font-normal text-muted-foreground">{{ label(row.base) }}</th>
        <td
          v-for="cell in row.cells"
          :key="cell.addr"
          class="p-0.5"
          :class="changed?.has(cell.addr) ? 'bg-primary/10' : ''"
        >
          <RadixInput
            :model-value="cell.value"
            :radix="radix"
            :hex-digits="4"
            hide-toggle
            :title="label(cell.addr)"
            class="w-full min-w-[2.75rem]"
            @update:model-value="emit('change', cell.addr, $event)"
          />
        </td>
        <td v-for="k in COLS - row.cells.length" :key="`e-${row.base}-${k}`" />
      </tr>
    </tbody>
  </table>
</template>
