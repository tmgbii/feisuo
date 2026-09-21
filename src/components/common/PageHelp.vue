<script setup lang="ts">
import { computed, ref } from "vue";
import { CircleHelp } from "@lucide/vue";
import { pageHelp, type PageHelpId } from "@/lib/page-help";
import { t } from "@/i18n";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

const props = defineProps<{
  page: PageHelpId;
  class?: string;
}>();

const open = ref(false);
const doc = computed(() => pageHelp(props.page));
</script>

<template>
  <Button
    size="icon-xs"
    variant="ghost"
    :title="t('common.help')"
    :class="cn('text-muted-foreground', props.class)"
    @click="open = true"
  >
    <CircleHelp class="size-3.5" />
  </Button>
  <Dialog v-model:open="open">
    <DialogContent class="sm:max-w-[560px]">
      <DialogHeader>
        <DialogTitle>{{ doc.title }}</DialogTitle>
        <DialogDescription class="sr-only">{{ doc.title }}</DialogDescription>
      </DialogHeader>
      <div class="max-h-[min(70vh,520px)] space-y-4 overflow-auto pr-1 text-[13px] leading-relaxed text-muted-foreground">
        <p v-for="(line, i) in doc.lead" :key="`l${i}`">{{ line }}</p>
        <section v-for="(sec, i) in doc.sections" :key="i">
          <h4 class="mb-1.5 text-[13px] font-semibold text-primary">{{ sec.title }}</h4>
          <p v-for="(line, j) in sec.lines" :key="j" :class="j ? 'mt-1' : ''">{{ line }}</p>
          <div v-for="(ex, k) in sec.examples" :key="k" :class="sec.lines.length || k ? 'mt-1.5' : ''">
            <p v-if="ex.caption">{{ ex.caption }}</p>
            <pre
              class="mt-1 whitespace-pre-wrap rounded-md bg-muted px-2.5 py-1.5 font-mono text-[12px] text-foreground"
            >{{ ex.sample }}</pre>
            <p v-if="ex.after" class="mt-1">{{ ex.after }}</p>
          </div>
        </section>
      </div>
    </DialogContent>
  </Dialog>
</template>
