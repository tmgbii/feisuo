<script setup lang="ts">
import { computed } from "vue";
import { t } from "@/i18n";
import { pickLocalFiles } from "@/lib/ipc";
import { fileName } from "@/lib/format";
import { Button } from "@/components/ui/button";

const props = defineProps<{
  path: string;
  disabled?: boolean;
}>();
const emit = defineEmits<{ "update:path": [string] }>();

const label = computed(() => (props.path ? fileName(props.path) : t("common.pickKey")));

async function pick() {
  if (props.disabled) return;
  const files = await pickLocalFiles({ title: t("common.key") });
  const next = files[0];
  if (next) emit("update:path", next);
}
</script>

<template>
  <Button
    size="sm"
    variant="outline"
    class="max-w-48 truncate font-mono text-xs"
    :disabled="disabled"
    :title="path || t('common.pickKey')"
    @click="pick"
  >
    {{ label }}
  </Button>
</template>
