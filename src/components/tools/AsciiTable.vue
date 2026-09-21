<script setup lang="ts">
import { computed, ref } from "vue";
import { t } from "@/i18n";
import { Input } from "@/components/ui/input";

const query = ref("");

const rows = computed(() =>
  Array.from({ length: 128 }, (_, code) => {
    const ch = code >= 32 && code < 127 ? String.fromCharCode(code) : "";
    return {
      code,
      hex: `0x${code.toString(16).padStart(2, "0").toUpperCase()}`,
      dec: String(code),
      char: ch,
      desc: code <= 32 || code === 127 ? t(`tools.asciiN.${code}`) : ch,
    };
  }),
);

const filtered = computed(() => {
  const q = query.value.trim().toLowerCase();
  if (!q) return rows.value;
  return rows.value.filter(
    (r) =>
      r.hex.toLowerCase().includes(q) ||
      r.dec.includes(q) ||
      r.char.toLowerCase() === q ||
      r.desc.toLowerCase().includes(q),
  );
});
</script>

<template>
  <div class="flex h-full flex-col">
    <Input v-model="query" class="mb-2 h-7 text-xs" placeholder="A / 0x41" />
    <div class="min-h-0 flex-1 overflow-auto rounded-md border border-border">
      <table class="w-full text-left text-[11px]">
        <thead class="sticky top-0 bg-bg-2 text-muted-foreground">
          <tr>
            <th class="px-2 py-1 font-medium">HEX</th>
            <th class="px-2 py-1 font-medium">DEC</th>
            <th class="px-2 py-1 font-medium">{{ t("tools.asciiChar") }}</th>
            <th class="px-2 py-1 font-medium">{{ t("tools.asciiDesc") }}</th>
          </tr>
        </thead>
        <tbody class="font-mono">
          <tr v-for="row in filtered" :key="row.code" class="border-t border-border hover:bg-foreground/5">
            <td class="px-2 py-1 text-primary">{{ row.hex }}</td>
            <td class="px-2 py-1">{{ row.dec }}</td>
            <td class="px-2 py-1">{{ row.char || "·" }}</td>
            <td class="px-2 py-1 font-sans text-muted-foreground">{{ row.desc }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
