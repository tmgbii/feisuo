<script setup lang="ts">
import type { Session } from "@/types";
import { t } from "@/i18n";
import { isTauri } from "@/lib/ipc";
import FtpBar from "@/components/ftp/FtpBar.vue";
import FtpFiles from "@/components/ftp/FtpFiles.vue";

defineProps<{ session: Session }>();
</script>

<template>
  <div class="flex h-full min-h-0 flex-col">
    <FtpBar :session="session" />
    <div
      v-if="!isTauri()"
      class="flex min-h-0 flex-1 items-center justify-center text-sm text-muted-foreground"
    >
      {{ t("common.needDesktop") }}
    </div>
    <FtpFiles v-else :session="session" />
  </div>
</template>
