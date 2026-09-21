<script setup lang="ts">
import { nextTick, onMounted, onUnmounted, ref } from "vue";
import { t } from "@/i18n";
import { useSessionsStore } from "@/stores/sessions";
import { terminalSelection } from "@/lib/ssh-term";
import { useSshStore } from "@/stores/ssh";

type Action = "cut" | "copy" | "paste" | "selectAll";

const open = ref(false);
const x = ref(0);
const y = ref(0);
const actions = ref<Action[]>([]);
const menu = ref<HTMLElement | null>(null);

let field: HTMLInputElement | HTMLTextAreaElement | null = null;
let inTerm = false;

function actionLabel(action: Action) {
  if (action === "selectAll") return t("common.selectAll");
  return t(`common.${action}`);
}

function fieldOf(target: EventTarget | null) {
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return target;
  if (target instanceof HTMLElement) {
    return target.closest("input, textarea") as HTMLInputElement | HTMLTextAreaElement | null;
  }
  return null;
}

function onContext(e: MouseEvent) {
  if ((e.target as HTMLElement | null)?.closest?.("[data-db-tables]")) return;
  e.preventDefault();
  field = fieldOf(e.target);
  inTerm = Boolean((e.target as HTMLElement | null)?.closest?.(".ssh-term"));
  const selectable = Boolean((e.target as HTMLElement | null)?.closest?.(".selectable"));
  const next: Action[] = [];
  if (field && !field.disabled) {
    if (!field.readOnly) next.push("cut");
    next.push("copy");
    if (!field.readOnly) next.push("paste");
    next.push("selectAll");
  } else if (inTerm) {
    next.push("copy", "paste");
  } else if (selectable || window.getSelection()?.toString()) {
    next.push("copy");
  }
  if (!next.length) {
    open.value = false;
    return;
  }
  actions.value = next;
  open.value = true;
  x.value = e.clientX;
  y.value = e.clientY;
  void nextTick(() => {
    const el = menu.value;
    if (!el) return;
    const pad = 8;
    x.value = Math.min(e.clientX, window.innerWidth - el.offsetWidth - pad);
    y.value = Math.min(e.clientY, window.innerHeight - el.offsetHeight - pad);
  });
}

function close() {
  open.value = false;
}

function onWindowClick(e: MouseEvent) {
  if (menu.value?.contains(e.target as Node)) return;
  close();
}

async function selectedText() {
  if (field) {
    const start = field.selectionStart ?? 0;
    const end = field.selectionEnd ?? 0;
    if (end > start) return field.value.slice(start, end);
    return field.value;
  }
  if (inTerm) {
    const id = useSessionsStore().activeId;
    return id ? terminalSelection(id) : "";
  }
  return window.getSelection()?.toString() ?? "";
}

async function run(action: Action) {
  open.value = false;
  if (action === "copy") {
    const text = await selectedText();
    if (text) await navigator.clipboard.writeText(text);
    return;
  }
  if (action === "cut" && field && !field.readOnly) {
    const text = await selectedText();
    if (text) await navigator.clipboard.writeText(text);
    document.execCommand("cut");
    return;
  }
  if (action === "selectAll") {
    if (field) {
      field.focus();
      field.select();
    } else {
      document.execCommand("selectAll");
    }
    return;
  }
  if (action === "paste") {
    const text = await navigator.clipboard.readText();
    if (!text) return;
    if (field && !field.readOnly) {
      field.focus();
      document.execCommand("insertText", false, text);
      return;
    }
    if (inTerm) {
      const id = useSessionsStore().activeId;
      if (id) useSshStore().requestPaste(id, text);
    }
  }
}

function onKey(e: KeyboardEvent) {
  if (e.key === "Escape") close();
}

onMounted(() => {
  window.addEventListener("contextmenu", onContext, true);
  window.addEventListener("click", onWindowClick);
  window.addEventListener("blur", close);
  window.addEventListener("keydown", onKey);
});

onUnmounted(() => {
  window.removeEventListener("contextmenu", onContext, true);
  window.removeEventListener("click", onWindowClick);
  window.removeEventListener("blur", close);
  window.removeEventListener("keydown", onKey);
});
</script>

<template>
  <div
    v-if="open"
    ref="menu"
    class="fixed z-[200] min-w-28 rounded-lg border border-border bg-popover p-1 shadow-xl"
    :style="{ left: `${x}px`, top: `${y}px` }"
    @click.stop
  >
    <button
      v-for="item in actions"
      :key="item"
      type="button"
      class="flex w-full rounded-md px-2.5 py-1 text-left text-[13px] hover:bg-accent"
      @click="run(item)"
    >
      {{ actionLabel(item) }}
    </button>
  </div>
</template>
