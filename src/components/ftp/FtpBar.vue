<script setup lang="ts">
import { computed } from "vue";
import { t } from "@/i18n";
import { isTauri } from "@/lib/ipc";
import type { FtpConfig, Session } from "@/types";
import { useSessionsStore } from "@/stores/sessions";
import PageHelp from "@/components/common/PageHelp.vue";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

const props = defineProps<{ session: Session }>();
const sessions = useSessionsStore();

const cfg = computed(() => props.session.config as FtpConfig);
const locked = computed(
  () => props.session.status === "connected" || props.session.status === "connecting",
);

function patch(data: Partial<FtpConfig>) {
  if (locked.value) return;
  sessions.updateConfig(props.session.id, data);
}
</script>

<template>
  <div class="border-b border-border bg-bg-1/40 px-3 py-2">
    <div class="flex flex-wrap items-center gap-2">
      <Input
        :model-value="cfg.host"
        :disabled="locked"
        class="h-7 w-36 font-mono text-xs"
        placeholder="host"
        @update:model-value="patch({ host: String($event) })"
      />
      <Input
        :model-value="cfg.port"
        :disabled="locked"
        class="h-7 w-16 font-mono text-xs"
        @update:model-value="patch({ port: Number($event) || 21 })"
      />
      <Input
        :model-value="cfg.user"
        :disabled="locked"
        class="h-7 w-28 font-mono text-xs"
        placeholder="user"
        @update:model-value="patch({ user: String($event) })"
      />
      <Input
        :model-value="cfg.password"
        :disabled="locked"
        class="h-7 w-36 text-xs"
        type="password"
        :placeholder="t('common.password')"
        @update:model-value="patch({ password: String($event) })"
      />
      <PageHelp page="ftp" />
      <Button
        size="sm"
        :variant="locked && session.status === 'connected' ? 'outline' : 'default'"
        :disabled="session.status === 'connecting'"
        @click="sessions.toggleConnect(session.id)"
      >
        {{ session.status === "connecting" ? t("status.connectingEllipsis") : session.status === "connected" ? t("status.disconnect") : t("status.connect") }}
      </Button>
      <span v-if="!isTauri()" class="text-[11px] text-muted-foreground">{{ t("common.needDesktop") }}</span>
      <span v-else class="text-[11px] text-muted-foreground">PASV</span>
    </div>
  </div>
</template>
