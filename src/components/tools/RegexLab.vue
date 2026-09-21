<script setup lang="ts">
import { computed, ref } from "vue";
import { t } from "@/i18n";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

const FLAG_OPTS = [
  { id: "g", label: "g" },
  { id: "i", label: "i" },
  { id: "m", label: "m" },
  { id: "s", label: "s" },
] as const;

const pattern = ref("\\d+");
const flags = ref("g");
const text = ref("temp=25.6, rh=41");

const result = computed(() => {
  if (!pattern.value) {
    return { error: "", parts: [{ text: text.value, hit: false }], count: 0, groups: [] as string[] };
  }
  let re: RegExp;
  try {
    const f = flags.value.includes("g") ? flags.value : `${flags.value}g`;
    re = new RegExp(pattern.value, f);
  } catch (err) {
    return {
      error: err instanceof Error ? err.message : t("tools.badRegex"),
      parts: [{ text: text.value, hit: false }],
      count: 0,
      groups: [] as string[],
    };
  }
  const parts: { text: string; hit: boolean }[] = [];
  const groups: string[] = [];
  let last = 0;
  let count = 0;
  let match: RegExpExecArray | null;
  let guard = 0;
  while ((match = re.exec(text.value)) !== null) {
    if (guard++ > 400) break;
    if (!match[0]) {
      re.lastIndex += 1;
      continue;
    }
    if (match.index > last) parts.push({ text: text.value.slice(last, match.index), hit: false });
    parts.push({ text: match[0], hit: true });
    last = match.index + match[0].length;
    count += 1;
    if (match.length > 1) groups.push(match.slice(1).join(" · "));
    if (!re.global) break;
  }
  if (last < text.value.length) parts.push({ text: text.value.slice(last), hit: false });
  if (!parts.length) parts.push({ text: text.value, hit: false });
  return { error: "", parts, count, groups };
});

function toggleFlag(id: string) {
  flags.value = flags.value.includes(id) ? flags.value.replace(id, "") : `${flags.value}${id}`;
}
</script>

<template>
  <div class="flex gap-1">
    <Input v-model="pattern" class="h-7 flex-1 font-mono text-xs" :placeholder="t('tools.regex')" />
    <button
      v-for="opt in FLAG_OPTS"
      :key="opt.id"
      type="button"
      class="h-7 w-7 rounded border font-mono text-[11px]"
      :class="
        flags.includes(opt.id)
          ? 'border-primary/40 bg-primary/15 text-primary'
          : 'border-border text-muted-foreground'
      "
      @click="toggleFlag(opt.id)"
    >
      {{ opt.label }}
    </button>
  </div>
  <Textarea v-model="text" class="min-h-14 font-mono text-[12px]" :placeholder="t('tools.regexText')" />
  <p v-if="result.error" class="text-[11px] text-destructive">{{ result.error }}</p>
  <div v-else class="rounded-md border border-border px-2 py-1.5 font-mono text-[12px] break-all whitespace-pre-wrap">
    <template v-for="(part, i) in result.parts" :key="i">
      <mark v-if="part.hit" class="rounded-sm bg-primary/25 text-foreground">{{ part.text }}</mark>
      <span v-else>{{ part.text }}</span>
    </template>
  </div>
  <p class="text-[11px] text-muted-foreground">{{ t("tools.matches", { n: result.count }) }}</p>
  <ul v-if="result.groups.length" class="space-y-0.5 font-mono text-[11px] text-muted-foreground">
    <li v-for="(g, i) in result.groups.slice(0, 8)" :key="i">{{ i + 1 }} {{ g }}</li>
  </ul>
</template>
