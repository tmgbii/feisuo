<script setup lang="ts">
import { computed } from "vue";
import { Cable, Folder, Waypoints } from "@lucide/vue";
import { t } from "@/i18n";
import { isTauri } from "@/lib/ipc";
import type { Session, SshConfig } from "@/types";
import { useSessionsStore } from "@/stores/sessions";
import { useSshStore } from "@/stores/ssh";
import { useUiStore } from "@/stores/ui";
import AppSelect from "@/components/common/AppSelect.vue";
import SshKeyPick from "@/components/ssh/SshKeyPick.vue";
import PageHelp from "@/components/common/PageHelp.vue";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

const props = defineProps<{ session: Session }>();
const sessions = useSessionsStore();
const ssh = useSshStore();
const ui = useUiStore();

const cfg = computed(() => props.session.config as SshConfig);
const locked = computed(
  () => props.session.status === "connected" || props.session.status === "connecting",
);

function patch(data: Partial<SshConfig>) {
  if (locked.value) return;
  sessions.updateConfig(props.session.id, data);
}

function patchAuth(data: Partial<SshConfig["auth"]>) {
  patch({ auth: { ...cfg.value.auth, ...data } });
}

const authOptions = computed(() => [
  { value: "password", label: t("common.password") },
  { value: "key", label: t("common.key") },
]);
const connectLabel = computed(() =>
  props.session.status === "connecting"
    ? t("status.connectingEllipsis")
    : props.session.status === "connected"
      ? t("status.disconnect")
      : t("status.connect"),
);
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
        @update:model-value="patch({ port: Number($event) || 22 })"
      />
      <Input
        :model-value="cfg.user"
        :disabled="locked"
        class="h-7 w-24 font-mono text-xs"
        placeholder="user"
        @update:model-value="patch({ user: String($event) })"
      />
      <AppSelect
        :model-value="cfg.auth.method"
        :disabled="locked"
        :options="authOptions"
        class="w-[88px]"
        @update:model-value="patchAuth({ method: $event as 'password' | 'key' })"
      />
      <Input
        v-if="cfg.auth.method === 'password'"
        :model-value="cfg.auth.password"
        :disabled="locked"
        class="h-7 w-36 text-xs"
        type="password"
        :placeholder="t('common.password')"
        @update:model-value="patchAuth({ password: String($event) })"
      />
      <template v-else>
        <SshKeyPick
          :path="cfg.auth.keyPath"
          :disabled="locked"
          @update:path="patchAuth({ keyPath: $event })"
        />
        <Input
          :model-value="cfg.auth.keyPassphrase"
          :disabled="locked"
          class="h-7 w-28 text-xs"
          type="password"
          :placeholder="t('common.passphrase')"
          @update:model-value="patchAuth({ keyPassphrase: String($event) })"
        />
      </template>
      <PageHelp page="ssh" />
      <Button
        size="sm"
        :variant="locked && session.status === 'connected' ? 'outline' : 'default'"
        :disabled="session.status === 'connecting'"
        @click="sessions.toggleConnect(session.id)"
      >
        {{ connectLabel }}
      </Button>
      <div class="ml-auto flex items-center gap-1">
        <Button
          size="sm"
          variant="outline"
          :class="ssh.jumpOpen[session.id] ? 'text-foreground' : 'text-muted-foreground'"
          @click="ssh.jumpOpen[session.id] = !ssh.jumpOpen[session.id]"
        >
          <Waypoints class="size-3.5" />
          {{ t("common.jump") }}
          <span
            v-if="cfg.jumpEnabled"
            class="size-1.5 rounded-full bg-rx"
          />
        </Button>
        <Button
          size="sm"
          variant="outline"
          :class="ssh.filesOpen[session.id] ? 'text-foreground' : 'text-muted-foreground'"
          @click="ssh.filesOpen[session.id] = !ssh.filesOpen[session.id]"
        >
          <Folder class="size-3.5" />
          {{ t("common.files") }}
        </Button>
        <Button
          size="sm"
          variant="outline"
          :class="ssh.tunnelsOpen[session.id] ? 'text-foreground' : 'text-muted-foreground'"
          @click="ssh.tunnelsOpen[session.id] = !ssh.tunnelsOpen[session.id]"
        >
          <Cable class="size-3.5" />
          {{ t("common.tunnels") }}
        </Button>
        <span v-if="!isTauri()" class="text-[11px] text-muted-foreground">{{ t("common.needDesktop") }}</span>
        <span v-else-if="ui.settings.sshAutoReconnect" class="text-[11px] text-muted-foreground">{{ t("common.autoReconnect") }}</span>
      </div>
    </div>
  </div>
</template>
