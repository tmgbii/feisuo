<script setup lang="ts">
import { computed, ref } from "vue";
import { toast } from "vue-sonner";
import { t } from "@/i18n";
import { errorMessage, invokeSsh, isTauri, pickLocalFiles, pickSavePath } from "@/lib/ipc";
import { emptyAuth, emptyEndpoint } from "@/lib/protocol";
import type { SshHost } from "@/types";
import { useHostsStore } from "@/stores/hosts";
import { useSessionsStore } from "@/stores/sessions";
import { useSshStore } from "@/stores/ssh";
import PageHelp from "@/components/common/PageHelp.vue";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import AppSelect from "@/components/common/AppSelect.vue";
import SshKeyPick from "@/components/ssh/SshKeyPick.vue";

const hosts = useHostsStore();
const sessions = useSessionsStore();
const ssh = useSshStore();
const editing = ref<SshHost | null>(null);
const q = ref("");

const shown = computed(() => {
  const n = q.value.trim().toLowerCase();
  return hosts.sorted.filter(
    (h) =>
      !n ||
      h.name.toLowerCase().includes(n) ||
      h.host.toLowerCase().includes(n) ||
      h.tags.some((tag) => tag.toLowerCase().includes(n)),
  );
});

const authOptions = computed(() => [
  { value: "password", label: t("common.password") },
  { value: "key", label: t("common.key") },
]);

function startNew() {
  editing.value = hosts.blank();
}

function connectHost(host: SshHost) {
  if (!host.host.trim()) {
    toast.error(t("err.missing_host"));
    return;
  }
  if (host.auth.method === "key" && !host.auth.keyPath.trim()) {
    toast.error(t("err.missing_key"));
    return;
  }
  if (host.jumpEnabled) {
    if (!host.jump.host.trim()) {
      toast.error(t("err.missing_jump_host"));
      return;
    }
    if (!host.jump.user.trim()) {
      toast.error(t("err.missing_jump_user"));
      return;
    }
    if (host.jump.auth.method === "key" && !host.jump.auth.keyPath.trim()) {
      toast.error(t("err.missing_jump_key"));
      return;
    }
  }
  const session = sessions.createSession("ssh");
  sessions.updateConfig(session.id, {
    host: host.host,
    port: host.port,
    user: host.user,
    auth: { ...emptyAuth(), ...host.auth },
    jumpEnabled: host.jumpEnabled,
    jump: { ...emptyEndpoint(), ...host.jump, auth: { ...emptyAuth(), ...host.jump?.auth } },
    tunnels: host.tunnels ?? [],
  });
  if (host.name.trim()) sessions.renameSession(session.id, host.name.trim());
  void ssh.connect(session.id);
}

function saveEdit() {
  if (!editing.value) return;
  const item = editing.value;
  if (!item.host.trim()) {
    toast.error(t("err.missing_host"));
    return;
  }
  if (item.auth.method === "key" && !item.auth.keyPath.trim()) {
    toast.error(t("err.missing_key"));
    return;
  }
  if (!item.name.trim()) item.name = `${item.user}@${item.host}`;
  hosts.upsert({ ...item });
  editing.value = null;
}

async function exportHosts() {
  const json = JSON.stringify(hosts.snapshot(), null, 2);
  if (!isTauri()) {
    await navigator.clipboard.writeText(json);
    toast.success(t("common.copied"));
    return;
  }
  const path = await pickSavePath("ssh-hosts.json");
  if (!path) return;
  await invokeSsh("ssh_write_local", { path, content: json });
}

async function importHosts() {
  try {
    let text = "";
    if (isTauri()) {
      const files = await pickLocalFiles({ title: t("common.importHosts") });
      if (!files[0]) return;
      text = await invokeSsh<string>("ssh_read_local", { path: files[0] });
    } else {
      text = await navigator.clipboard.readText();
    }
    const data = JSON.parse(text) as SshHost[];
    hosts.importList(Array.isArray(data) ? data : []);
  } catch (err) {
    toast.error(errorMessage(err));
  }
}
</script>

