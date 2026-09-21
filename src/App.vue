<script setup lang="ts">
import { computed, watch } from "vue";
import AppShell from "@/components/layout/AppShell.vue";
import AppContextMenu from "@/components/layout/AppContextMenu.vue";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { applyTheme, useUiStore } from "@/stores/ui";

const ui = useUiStore();
const toasterTheme = computed(() => (ui.settings.theme === "light" ? "light" : "dark"));

watch(
  () => ui.settings.theme,
  (theme) => applyTheme(theme === "light" ? "light" : "dark"),
  { immediate: true },
);
</script>

<template>
  <TooltipProvider :delay-duration="180">
    <AppShell />
    <AppContextMenu />
    <Toaster position="top-right" :theme="toasterTheme" :duration="2600" rich-colors />
  </TooltipProvider>
</template>
