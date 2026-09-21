<script setup lang="ts">
import { computed } from "vue";
import { t } from "@/i18n";
import { useSessionsStore } from "@/stores/sessions";
import { useUiStore } from "@/stores/ui";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

const ui = useUiStore();
const sessions = useSessionsStore();

const open = computed({
  get: () => Boolean(ui.pendingCloseId),
  set: (value) => {
    if (!value) ui.pendingCloseId = null;
  },
});

const name = computed(() => {
  const id = ui.pendingCloseId;
  return sessions.sessions.find((s) => s.id === id)?.name ?? t("common.session");
});

async function confirm() {
  const id = ui.pendingCloseId;
  ui.pendingCloseId = null;
  if (id) await sessions.closeSession(id);
}
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent class="sm:max-w-md">
      <DialogHeader>
        <DialogTitle>{{ t("closeDlg.title") }}</DialogTitle>
        <DialogDescription>
          {{ t("closeDlg.body", { name }) }}
        </DialogDescription>
      </DialogHeader>
      <DialogFooter>
        <Button variant="outline" @click="open = false">{{ t("common.cancel") }}</Button>
        <Button variant="destructive" @click="confirm">{{ t("closeDlg.action") }}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
