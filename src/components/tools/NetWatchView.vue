<script setup lang="ts">
import { t } from "@/i18n";
import NetWatch from "@/components/tools/NetWatch.vue";
import PageHelp from "@/components/common/PageHelp.vue";
</script>

<template>
  <div class="flex h-full min-h-0 flex-col p-5">
    <div class="mb-4 flex shrink-0 items-center gap-1">
      <h1 class="text-base font-medium">{{ t("rail.net") }}</h1>
      <PageHelp page="net" />
    </div>
    <div class="min-h-0 flex-1 overflow-hidden">
      <NetWatch />
    </div>
  </div>
</template>
