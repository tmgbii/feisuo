<script setup lang="ts">
import { computed } from "vue";
import AppSelect from "@/components/common/AppSelect.vue";
import PageHelp from "@/components/common/PageHelp.vue";
import { Input } from "@/components/ui/input";
import { t } from "@/i18n";
import { useUiStore } from "@/stores/ui";

const ui = useUiStore();
const themeOptions = computed(() => [
  { value: "dark", label: t("title.dark") },
  { value: "light", label: t("title.light") },
]);
const startupOptions = computed(() => [
  { value: "restore", label: t("settings.restore") },
  { value: "dashboard", label: t("settings.dashboard") },
]);
const reconnectOptions = computed(() => [
  { value: "off", label: t("settings.reconnectOff") },
  { value: "on", label: t("settings.reconnectOn") },
]);
</script>

<template>
  <div class="mx-auto h-full max-w-xl overflow-auto p-8">
    <div class="mb-6 flex items-center gap-1">
      <h1 class="text-xl font-medium tracking-tight">{{ t("settings.title") }}</h1>
      <PageHelp page="settings" />
    </div>
    <section class="space-y-5">
      <label class="block space-y-1.5">
        <span class="text-xs text-muted-foreground">{{ t("settings.theme") }}</span>
        <AppSelect
          :model-value="ui.settings.theme"
          :options="themeOptions"
          size="default"
          class="w-full"
          @update:model-value="ui.setTheme($event as 'dark' | 'light')"
        />
      </label>
      <label class="block space-y-1.5">
        <span class="text-xs text-muted-foreground">{{ t("settings.startup") }}</span>
        <AppSelect
          :model-value="ui.settings.startup"
          :options="startupOptions"
          size="default"
          class="w-full"
          @update:model-value="ui.settings.startup = $event as 'restore' | 'dashboard'"
        />
      </label>
      <label class="block space-y-1.5">
        <span class="text-xs text-muted-foreground">{{ t("settings.logLimit") }}</span>
        <Input
          :model-value="ui.settings.logLimit"
          class="h-8"
          @update:model-value="ui.settings.logLimit = Number($event) || 10000"
        />
      </label>
      <label class="block space-y-1.5">
        <span class="text-xs text-muted-foreground">{{ t("settings.httpTimeout") }}</span>
        <Input
          :model-value="ui.settings.httpTimeoutMs"
          class="h-8"
          @update:model-value="ui.settings.httpTimeoutMs = Number($event) || 30000"
        />
      </label>

      <h2 class="pt-2 text-sm font-medium">{{ t("settings.sshTerm") }}</h2>
      <label class="block space-y-1.5">
        <span class="text-xs text-muted-foreground">{{ t("settings.scrollback") }}</span>
        <Input
          :model-value="ui.settings.sshScrollback"
          class="h-8"
          @update:model-value="ui.settings.sshScrollback = Math.max(200, Number($event) || 5000)"
        />
      </label>
      <label class="block space-y-1.5">
        <span class="text-xs text-muted-foreground">{{ t("settings.reconnect") }}</span>
        <AppSelect
          :model-value="ui.settings.sshAutoReconnect ? 'on' : 'off'"
          :options="reconnectOptions"
          size="default"
          class="w-full"
          @update:model-value="ui.settings.sshAutoReconnect = $event === 'on'"
        />
      </label>
      <label class="block space-y-1.5">
        <span class="text-xs text-muted-foreground">{{ t("settings.reconnectMs") }}</span>
        <Input
          :model-value="ui.settings.sshReconnectMs"
          class="h-8"
          @update:model-value="ui.settings.sshReconnectMs = Math.max(500, Number($event) || 3000)"
        />
      </label>
      <label class="block space-y-1.5">
        <span class="text-xs text-muted-foreground">{{ t("settings.editMax") }}</span>
        <Input
          :model-value="ui.settings.sshEditMaxMb"
          class="h-8"
          @update:model-value="ui.settings.sshEditMaxMb = Math.max(0.5, Number($event) || 2)"
        />
      </label>
      <p class="text-xs text-muted-foreground">{{ t("settings.note") }}</p>
    </section>
  </div>
</template>
