<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { CircleHelp, ExternalLink, Plus } from "@lucide/vue";
import type { Session, SshConfig, SshTunnelKind, SshTunnelRule } from "@/types";
import { toast } from "vue-sonner";
import { t } from "@/i18n";
import { errorMessage, isTauri } from "@/lib/ipc";
import { useSessionsStore } from "@/stores/sessions";
import { useSshStore } from "@/stores/ssh";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import AppSelect from "@/components/common/AppSelect.vue";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

const props = defineProps<{ session: Session }>();
const sessions = useSessionsStore();
const ssh = useSshStore();
const pendingRemote = ref<SshTunnelRule | null>(null);
const helpOpen = ref(false);

const cfg = computed(() => props.session.config as SshConfig);
const connected = computed(() => props.session.status === "connected");

function patchTunnels(next: SshTunnelRule[]) {
  sessions.updateConfig(props.session.id, { tunnels: next });
}

function sshDestHost() {
  return cfg.value.host.trim() || "127.0.0.1";
}

watch(
  () => cfg.value.host.trim(),
  (host) => {
    if (!host) return;
    const next = cfg.value.tunnels.map((r) =>
      r.kind === "local" && r.destHost.trim() === "127.0.0.1"
        ? { ...r, destHost: host }
        : r,
    );
    if (next.some((r, i) => r !== cfg.value.tunnels[i])) patchTunnels(next);
  },
  { immediate: true },
);

function addRule() {
  patchTunnels([
    ...cfg.value.tunnels,
    {
      id: crypto.randomUUID(),
      kind: "local",
      bindHost: "127.0.0.1",
      bindPort: 10201,
      destHost: sshDestHost(),
      destPort: 80,
    },
  ]);
}

function update(id: string, data: Partial<SshTunnelRule>) {
  patchTunnels(
    cfg.value.tunnels.map((r) => {
      if (r.id !== id) return r;
      const next = { ...r, ...data };
      if (data.kind && data.kind !== r.kind) {
        if (data.kind === "local") next.destHost = sshDestHost();
        else if (data.kind === "remote") next.destHost = "127.0.0.1";
      }
      return next;
    }),
  );
}

function remove(id: string) {
  void ssh.stopTunnel(props.session.id, id);
  patchTunnels(cfg.value.tunnels.filter((r) => r.id !== id));
}

async function toggle(rule: SshTunnelRule) {
  const st = ssh.tunnelStatus[props.session.id]?.[rule.id];
  if (st === "open") {
    await ssh.stopTunnel(props.session.id, rule.id);
    return;
  }
  if (rule.kind === "remote") {
    pendingRemote.value = rule;
    return;
  }
  await ssh.startTunnel(props.session.id, rule);
}

async function confirmRemote() {
  const rule = pendingRemote.value;
  pendingRemote.value = null;
  if (rule) await ssh.startTunnel(props.session.id, rule);
}

function listenHost(bind: string) {
  const h = bind.trim();
  if (!h || h === "0.0.0.0" || h === "::" || h === "[::]") return "127.0.0.1";
  if (h.includes(":") && !h.startsWith("[")) return `[${h}]`;
  return h;
}

async function openLocal(rule: SshTunnelRule) {
  const url = `http://${listenHost(rule.bindHost)}:${Number(rule.bindPort) || 0}`;
  try {
    if (isTauri()) {
      const { openUrl } = await import("@tauri-apps/plugin-opener");
      await openUrl(url);
      return;
    }
    window.open(url, "_blank", "noopener");
  } catch (err) {
    toast.error(errorMessage(err));
  }
}

function statusDot(id: string) {
  return ssh.tunnelStatus[props.session.id]?.[id] === "open";
}

function statusClass(id: string) {
  const st = ssh.tunnelStatus[props.session.id]?.[id];
  if (st === "open") return "bg-rx";
  if (st === "error") return "bg-err";
  return "bg-muted-foreground/40";
}

const kindOptions = computed(() => [
  { value: "local", label: t("tunnel.local") },
  { value: "remote", label: t("tunnel.remote") },
  { value: "dynamic", label: "-D SOCKS" },
]);

</script>

