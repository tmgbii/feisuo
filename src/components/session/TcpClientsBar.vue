<script setup lang="ts">
import { computed } from "vue";
import { X } from "@lucide/vue";
import { t } from "@/i18n";
import type { Session } from "@/types";
import { useSessionsStore } from "@/stores/sessions";
import AppSelect from "@/components/common/AppSelect.vue";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

const props = defineProps<{ session: Session }>();
const sessions = useSessionsStore();

const clients = computed(() => sessions.tcpClients[props.session.id] ?? []);
const target = computed(() => sessions.tcpTarget[props.session.id] || "all");
const targetOptions = computed(() => [
  { value: "all", label: t("tcp.all") },
  ...clients.value.map((c) => ({ value: c.id, label: c.addr })),
]);
</script>

<template>
  <div class="flex flex-wrap items-center gap-2 border-b border-border bg-bg-1/25 px-3 py-1.5">
    <span class="text-[11px] text-muted-foreground">{{ t("tcp.clients", { n: clients.length }) }}</span>
    <AppSelect
      :model-value="target"
      :options="targetOptions"
      :disabled="clients.length === 0"
      class="w-[180px]"
      :placeholder="t('tcp.target')"
      @update:model-value="sessions.setTcpTarget(session.id, String($event))"
    />
    <div v-if="clients.length === 0" class="text-[11px] text-muted-foreground">{{ t("tcp.wait") }}</div>
    <div v-else class="flex flex-wrap items-center gap-1">
      <Badge
        v-for="client in clients"
        :key="client.id"
        variant="outline"
        class="gap-1 pr-1 font-mono text-[11px]"
      >
        <span class="size-2 rounded-full" :style="{ background: client.color }" />
        {{ client.addr }}
        <Button
          variant="ghost"
          size="icon-xs"
          class="size-5 text-muted-foreground hover:text-err"
          :title="t('tcp.kick')"
          @click="sessions.kickClient(session.id, client.id)"
        >
          <X class="size-3" />
        </Button>
      </Badge>
    </div>
  </div>
</template>
