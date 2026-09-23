<script setup lang="ts">
import { computed, nextTick } from "vue";
import type { HTMLAttributes } from "vue";
import { toast } from "vue-sonner";
import { t } from "@/i18n";
import type { DataMode } from "@/types";
import { bytesToHex, bytesToText, hexToBytes, isValidHex, takeHexPaste, textToBytes } from "@/lib/hex";
import { payloadFromMode } from "@/lib/radix";
import { cn } from "@/lib/utils";
import { Textarea } from "@/components/ui/textarea";
import RadixToggle from "@/components/common/RadixToggle.vue";

const props = defineProps<{
  modelValue: string;
  mode: DataMode;
  placeholder?: string;
  invalid?: boolean;
  class?: HTMLAttributes["class"];
}>();

const emit = defineEmits<{
  "update:modelValue": [value: string];
  "update:mode": [value: DataMode];
  keydown: [event: KeyboardEvent];
}>();

const radix = computed(() => payloadFromMode(props.mode));

function onPaste(event: ClipboardEvent) {
  if (props.mode !== "hex") return;
  const next = takeHexPaste(event, props.modelValue);
  if (!next) return;
  event.preventDefault();
  emit("update:modelValue", next.text);
  const el = event.target as HTMLTextAreaElement;
  void nextTick(() => el.setSelectionRange(next.caret, next.caret));
}

function onToggle() {
  if (props.mode === "hex") {
    if (props.modelValue.trim() && !isValidHex(props.modelValue)) {
      toast.error(t("err.hexIllegal"));
      return;
    }
    emit("update:modelValue", bytesToText(hexToBytes(props.modelValue)));
    emit("update:mode", "ascii");
    return;
  }
  emit("update:modelValue", bytesToHex(textToBytes(props.modelValue)));
  emit("update:mode", "hex");
}

const hint = computed(() => {
  if (props.placeholder) return props.placeholder;
  return props.mode === "hex" ? "01 03 00 00 00 01" : t("composer.text");
});
</script>

<template>
  <div :class="cn('relative', props.class)">
    <Textarea
      :model-value="modelValue"
      :placeholder="hint"
      :aria-invalid="invalid || undefined"
      class="selectable min-h-20 resize-none pr-10 font-mono text-[13px]"
      @update:model-value="emit('update:modelValue', String($event))"
      @paste="onPaste"
      @keydown="emit('keydown', $event)"
    />
    <RadixToggle
      class="absolute top-2 right-2 z-10"
      :radix="radix"
      other="STR"
      @click="onToggle"
    />
  </div>
</template>
