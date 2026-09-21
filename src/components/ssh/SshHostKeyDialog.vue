<script setup lang="ts">
import { computed } from "vue";
import { t } from "@/i18n";
import { useSshStore } from "@/stores/ssh";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

const ssh = useSshStore();
const open = computed({
  get: () => Boolean(ssh.hostKey),
  set: (v) => {
    if (!v) void ssh.answerHostKey(false);
  },
});
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent class="sm:max-w-md">
      <DialogHeader>
        <DialogTitle>{{ ssh.hostKey?.previous ? t("ssh.fingerprintChange") : t("ssh.fingerprintNew") }}</DialogTitle>
        <DialogDescription class="space-y-1 font-mono text-[12px] break-all">
          <div>{{ ssh.hostKey?.host }} · {{ ssh.hostKey?.alg }}</div>
          <div v-if="ssh.hostKey?.previous" class="text-err">{{ t("ssh.oldFp", { fp: ssh.hostKey.previous }) }}</div>
          <div>{{ t("ssh.newFp", { fp: ssh.hostKey?.fingerprint ?? "" }) }}</div>
        </DialogDescription>
      </DialogHeader>
      <DialogFooter>
        <Button variant="outline" @click="ssh.answerHostKey(false)">{{ t("ssh.reject") }}</Button>
        <Button :variant="ssh.hostKey?.previous ? 'destructive' : 'default'" @click="ssh.answerHostKey(true)">
          {{ ssh.hostKey?.previous ? t("ssh.cover") : t("ssh.trust") }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
