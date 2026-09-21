<script setup lang="ts">
import { computed, ref } from "vue";
import { t } from "@/i18n";
import { compactHex, bytesToHex, hexLooksIllegal, hexToBytes } from "@/lib/hex";
import { decodeIeeeTable, formatIeee } from "@/lib/point-table";
import { insertToComposer } from "@/lib/composer-insert";
import RadixBytes from "@/components/common/RadixBytes.vue";
import { Button } from "@/components/ui/button";

const hex = ref("3F 80 00 00");

const parsed = computed(() => {
  const compact = compactHex(hex.value);
  if (!compact) return { error: t("tools.needIeee"), rows: [], show64: false };
  if (hexLooksIllegal(hex.value)) return { error: t("err.hexIllegal"), rows: [], show64: false };
  const bytes = hexToBytes(hex.value);
  if (bytes.length !== 4 && bytes.length !== 8) {
    return { error: t("tools.need48"), rows: [], show64: false };
  }
  return { error: "" as const, rows: decodeIeeeTable(bytes), show64: bytes.length === 8 };
});
</script>

<template>
  <RadixBytes v-model="hex" :placeholder="t('tools.ieeePh')" />
  <p v-if="parsed.error" class="text-[11px] text-muted-foreground">{{ parsed.error }}</p>
  <div v-else class="overflow-x-auto">
    <table class="w-full border-collapse font-mono text-[11px]">
      <thead>
        <tr class="text-left text-muted-foreground">
          <th class="py-0.5 pr-2 font-medium">{{ t("tools.orderCol") }}</th>
          <th class="py-0.5 pr-2 font-medium">HEX</th>
          <th class="py-0.5 pr-2 font-medium">f32</th>
          <th v-if="parsed.show64" class="py-0.5 pr-2 font-medium">f64</th>
          <th class="py-0.5 font-medium" />
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in parsed.rows" :key="row.order">
          <td class="whitespace-nowrap py-0.5 pr-2">{{ row.order }}</td>
          <td class="whitespace-nowrap py-0.5 pr-2">{{ bytesToHex(row.bytes) }}</td>
          <td class="whitespace-nowrap py-0.5 pr-2">{{ formatIeee(row.float32) }}</td>
          <td v-if="parsed.show64" class="whitespace-nowrap py-0.5 pr-2">{{ formatIeee(row.float64) }}</td>
          <td class="py-0.5">
            <Button size="xs" variant="ghost" class="h-5 px-1" @click="insertToComposer(bytesToHex(row.bytes), 'hex')">
              {{ t("common.insert") }}
            </Button>
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
