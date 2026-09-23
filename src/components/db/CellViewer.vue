<script setup lang="ts">
import { computed } from "vue";
import { toast } from "vue-sonner";
import { t } from "@/i18n";
import type { CmLang } from "@/lib/codemirror";
import CodeEditor from "@/components/common/CodeEditor.vue";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

const props = defineProps<{
  column: string;
  type: string;
  value: string;
}>();

const emit = defineEmits<{
  close: [];
}>();

function looksJson(raw: string): boolean {
  const s = raw.trim();
  if (!(s.startsWith("{") && s.endsWith("}")) && !(s.startsWith("[") && s.endsWith("]"))) return false;
  try {
    JSON.parse(s);
    return true;
  } catch {
    return false;
  }
}

const lang = computed<CmLang>(() => {
  const ty = props.type.toLowerCase();
  if (ty.includes("json")) return "json";
  if (ty.includes("xml")) return "xml";
  if (ty.includes("yaml") || ty.includes("yml")) return "yaml";
  if (ty.includes("html")) return "html";
  if (/\bsql\b/.test(ty)) return "sql";
  return looksJson(props.value) ? "json" : "plain";
});

const text = computed(() => {
  if (lang.value !== "json") return props.value;
  try {
    return JSON.stringify(JSON.parse(props.value), null, 2);
  } catch {
    return props.value;
  }
});

const title = computed(() => [props.column, props.type].filter(Boolean).join(" · "));

async function copy() {
  try {
    await navigator.clipboard.writeText(text.value);
    toast.success(t("common.copied"));
  } catch {
    /* */
  }
}
</script>

<template>
  <Dialog :open="true" @update:open="(v: boolean) => { if (!v) emit('close') }">
    <DialogContent class="flex max-h-[90vh] w-[min(960px,92vw)] flex-col sm:max-w-[min(960px,92vw)]">
      <DialogHeader>
        <DialogTitle class="truncate pr-8 font-mono text-sm">{{ title }}</DialogTitle>
      </DialogHeader>
      <div class="h-[min(60vh,28rem)] min-h-0 overflow-hidden rounded-md border border-border">
        <CodeEditor :model-value="text" :language="lang" readonly />
      </div>
      <DialogFooter>
        <Button variant="outline" @click="copy">{{ t("common.copy") }}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
