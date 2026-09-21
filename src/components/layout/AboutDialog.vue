<script setup lang="ts">
import { computed } from "vue";
import { APP_NAME, APP_NAME_EN, APP_VERSION, FAMILY_NAME, FAMILY_NAME_EN, appFamilyRole, appTagline } from "@/lib/brand";
import { t } from "@/i18n";
import { useUiStore } from "@/stores/ui";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

const ui = useUiStore();

const open = computed({
  get: () => ui.aboutOpen,
  set: (value) => {
    ui.aboutOpen = value;
  },
});
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent class="sm:max-w-[360px]">
      <DialogHeader>
        <DialogTitle>{{ t("brand.about") }}</DialogTitle>
        <DialogDescription class="sr-only">{{ t("brand.version") }}</DialogDescription>
      </DialogHeader>
      <div class="flex flex-col gap-4">
        <header class="flex items-center justify-between gap-3">
          <div class="flex min-w-0 items-center gap-2.5">
            <img src="/icon.png" alt="" class="size-8 shrink-0 rounded-md" />
            <div class="min-w-0 leading-tight">
              <div class="text-sm font-semibold">{{ APP_NAME }}<span class="font-normal text-muted-foreground"> · {{ appTagline() }}</span></div>
              <div class="text-[12px] text-muted-foreground">{{ APP_NAME_EN }}</div>
            </div>
          </div>
          <span class="shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground">v{{ APP_VERSION }}</span>
        </header>
        <p class="m-0 text-xs text-muted-foreground">
          {{ FAMILY_NAME }} / {{ FAMILY_NAME_EN }} · {{ appFamilyRole() }}
        </p>
        <dl class="grid grid-cols-[2.5rem_1fr] gap-x-3 gap-y-1.5 text-xs text-muted-foreground">
          <dt class="text-foreground">{{ t("brand.comms") }}</dt>
          <dd class="m-0">{{ t("brand.commsList") }}</dd>
          <dt class="text-foreground">SSH</dt>
          <dd class="m-0">{{ t("brand.sshBits") }}</dd>
          <dt class="text-foreground">FTP</dt>
          <dd class="m-0">{{ t("brand.ftpBits") }}</dd>
          <dt class="text-foreground">DB</dt>
          <dd class="m-0">{{ t("brand.dbBits") }}</dd>
          <dt class="text-foreground">{{ t("rail.tools") }}</dt>
          <dd class="m-0">{{ t("brand.toolBits") }}</dd>
        </dl>
        <footer class="border-t border-border pt-3 text-xs text-muted-foreground">
          <a class="font-medium text-foreground no-underline hover:text-primary" href="mailto:99317415@qq.com">guanbo</a>
        </footer>
      </div>
    </DialogContent>
  </Dialog>
</template>
