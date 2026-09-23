<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { toast } from "vue-sonner";
import { t } from "@/i18n";
import { minifyJson, prettyJson } from "@/lib/convert";
import { insertToComposer } from "@/lib/composer-insert";
import { jsonSeed } from "@/lib/tool-bridge";
import { Button } from "@/components/ui/button";
import CodeEditor from "@/components/common/CodeEditor.vue";

const input = ref("");
const output = ref("");
const jsonOkOnly = ref(false);
const hasResult = computed(() => Boolean(output.value) && !jsonOkOnly.value);

watch(
  jsonSeed,
  (text) => {
    if (!text) return;
    input.value = text;
    jsonOkOnly.value = false;
    try {
      output.value = prettyJson(text);
    } catch {
      output.value = "";
    }
    jsonSeed.value = "";
  },
  { immediate: true },
);

function run(mode: "pretty" | "minify" | "check") {
  jsonOkOnly.value = false;
  try {
    if (mode === "pretty") output.value = prettyJson(input.value);
    else if (mode === "minify") output.value = minifyJson(input.value);
    else {
      JSON.parse(input.value);
      output.value = t("err.jsonOk");
      jsonOkOnly.value = true;
    }
  } catch (err) {
    output.value = "";
    toast.error(err instanceof Error ? err.message : t("err.jsonBad"));
  }
}

async function paste() {
  try {
    const text = (await navigator.clipboard.readText()).trim();
    if (!text) {
      toast.error(t("err.clipboardEmpty"));
      return;
    }
    input.value = text;
    jsonOkOnly.value = false;
    try {
      output.value = prettyJson(text);
    } catch {
      output.value = "";
    }
  } catch {
    toast.error(t("err.clipboardFail"));
  }
}

async function copyOut() {
  if (!hasResult.value) return;
  await navigator.clipboard.writeText(output.value);
  toast.success(t("common.copied"));
}

function insert() {
  if (!hasResult.value) return;
  insertToComposer(output.value, "ascii");
}
</script>

<template>
  <div class="flex h-full min-h-0 flex-col gap-2">
    <div class="flex shrink-0 flex-wrap gap-1">
      <Button size="sm" @click="run('pretty')">{{ t("tools.pretty") }}</Button>
      <Button size="sm" variant="outline" @click="run('minify')">{{ t("tools.minify") }}</Button>
      <Button size="sm" variant="outline" @click="run('check')">{{ t("composer.checksum") }}</Button>
      <Button size="sm" variant="outline" @click="paste">{{ t("common.paste") }}</Button>
      <Button size="sm" variant="outline" :disabled="!hasResult" @click="copyOut">{{ t("common.copy") }}</Button>
      <Button size="sm" variant="outline" :disabled="!hasResult" @click="insert">{{ t("common.insert") }}</Button>
    </div>
    <div class="min-h-0 flex-1 overflow-hidden rounded-md border border-border bg-bg-1/80">
      <CodeEditor v-model="input" language="json" placeholder="JSON" lint />
    </div>
    <div class="min-h-0 flex-1 overflow-hidden rounded-md border border-border bg-bg-1/80">
      <pre
        v-if="jsonOkOnly"
        class="selectable h-full overflow-auto p-3 font-mono text-[13px] leading-5 whitespace-pre-wrap"
      >{{ output }}</pre>
      <CodeEditor v-else :model-value="output" language="json" readonly />
    </div>
  </div>
</template>
