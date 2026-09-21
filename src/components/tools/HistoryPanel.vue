<script setup lang="ts">
import { computed } from "vue";
import { toast } from "vue-sonner";
import { t } from "@/i18n";
import { useSessionsStore } from "@/stores/sessions";
import { Button } from "@/components/ui/button";
import { formatClock } from "@/lib/format";

const sessions = useSessionsStore();
const hasSession = computed(() => Boolean(sessions.activeSession && sessions.activeSession.protocol !== "http" && sessions.activeSession.protocol !== "ai"));
</script>

<template>
  <div class="flex h-full flex-col">
    <div v-if="sessions.history.length === 0" class="flex flex-1 items-center justify-center text-xs text-muted-foreground">
      {{ t("composer.noHistory") }}
    </div>
    <div v-else class="space-y-1 overflow-auto">
      <div
        v-for="item in sessions.history"
        :key="item.id"
        class="rounded-md border border-border px-2 py-2"
      >
        <div class="mb-1 flex items-center justify-between text-[11px] text-muted-foreground">
          <span>{{ item.sessionName }} · {{ item.mode.toUpperCase() }}</span>
          <span>{{ formatClock(item.timestamp) }}</span>
        </div>
        <div class="truncate font-mono text-xs">{{ item.content }}</div>
        <Button
          size="xs"
          variant="ghost"
          class="mt-1 h-6 px-1 text-[11px]"
          :disabled="!hasSession"
          @click="hasSession ? sessions.resendHistory(item) : toast.error(t('err.noActive'))"
        >
          {{ t("msg.resend") }}
        </Button>
      </div>
    </div>
  </div>
</template>
