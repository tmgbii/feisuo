import { defineStore } from "pinia";
import { computed, ref } from "vue";
import type { SshConfig, SshHost } from "@/types";
import { emptyAuth, emptyEndpoint, normalizeSshConfig } from "@/lib/protocol";

export const useHostsStore = defineStore("ssh-hosts", () => {
  const hosts = ref<SshHost[]>([]);

  const sorted = computed(() =>
    [...hosts.value].sort((a, b) => Number(b.favorite) - Number(a.favorite) || a.name.localeCompare(b.name)),
  );

  function snapshot(): SshHost[] {
    return hosts.value;
  }

  function hydrate(list: SshHost[]) {
    if (hosts.value.length || !list?.length) return;
    hosts.value = list.map((item) => {
      const cfg = normalizeSshConfig(item);
      return {
        ...blank(),
        ...item,
        id: item.id || crypto.randomUUID(),
        host: cfg.host,
        port: cfg.port,
        user: cfg.user,
        auth: cfg.auth,
        jumpEnabled: cfg.jumpEnabled,
        jump: cfg.jump,
        tunnels: cfg.tunnels,
        tags: Array.isArray(item.tags) ? item.tags : [],
      };
    });
  }

  function upsert(host: SshHost) {
    const i = hosts.value.findIndex((h) => h.id === host.id);
    if (i >= 0) hosts.value[i] = host;
    else hosts.value.push(host);
  }

  function remove(id: string) {
    hosts.value = hosts.value.filter((h) => h.id !== id);
  }

  function blank(): SshHost {
    return {
      id: crypto.randomUUID(),
      name: "",
      host: "",
      port: 22,
      user: "root",
      auth: emptyAuth(),
      jumpEnabled: false,
      jump: emptyEndpoint(),
      tunnels: [],
      tags: [],
      favorite: false,
    };
  }

  function importList(list: SshHost[]) {
    for (const item of list) {
      if (!item?.host) continue;
      const cfg = normalizeSshConfig(item);
      upsert({
        ...blank(),
        ...item,
        id: item.id || crypto.randomUUID(),
        host: cfg.host,
        port: cfg.port,
        user: cfg.user,
        auth: cfg.auth,
        jumpEnabled: cfg.jumpEnabled,
        jump: cfg.jump,
        tunnels: cfg.tunnels,
        tags: Array.isArray(item.tags) ? item.tags : [],
      });
    }
  }

  function fromSession(name: string, cfg: SshConfig): SshHost {
    const next = normalizeSshConfig(cfg);
    const existing = hosts.value.find(
      (h) => h.host === next.host && Number(h.port) === next.port && h.user === next.user,
    );
    const item: SshHost = {
      ...(existing ?? blank()),
      name: existing?.name || name || `${next.user}@${next.host}`,
      host: next.host,
      port: next.port,
      user: next.user,
      auth: next.auth,
      jumpEnabled: next.jumpEnabled,
      jump: next.jump,
      tunnels: next.tunnels.map((t) => ({ ...t })),
    };
    upsert(item);
    return item;
  }

  return { hosts, sorted, snapshot, hydrate, upsert, remove, blank, importList, fromSession };
});
