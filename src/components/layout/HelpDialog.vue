<script setup lang="ts">
import { computed } from "vue";
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
  get: () => ui.helpOpen,
  set: (value) => {
    ui.helpOpen = value;
  },
});

const shortcuts = computed(() => [
  { keys: "Ctrl / ⌘ + K", desc: t("help.kSearch") },
  { keys: "Ctrl / ⌘ + N", desc: t("help.kNew") },
  { keys: "Ctrl / ⌘ + W", desc: t("help.kClose") },
  { keys: "Ctrl / ⌘ + B", desc: t("help.kList") },
  { keys: "Ctrl / ⌘ + Tab", desc: t("help.kSwitch") },
  { keys: "Ctrl + Enter", desc: t("help.kSend") },
  { keys: "Ctrl / ⌘ + V", desc: t("help.kPaste") },
  { keys: "Ctrl / ⌘ + C", desc: t("help.kCopy") },
  { keys: "Ctrl / ⌘ + F", desc: t("help.kTermFind") },
  { keys: "Esc", desc: t("help.kEsc") },
]);

const tips = computed(() => [
  t("help.t1"),
  t("help.t2"),
  t("help.t3"),
  t("help.t4"),
  t("help.t5"),
  t("help.t6"),
]);
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent class="sm:max-w-[640px]">
      <DialogHeader>
        <DialogTitle>{{ t("help.title") }}</DialogTitle>
        <DialogDescription class="sr-only">{{ t("help.desc") }}</DialogDescription>
      </DialogHeader>
      <div class="max-h-[min(70vh,520px)] space-y-5 overflow-auto pr-1">
        <section>
          <h4 class="mb-2.5 text-[13px] font-semibold text-primary">{{ t("help.keys") }}</h4>
          <dl class="grid grid-cols-[minmax(140px,42%)_1fr] gap-x-3 gap-y-2 text-[13px]">
            <template v-for="row in shortcuts" :key="row.keys">
              <dt class="self-start rounded-md bg-muted px-2 py-1 font-mono text-xs font-semibold text-foreground">
                {{ row.keys }}
              </dt>
              <dd class="m-0 pt-1 leading-[1.45] text-muted-foreground">{{ row.desc }}</dd>
            </template>
          </dl>
        </section>
        <section>
          <h4 class="mb-2.5 text-[13px] font-semibold text-primary">{{ t("help.tips") }}</h4>
          <ul class="list-disc space-y-1.5 pl-[1.15em] text-[13px] leading-relaxed text-muted-foreground">
            <li v-for="(tip, i) in tips" :key="i">{{ tip }}</li>
          </ul>
        </section>
      </div>
    </DialogContent>
  </Dialog>
</template>
