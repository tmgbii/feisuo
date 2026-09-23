<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { t } from "@/i18n";
import {
  formatOctal,
  formatSymbolic,
  MODE_BITS,
  MODE_PRESETS,
  parseMode,
} from "@/lib/chmod";
import { Input } from "@/components/ui/input";

const props = defineProps<{
  modelValue: string;
  isDir?: boolean;
}>();

const emit = defineEmits<{
  "update:modelValue": [value: string];
}>();

const parsed = computed(() => parseMode(props.modelValue));
const lastValid = ref(parsed.value ?? 0);
watch(parsed, (value) => {
  if (value !== null) lastValid.value = value;
});
const mode = computed(() => parsed.value ?? lastValid.value);
const invalid = computed(() => props.modelValue.trim() !== "" && parsed.value === null);

const rows = [
  { key: "files.owner", r: MODE_BITS.ownerR, w: MODE_BITS.ownerW, x: MODE_BITS.ownerX },
  { key: "files.group", r: MODE_BITS.groupR, w: MODE_BITS.groupW, x: MODE_BITS.groupX },
  { key: "files.other", r: MODE_BITS.otherR, w: MODE_BITS.otherW, x: MODE_BITS.otherX },
] as const;

function has(bit: number) {
  return (mode.value & bit) !== 0;
}

function setBit(bit: number, on: boolean) {
  const next = on ? mode.value | bit : mode.value & ~bit;
  emit("update:modelValue", formatOctal(next));
}

function setPreset(n: number) {
  emit("update:modelValue", formatOctal(n));
}
</script>

<template>
  <div class="space-y-3">
    <div class="overflow-hidden rounded-lg border border-border">
      <table class="w-full text-xs">
        <thead>
          <tr class="border-b border-border bg-bg-1/80 text-muted-foreground">
            <th class="w-[4.5rem] px-3 py-1.5 text-left font-medium" />
            <th class="px-2 py-1.5 text-center font-medium">r</th>
            <th class="px-2 py-1.5 text-center font-medium">w</th>
            <th class="px-2 py-1.5 text-center font-medium">x</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in rows" :key="row.key" class="border-b border-border last:border-0">
            <td class="px-3 py-1.5 text-muted-foreground">{{ t(row.key) }}</td>
            <td class="px-2 py-1.5 text-center">
              <input
                type="checkbox"
                class="accent-primary"
                :checked="has(row.r)"
                @change="setBit(row.r, ($event.target as HTMLInputElement).checked)"
              />
            </td>
            <td class="px-2 py-1.5 text-center">
              <input
                type="checkbox"
                class="accent-primary"
                :checked="has(row.w)"
                @change="setBit(row.w, ($event.target as HTMLInputElement).checked)"
              />
            </td>
            <td class="px-2 py-1.5 text-center">
              <input
                type="checkbox"
                class="accent-primary"
                :checked="has(row.x)"
                @change="setBit(row.x, ($event.target as HTMLInputElement).checked)"
              />
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <div class="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-muted-foreground">
      <label class="flex items-center gap-1.5">
        <input
          type="checkbox"
          class="accent-primary"
          :checked="has(MODE_BITS.setuid)"
          @change="setBit(MODE_BITS.setuid, ($event.target as HTMLInputElement).checked)"
        />
        setuid
      </label>
      <label class="flex items-center gap-1.5">
        <input
          type="checkbox"
          class="accent-primary"
          :checked="has(MODE_BITS.setgid)"
          @change="setBit(MODE_BITS.setgid, ($event.target as HTMLInputElement).checked)"
        />
        setgid
      </label>
      <label class="flex items-center gap-1.5">
        <input
          type="checkbox"
          class="accent-primary"
          :checked="has(MODE_BITS.sticky)"
          @change="setBit(MODE_BITS.sticky, ($event.target as HTMLInputElement).checked)"
        />
        sticky
      </label>
    </div>

    <div class="flex items-center gap-2">
      <Input
        class="h-8 w-[5.5rem] font-mono"
        :model-value="modelValue"
        :aria-invalid="invalid"
        @update:model-value="emit('update:modelValue', String($event))"
      />
      <span class="font-mono text-xs text-muted-foreground">{{ formatSymbolic(mode, isDir) }}</span>
    </div>

    <div class="flex flex-wrap gap-1">
      <button
        v-for="n in MODE_PRESETS"
        :key="n"
        type="button"
        class="rounded-md border border-border px-2 py-0.5 font-mono text-[11px] text-muted-foreground hover:bg-foreground/5 hover:text-foreground"
        :class="parsed === n ? 'border-primary/40 text-foreground' : ''"
        @click="setPreset(n)"
      >
        {{ formatOctal(n) }}
      </button>
    </div>
  </div>
</template>
