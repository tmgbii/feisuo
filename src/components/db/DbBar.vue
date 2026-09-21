<script setup lang="ts">
import { computed } from "vue";
import { t } from "@/i18n";
import { isTauri, pickLocalFiles } from "@/lib/ipc";
import { dbDefaultPort } from "@/lib/protocol";
import type { DbConfig, DbEngine, Session } from "@/types";
import { useSessionsStore } from "@/stores/sessions";
import { useDbStore } from "@/stores/db";
import AppSelect from "@/components/common/AppSelect.vue";
import PageHelp from "@/components/common/PageHelp.vue";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

const props = defineProps<{ session: Session }>();
const sessions = useSessionsStore();
const db = useDbStore();

const cfg = computed(() => props.session.config as DbConfig);
const view = computed(() => db.viewOf(props.session.id));
const locked = computed(
  () => props.session.status === "connected" || props.session.status === "connecting",
);
const sqlite = computed(() => cfg.value.engine === "sqlite");
const catalogOptions = computed(() => {
  const names = [...view.value.catalogs];
  const cur = cfg.value.database.trim();
  if (cur && !names.includes(cur)) names.unshift(cur);
  return names;
});
const catalogBusy = computed(
  () => view.value.switching || view.value.scripting || view.value.running,
);

function patch(data: Partial<DbConfig>) {
  if (locked.value && !("selectOnly" in data) && !("sql" in data)) return;
  sessions.updateConfig(props.session.id, data);
}

function setEngine(value: string) {
  if (locked.value) return;
  const engine = (value === "mysql" || value === "sqlite" ? value : "postgres") as DbEngine;
  const next: Partial<DbConfig> = { engine };
  if (engine !== "sqlite") {
    const prevDefault = dbDefaultPort(cfg.value.engine);
    if (cfg.value.port === prevDefault || !cfg.value.port) {
      next.port = dbDefaultPort(engine);
    }
    if (engine === "postgres" && (cfg.value.user === "root" || !cfg.value.user)) {
      next.user = "postgres";
    }
    if (engine === "mysql" && (cfg.value.user === "postgres" || !cfg.value.user)) {
      next.user = "root";
    }
  }
  patch(next);
}

async function pickFile() {
  if (locked.value) return;
  const [path] = await pickLocalFiles({ title: "SQLite" });
  if (path) patch({ file: path });
}

function onUseDb(value: string) {
  void db.useDatabase(props.session.id, value);
}
</script>

<template>
  <div class="border-b border-border bg-bg-1/40 px-3 py-2">
    <div class="flex flex-wrap items-center gap-2">
      <AppSelect
        :model-value="cfg.engine"
        :disabled="locked"
        class="h-7 w-28"
        :options="[
          { value: 'postgres', label: 'PostgreSQL' },
          { value: 'mysql', label: 'MySQL' },
          { value: 'sqlite', label: 'SQLite' },
        ]"
        @update:model-value="setEngine"
      />
      <template v-if="sqlite">
        <Input
          :model-value="cfg.file"
          :disabled="locked"
          class="h-7 min-w-48 flex-1 font-mono text-xs"
          :placeholder="t('db.filePh')"
          @update:model-value="patch({ file: String($event) })"
        />
        <Button size="sm" variant="outline" :disabled="locked" @click="pickFile">{{ t("db.pickFile") }}</Button>
      </template>
      <template v-else>
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
          @update:model-value="patch({ port: Number($event) || dbDefaultPort(cfg.engine) })"
        />
        <AppSelect
          v-if="session.status === 'connected'"
          :model-value="cfg.database"
          :options="catalogOptions"
          :disabled="catalogBusy"
          class="h-7 w-40 font-mono"
          :placeholder="t('db.dbPh')"
          @update:model-value="onUseDb"
        />
        <Input
          v-else
          :model-value="cfg.database"
          :disabled="locked"
          class="h-7 w-28 font-mono text-xs"
          :placeholder="t('db.dbName')"
          @update:model-value="patch({ database: String($event) })"
        />
        <Input
          :model-value="cfg.user"
          :disabled="locked"
          class="h-7 w-24 font-mono text-xs"
          :placeholder="t('common.user')"
          @update:model-value="patch({ user: String($event) })"
        />
        <Input
          :model-value="cfg.password"
          :disabled="locked"
          class="h-7 w-32 text-xs"
          type="password"
          :placeholder="t('common.password')"
          @update:model-value="patch({ password: String($event) })"
        />
      </template>
      <label class="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <input
          type="checkbox"
          class="accent-primary"
          :checked="cfg.selectOnly"
          @change="patch({ selectOnly: ($event.target as HTMLInputElement).checked })"
        />
        {{ t("db.selectOnly") }}
      </label>
      <PageHelp page="db" />
      <Button
        size="sm"
        :variant="locked && session.status === 'connected' ? 'outline' : 'default'"
        :disabled="session.status === 'connecting' || view.switching"
        @click="sessions.toggleConnect(session.id)"
      >
        {{ session.status === "connecting" ? t("status.connectingEllipsis") : session.status === "connected" ? t("status.disconnect") : t("status.connect") }}
      </Button>
      <span v-if="!isTauri()" class="text-[11px] text-muted-foreground">{{ t("common.needDesktop") }}</span>
    </div>
  </div>
</template>
