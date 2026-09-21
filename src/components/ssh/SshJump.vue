<script setup lang="ts">
import { computed } from "vue";
import { t } from "@/i18n";
import type { Session, SshConfig } from "@/types";
import { useSessionsStore } from "@/stores/sessions";
import AppSelect from "@/components/common/AppSelect.vue";
import SshKeyPick from "@/components/ssh/SshKeyPick.vue";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

const props = defineProps<{ session: Session }>();
const sessions = useSessionsStore();

const cfg = computed(() => props.session.config as SshConfig);
const locked = computed(
  () => props.session.status === "connected" || props.session.status === "connecting",
);

function patch(data: Partial<SshConfig>) {
  if (locked.value) return;
  sessions.updateConfig(props.session.id, data);
}

function patchJump(data: Partial<SshConfig["jump"]>) {
  patch({ jump: { ...cfg.value.jump, ...data } });
}

function patchJumpAuth(data: Partial<SshConfig["jump"]["auth"]>) {
  patchJump({ auth: { ...cfg.value.jump.auth, ...data } });
}

const authOptions = computed(() => [
  { value: "password", label: t("common.password") },
  { value: "key", label: t("common.key") },
]);
</script>

<template>
  <div class="border-b border-border bg-bg-1/40 px-3 py-2">
    <div class="flex flex-wrap items-center gap-2">
      <span class="text-[11px] text-muted-foreground">{{ t("common.jump") }}</span>
      <Button
        size="sm"
        variant="outline"
        :class="cfg.jumpEnabled ? 'text-foreground' : 'text-muted-foreground'"
        :disabled="locked"
        @click="patch({ jumpEnabled: !cfg.jumpEnabled })"
      >
        {{ cfg.jumpEnabled ? t("common.on") : t("common.off") }}
      </Button>
      <Input
        :model-value="cfg.jump.host"
        :disabled="locked"
        class="h-7 w-36 font-mono text-xs"
        placeholder="host"
        @update:model-value="patchJump({ host: String($event) })"
      />
      <Input
        :model-value="cfg.jump.port"
        :disabled="locked"
        class="h-7 w-16 font-mono text-xs"
        @update:model-value="patchJump({ port: Number($event) || 22 })"
      />
      <Input
        :model-value="cfg.jump.user"
        :disabled="locked"
        class="h-7 w-24 font-mono text-xs"
        placeholder="user"
        @update:model-value="patchJump({ user: String($event) })"
      />
      <AppSelect
        :model-value="cfg.jump.auth.method"
        :disabled="locked"
        :options="authOptions"
        class="w-[88px]"
        @update:model-value="patchJumpAuth({ method: $event as 'password' | 'key' })"
      />
      <Input
        v-if="cfg.jump.auth.method === 'password'"
        :model-value="cfg.jump.auth.password"
        :disabled="locked"
        class="h-7 w-36 text-xs"
        type="password"
        :placeholder="t('common.password')"
        @update:model-value="patchJumpAuth({ password: String($event) })"
      />
      <template v-else>
        <SshKeyPick
          :path="cfg.jump.auth.keyPath"
          :disabled="locked"
          @update:path="patchJumpAuth({ keyPath: $event })"
        />
        <Input
          :model-value="cfg.jump.auth.keyPassphrase"
          :disabled="locked"
          class="h-7 w-28 text-xs"
          type="password"
          :placeholder="t('common.passphrase')"
          @update:model-value="patchJumpAuth({ keyPassphrase: String($event) })"
        />
      </template>
    </div>
  </div>
</template>