<template>
  <div class="border-t border-border bg-bg-1/40 px-3 py-2">
    <div class="mb-2 flex items-center gap-2 text-[11px] text-muted-foreground">
      <span>{{ t("tunnel.title") }}</span>
      <Button size="xs" variant="outline" @click="addRule">
        <Plus class="size-3.5" />
        {{ t("tunnel.rule") }}
      </Button>
      <Button
        size="icon-xs"
        variant="ghost"
        class="ml-auto text-muted-foreground"
        :title="t('common.help')"
        @click="helpOpen = true"
      >
        <CircleHelp class="size-3.5" />
      </Button>
    </div>
    <div class="space-y-1">
      <div v-for="rule in cfg.tunnels" :key="rule.id" class="flex flex-wrap items-center gap-1">
        <span
          class="size-1.5 rounded-full"
          :class="statusClass(rule.id)"
        />
        <AppSelect
          :model-value="rule.kind"
          :options="kindOptions"
          class="w-[9.5rem]"
          @update:model-value="update(rule.id, { kind: $event as SshTunnelKind })"
        />
        <Input
          :model-value="rule.bindHost"
          class="h-7 w-24 font-mono text-[11px]"
          placeholder="bind"
          title="bind"
          @update:model-value="update(rule.id, { bindHost: String($event) })"
        />
        <Input
          :model-value="rule.bindPort"
          class="h-7 w-16 font-mono text-[11px]"
          placeholder="port"
          title="port"
          @update:model-value="update(rule.id, { bindPort: Number($event) || 0 })"
        />
        <template v-if="rule.kind !== 'dynamic'">
          <span class="text-[11px] text-muted-foreground">:</span>
          <Input
            :model-value="rule.destHost"
            class="h-7 w-28 font-mono text-[11px]"
            placeholder="host"
            title="host"
            @update:model-value="update(rule.id, { destHost: String($event) })"
          />
          <Input
            :model-value="rule.destPort"
            class="h-7 w-16 font-mono text-[11px]"
            placeholder="port"
            title="port"
            @update:model-value="update(rule.id, { destPort: Number($event) || 0 })"
          />
        </template>
        <Button size="xs" variant="outline" :disabled="!connected" @click="toggle(rule)">
          {{ statusDot(rule.id) ? t("tunnel.stop") : t("tunnel.start") }}
        </Button>
        <Button
          v-if="rule.kind === 'local' && statusDot(rule.id)"
          size="xs"
          variant="outline"
          @click="openLocal(rule)"
        >
          <ExternalLink class="size-3.5" />
          {{ t("tunnel.open") }}
        </Button>
        <Button size="xs" variant="ghost" class="text-err" @click="remove(rule.id)">{{ t("tunnel.del") }}</Button>
      </div>
      <p v-if="!cfg.tunnels.length" class="text-[11px] text-muted-foreground">{{ t("tunnel.none") }}</p>
    </div>
  </div>

  <Dialog v-model:open="helpOpen">
    <DialogContent class="sm:max-w-[560px]">
      <DialogHeader>
        <DialogTitle>{{ t("tunnel.helpTitle") }}</DialogTitle>
        <DialogDescription class="sr-only">{{ t("tunnel.helpDesc") }}</DialogDescription>
      </DialogHeader>
      <div class="max-h-[min(70vh,520px)] space-y-4 overflow-auto pr-1 text-[13px] leading-relaxed text-muted-foreground">
        <p>{{ t("tunnel.helpLead") }}</p>

        <section>
          <h4 class="mb-1.5 text-[13px] font-semibold text-primary">{{ t("tunnel.helpL") }}</h4>
          <p>{{ t("tunnel.helpL1") }}</p>
          <p class="mt-1.5">{{ t("tunnel.helpL2") }}</p>
          <pre class="mt-1 rounded-md bg-muted px-2.5 py-1.5 font-mono text-[12px] text-foreground">127.0.0.1  89  :  127.0.0.1  1881</pre>
          <p class="mt-1">{{ t("tunnel.helpL3") }}</p>
        </section>

        <section>
          <h4 class="mb-1.5 text-[13px] font-semibold text-primary">{{ t("tunnel.helpR") }}</h4>
          <p>{{ t("tunnel.helpR1") }}</p>
          <p class="mt-1.5">{{ t("tunnel.helpR2") }}</p>
          <pre class="mt-1 rounded-md bg-muted px-2.5 py-1.5 font-mono text-[12px] text-foreground">0.0.0.0  1881  :  127.0.0.1  89</pre>
        </section>

        <section>
          <h4 class="mb-1.5 text-[13px] font-semibold text-primary">-D SOCKS</h4>
          <p>{{ t("tunnel.helpD") }}</p>
        </section>
      </div>
    </DialogContent>
  </Dialog>

  <Dialog :open="Boolean(pendingRemote)" @update:open="(v: boolean) => { if (!v) pendingRemote = null }">
    <DialogContent class="sm:max-w-sm">
      <DialogHeader>
        <DialogTitle>{{ t("tunnel.remoteTitle") }}</DialogTitle>
        <DialogDescription>{{ t("tunnel.remoteDesc") }}</DialogDescription>
      </DialogHeader>
      <DialogFooter>
        <Button variant="outline" @click="pendingRemote = null">{{ t("common.cancel") }}</Button>
        <Button @click="confirmRemote">{{ t("tunnel.cont") }}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