<template>
  <div class="flex h-full min-h-0">
    <div class="flex w-72 shrink-0 flex-col border-r border-border">
      <div class="flex items-center gap-2 border-b border-border px-3 py-2">
        <span class="text-xs text-muted-foreground">{{ t("common.hostBook") }}</span>
        <PageHelp page="ssh-hosts" />
        <Button size="xs" class="ml-auto" @click="startNew">{{ t("common.new") }}</Button>
      </div>
      <Input v-model="q" class="m-2 h-7" :placeholder="t('common.searchHosts')" />
      <div class="min-h-0 flex-1 overflow-auto px-2 pb-2">
        <button
          v-for="item in shown"
          :key="item.id"
          type="button"
          class="mb-1 w-full rounded-md px-2 py-2 text-left hover:bg-foreground/5"
          :class="editing?.id === item.id ? 'bg-primary/10' : ''"
          @click="editing = { ...item, auth: { ...emptyAuth(), ...item.auth }, jump: { ...emptyEndpoint(), ...item.jump, auth: { ...emptyAuth(), ...item.jump?.auth } } }"
          @dblclick="connectHost(item)"
        >
          <div class="truncate text-[13px]">{{ item.favorite ? "★ " : "" }}{{ item.name || item.host }}</div>
          <div class="truncate font-mono text-[11px] text-muted-foreground">{{ item.user }}@{{ item.host }}:{{ item.port }}</div>
        </button>
        <p v-if="!shown.length" class="px-2 py-8 text-center text-xs text-muted-foreground">{{ t("common.noHosts") }}</p>
      </div>
      <div class="flex gap-1 border-t border-border p-2">
        <Button size="xs" variant="outline" @click="importHosts">{{ t("common.import") }}</Button>
        <Button size="xs" variant="outline" @click="exportHosts">{{ t("common.export") }}</Button>
      </div>
    </div>
    <div v-if="editing" class="min-w-0 flex-1 overflow-auto p-5">
      <div class="mx-auto max-w-md space-y-3">
        <Input v-model="editing.name" class="h-8" :placeholder="t('common.name')" />
        <div class="flex gap-2">
          <Input v-model="editing.host" class="h-8 flex-1 font-mono" placeholder="host" />
          <Input :model-value="editing.port" class="h-8 w-20 font-mono" @update:model-value="editing.port = Number($event) || 22" />
        </div>
        <Input v-model="editing.user" class="h-8 font-mono" placeholder="user" />
        <AppSelect
          :model-value="editing.auth.method"
          :options="authOptions"
          class="w-full"
          @update:model-value="editing.auth.method = $event as 'password' | 'key'"
        />
        <Input
          v-if="editing.auth.method === 'password'"
          v-model="editing.auth.password"
          class="h-8"
          type="password"
          :placeholder="t('common.password')"
        />
        <template v-else>
          <SshKeyPick :path="editing.auth.keyPath" @update:path="editing.auth.keyPath = $event" />
          <Input v-model="editing.auth.keyPassphrase" class="h-8" type="password" :placeholder="t('common.passphrase')" />
        </template>
        <Input
          :model-value="editing.tags.join(', ')"
          class="h-8"
          :placeholder="t('common.tags')"
          @update:model-value="editing.tags = String($event).split(/[,，]/).map((s) => s.trim()).filter(Boolean)"
        />
        <label class="flex items-center gap-2 text-xs text-muted-foreground">
          <input v-model="editing.favorite" type="checkbox" />
          {{ t("common.favorite") }}
        </label>
        <label class="flex items-center gap-2 text-xs text-muted-foreground">
          <input v-model="editing.jumpEnabled" type="checkbox" />
          {{ t("common.jump") }}
        </label>
        <template v-if="editing.jumpEnabled">
          <div class="flex gap-2">
            <Input v-model="editing.jump.host" class="h-8 flex-1 font-mono" :placeholder="t('common.jumpHost')" />
            <Input :model-value="editing.jump.port" class="h-8 w-20 font-mono" @update:model-value="editing.jump.port = Number($event) || 22" />
          </div>
          <Input v-model="editing.jump.user" class="h-8 font-mono" placeholder="user" />
          <AppSelect
            :model-value="editing.jump.auth.method"
            :options="authOptions"
            class="w-full"
            @update:model-value="editing.jump.auth.method = $event as 'password' | 'key'"
          />
          <Input
            v-if="editing.jump.auth.method === 'password'"
            v-model="editing.jump.auth.password"
            class="h-8"
            type="password"
            :placeholder="t('common.password')"
          />
          <template v-else>
            <SshKeyPick :path="editing.jump.auth.keyPath" @update:path="editing.jump.auth.keyPath = $event" />
            <Input v-model="editing.jump.auth.keyPassphrase" class="h-8" type="password" :placeholder="t('common.passphrase')" />
          </template>
        </template>
        <div class="flex gap-2 pt-2">
          <Button @click="saveEdit">{{ t("common.save") }}</Button>
          <Button variant="outline" @click="connectHost(editing)">{{ t("status.connect") }}</Button>
          <Button variant="ghost" class="text-err" @click="hosts.remove(editing.id); editing = null">{{ t("common.delete") }}</Button>
        </div>
      </div>
    </div>
    <div v-else class="flex flex-1 items-center justify-center text-sm text-muted-foreground">—</div>
  </div>
</template>
