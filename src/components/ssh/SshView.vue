<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { t } from "@/i18n";
import { isTauri } from "@/lib/ipc";
import { osBrand } from "@/lib/ssh-os";
import type { Session } from "@/types";
import { useSessionsStore } from "@/stores/sessions";
import { useSshStore } from "@/stores/ssh";
import { useUiStore } from "@/stores/ui";
import {
  blurTerminalsExcept,
  clearTerminalSearch,
  focusTerminal,
  isImeKey,
  keyToSeq,
  onSearchResults,
  paintTerminal,
  resetTerminalInput,
  searchTerminal,
  terminalOf,
} from "@/lib/ssh-term";
import { resolveSshTheme } from "@/lib/ssh-theme";
import SshBar from "@/components/ssh/SshBar.vue";
import SshFiles from "@/components/ssh/SshFiles.vue";
import SshJump from "@/components/ssh/SshJump.vue";
import SshTunnels from "@/components/ssh/SshTunnels.vue";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ChevronDown, ChevronUp, X } from "@lucide/vue";

const props = defineProps<{ session: Session }>();
const sessions = useSessionsStore();
const ssh = useSshStore();
const ui = useUiStore();
const stage = ref<HTMLElement | null>(null);
const extraIds = ref<string[]>([props.session.id]);
const findOpen = ref(false);
const findQuery = ref("");
const findHit = ref("");
const findBox = ref<HTMLElement | null>(null);
const hosts = new Map<string, HTMLElement>();
let ro: ResizeObserver | null = null;
let stopSearch: (() => void) | null = null;

function termOpts() {
  return {
    theme: ui.settings.sshAnsiTheme,
    scrollback: ui.settings.sshScrollback,
  };
}

function heldOf(id = props.session.id) {
  return terminalOf(id, termOpts());
}

const termIds = computed(() => {
  const live = new Set(
    sessions.sessions.filter((s) => s.protocol === "ssh").map((s) => s.id),
  );
  return [...new Set([props.session.id, ...extraIds.value])].filter((id) => live.has(id));
});

const termBg = computed(() => resolveSshTheme(ui.settings.sshAnsiTheme).background);
const termFg = computed(() => resolveSshTheme(ui.settings.sshAnsiTheme).foreground);
const termScheme = computed(() => (ui.settings.sshAnsiTheme === "light" ? "light" : "dark"));
const probe = computed(() =>
  props.session.status === "connected" ? ssh.probe[props.session.id] : undefined,
);
const brand = computed(() => osBrand(probe.value?.osId, probe.value?.distro, probe.value?.os));

type ProbeBit =
  | { kind: "text"; text: string; mono?: boolean }
  | { kind: "ip"; ip: string }
  | { kind: "os"; label: string; color: string; pretty: string };

const probeSegs = computed(() => {
  const p = probe.value;
  if (!p) return [] as ProbeBit[][];
  const segs: ProbeBit[][] = [];
  if (p.rttMs != null) segs.push([{ kind: "text", text: `${p.rttMs} ms`, mono: true }]);
  const host: ProbeBit[] = [];
  if (p.hostname?.trim()) host.push({ kind: "text", text: p.hostname.trim() });
  if (p.ip?.trim()) host.push({ kind: "ip", ip: p.ip.trim() });
  if (host.length) segs.push(host);
  const machine: ProbeBit[] = [];
  if (brand.value) {
    machine.push({ kind: "os", label: brand.value.label, color: brand.value.color, pretty: brand.value.pretty });
  }
  if (p.cores?.trim()) machine.push({ kind: "text", text: coreLabel(p.cores) });
  if (p.mem?.trim()) machine.push({ kind: "text", text: p.mem.trim() });
  if (machine.length) segs.push(machine);
  const disk: ProbeBit[] = [];
  if (p.diskTotal?.trim()) disk.push({ kind: "text", text: t("common.disk", { n: p.diskTotal.trim() }) });
  if (p.disk?.trim()) disk.push({ kind: "text", text: t("common.diskFree", { n: p.disk.trim() }) });
  if (disk.length) segs.push(disk);
  if (p.os?.trim()) segs.push([{ kind: "text", text: p.os.trim(), mono: true }]);
  if (p.load?.trim()) segs.push([{ kind: "text", text: `load ${p.load.trim()}`, mono: true }]);
  return segs;
});

function coreLabel(raw: string) {
  const s = raw.trim();
  if (!s) return "";
  return /核/.test(s) || /cores?/i.test(s) ? s : t("common.cores", { n: s });
}

function copyIp(ip: string) {
  if (ip) void navigator.clipboard.writeText(ip);
}

function remember(id: string) {
  if (!extraIds.value.includes(id)) extraIds.value = [...extraIds.value, id];
}

function setHost(id: string, el: unknown) {
  if (el instanceof HTMLElement) hosts.set(id, el);
  else hosts.delete(id);
}

function applyPaste(id: string, text: string) {
  if (!text) return;
  const now = Date.now();
  if (now - lastPasteAt < 200) return;
  lastPasteAt = now;
  ssh.requestPaste(id, text);
}

let lastPasteAt = 0;

function pasteFromEvent(e: ClipboardEvent) {
  if ((e.target as HTMLElement | null)?.closest?.("input, textarea")) return;
  const text = e.clipboardData?.getData("text");
  e.preventDefault();
  e.stopImmediatePropagation();
  applyPaste(props.session.id, text ?? "");
}

const composeAt = new Map<string, number>();

function markCompose(id: string, on: boolean) {
  if (on) composeAt.set(id, Date.now());
  else composeAt.delete(id);
}

function imeStuck(id: string, ev: KeyboardEvent) {
  const started = composeAt.get(id);
  if (started == null) return false;
  if (!ev.isComposing && ev.keyCode !== 229 && ev.key !== "Process") return true;
  const nav = ev.key.startsWith("Arrow") || ev.key === "Escape";
  return nav && Date.now() - started > 800;
}

function wire(id: string) {
  const held = heldOf(id);
  if (held.wired) return;
  held.wired = true;
  const { term } = held;
  const ta = term.textarea;
  if (ta) {
    ta.addEventListener("compositionstart", () => markCompose(id, true));
    ta.addEventListener("compositionupdate", () => markCompose(id, true));
    ta.addEventListener("compositionend", () => markCompose(id, false));
  }
  term.attachCustomKeyEventHandler((ev) => {
    if (isImeKey(ev)) return true;
    if (ev.key === "Tab" && !ev.ctrlKey && !ev.metaKey && !ev.altKey) return false;
    if (ev.key === "Escape" && findOpen.value) return false;
    if (ev.key === "Insert" && ev.shiftKey && !ev.ctrlKey && !ev.metaKey) return false;
    if (!(ev.ctrlKey || ev.metaKey)) return true;
    const k = ev.key.toLowerCase();
    if (k === "k" || k === "w" || k === "n" || k === "b" || k === "f" || ev.key === "Tab") return false;
    if (k === "v") return false;
    if (k === "c" || ev.key === "Insert") {
      if (ev.type === "keydown" && (ev.shiftKey || term.hasSelection())) {
        const sel = term.getSelection();
        if (sel) void navigator.clipboard.writeText(sel);
        return false;
      }
      if (ev.shiftKey) return false;
    }
    return true;
  });
  term.onData((data) => {
    void ssh.write(id, data);
  });
}

function attachTo(id: string, focus = true) {
  const wrap = hosts.get(id);
  if (!wrap) return;
  const held = heldOf(id);
  const { term, fit } = held;
  if (!term.element) term.open(wrap);
  else if (term.element.parentElement !== wrap) wrap.appendChild(term.element);
  paintTerminal(term, resolveSshTheme(ui.settings.sshAnsiTheme));
  wire(id);
  if (id !== props.session.id) {
    term.blur();
    return;
  }
  fit.fit();
  void ssh.resize(id, term.cols, term.rows);
  if (focus) {
    blurTerminalsExcept(id);
    queueMicrotask(() => term.focus());
  }
}

function onTermKey(ev: KeyboardEvent) {
  const id = props.session.id;
  const { term } = heldOf(id);
  const meta = ev.ctrlKey || ev.metaKey;
  if (meta && ev.key.toLowerCase() === "f") {
    ev.preventDefault();
    ev.stopPropagation();
    if (ev.type === "keydown") openFind();
    return;
  }
  if (findOpen.value && ev.key === "Escape") {
    ev.preventDefault();
    ev.stopPropagation();
    if (ev.type === "keydown") closeFind();
    return;
  }
  if (findOpen.value && ev.key === "F3") {
    ev.preventDefault();
    ev.stopPropagation();
    if (ev.type === "keydown") runFind(!ev.shiftKey);
    return;
  }
  if (imeStuck(id, ev)) {
    resetTerminalInput(id);
    markCompose(id, false);
    if (ev.type === "keydown") {
      const seq = keyToSeq(ev);
      if (seq) {
        ev.preventDefault();
        ev.stopPropagation();
        void ssh.write(id, seq);
        return;
      }
    }
  }
  if (ev.key === "Tab" && !ev.ctrlKey && !ev.metaKey && !ev.altKey) {
    ev.preventDefault();
    ev.stopPropagation();
    if (ev.type === "keydown") void ssh.write(id, ev.shiftKey ? "\x1b[Z" : "\t");
    return;
  }
  if (ev.type !== "keydown") return;
  if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "v") return;
  if (ev.key === "Insert" && ev.shiftKey && !ev.ctrlKey && !ev.metaKey) return;
  const ta = term.textarea;
  if (ta && ev.target !== ta && !isImeKey(ev)) {
    term.focus();
    const seq = keyToSeq(ev);
    if (!seq) return;
    ev.preventDefault();
    ev.stopPropagation();
    void ssh.write(id, seq);
  }
}

function openFind() {
  findOpen.value = true;
  bindSearch(props.session.id);
  void nextTick(() => {
    const el = findBox.value?.querySelector("input");
    el?.focus();
    el?.select();
  });
}

function closeFind() {
  findOpen.value = false;
  findQuery.value = "";
  findHit.value = "";
  stopSearch?.();
  stopSearch = null;
  clearTerminalSearch(props.session.id);
  focusTerminal(props.session.id);
}

function bindSearch(id: string) {
  stopSearch?.();
  stopSearch = onSearchResults(id, (index, count) => {
    if (!count) findHit.value = "";
    else if (index < 0) findHit.value = String(count);
    else findHit.value = `${index + 1}/${count}`;
  });
}

function runFind(next: boolean, incremental = false) {
  const q = findQuery.value;
  if (!q) {
    clearTerminalSearch(props.session.id);
    findHit.value = "";
    return;
  }
  if (!searchTerminal(props.session.id, q, next, incremental)) findHit.value = t("ssh.noMatch");
}

function onFindKey(ev: KeyboardEvent) {
  if (ev.key === "Escape") {
    ev.preventDefault();
    closeFind();
    return;
  }
  if (ev.key === "Enter" || ev.key === "F3") {
    ev.preventDefault();
    runFind(!ev.shiftKey);
  }
}

function sendByte(code: number) {
  resetTerminalInput(props.session.id);
  markCompose(props.session.id, false);
  void ssh.write(props.session.id, new Uint8Array([code]));
  focusTerminal(props.session.id);
}

function onStagePointerDown() {
  const id = props.session.id;
  if (composeAt.has(id) && Date.now() - (composeAt.get(id) ?? 0) > 800) {
    resetTerminalInput(id);
    markCompose(id, false);
  }
  focusTerminal(id);
}

onMounted(() => {
  remember(props.session.id);
  stage.value?.addEventListener("keydown", onTermKey, true);
  stage.value?.addEventListener("pointerdown", onStagePointerDown, true);
  stage.value?.addEventListener("paste", pasteFromEvent, true);
  ro = new ResizeObserver(() => {
    const id = props.session.id;
    const held = heldOf(id);
    if (!held.term.element) return;
    held.fit.fit();
    void ssh.resize(id, held.term.cols, held.term.rows);
  });
  if (stage.value) ro.observe(stage.value);
  void nextTick(() => attachTo(props.session.id));
});

onBeforeUnmount(() => {
  stage.value?.removeEventListener("keydown", onTermKey, true);
  stage.value?.removeEventListener("pointerdown", onStagePointerDown, true);
  stage.value?.removeEventListener("paste", pasteFromEvent, true);
  ro?.disconnect();
  stopSearch?.();
  stopSearch = null;
  clearTerminalSearch(props.session.id);
  blurTerminalsExcept("");
});

watch(
  () => [ui.settings.sshAnsiTheme, ui.settings.sshScrollback],
  () => {
    for (const id of termIds.value) heldOf(id);
  },
);

watch(
  () => props.session.id,
  (id) => {
    if (findOpen.value) closeFind();
    remember(id);
    void nextTick(() => attachTo(id));
  },
);

watch(
  () => props.session.status,
  (status) => {
    if (status === "connected") queueMicrotask(() => focusTerminal(props.session.id));
  },
);
</script>

<template>
  <div class="flex h-full min-h-0 flex-col">
    <SshBar :session="session" />
    <SshJump v-if="ssh.jumpOpen[session.id]" :session="session" />
    <div class="flex min-h-0 min-w-0 flex-1 overflow-hidden">
      <SshFiles v-if="ssh.filesOpen[session.id]" :session="session" />
      <div class="flex min-h-0 min-w-0 flex-1 flex-col">
        <div
          v-if="!isTauri()"
          class="flex min-h-0 flex-1 items-center justify-center text-sm text-muted-foreground"
        >
          {{ t("common.needDesktop") }}
        </div>
        <div
          v-else
          ref="stage"
          class="relative min-h-0 flex-1 overflow-hidden"
          :style="{ background: termBg, color: termFg, colorScheme: termScheme }"
        >
          <div
            v-for="id in termIds"
            :key="id"
            v-show="id === session.id"
            class="ssh-term absolute inset-0 overflow-hidden p-1"
            :class="{ 'is-light': ui.settings.sshAnsiTheme === 'light' }"
            :ref="(el) => setHost(id, el)"
            @mousedown="focusTerminal(id)"
          />
          <div
            v-if="findOpen"
            ref="findBox"
            class="absolute right-2 top-2 z-10 flex items-center gap-1 rounded-md border border-border bg-bg-1/95 px-1.5 py-1 shadow-sm"
            @mousedown.stop
            @keydown.stop="onFindKey"
            @paste.stop
          >
            <Input
              v-model="findQuery"
              class="h-7 w-40 font-mono text-[12px]"
              @input="runFind(true, true)"
            />
            <span class="min-w-10 px-1 font-mono text-[11px] text-muted-foreground">{{ findHit }}</span>
            <Button size="icon-xs" variant="ghost" tabindex="-1" @click="runFind(false)">
              <ChevronUp class="size-3.5" />
            </Button>
            <Button size="icon-xs" variant="ghost" tabindex="-1" @click="runFind(true)">
              <ChevronDown class="size-3.5" />
            </Button>
            <Button size="icon-xs" variant="ghost" tabindex="-1" @click="closeFind">
              <X class="size-3.5" />
            </Button>
          </div>
        </div>
        <div v-if="isTauri()" class="flex min-h-7 flex-wrap items-center gap-x-2 gap-y-1 border-t border-border px-2 py-1">
          <Button size="xs" variant="outline" tabindex="-1" @mousedown.prevent @click="sendByte(3)">Ctrl+C</Button>
          <Button size="xs" variant="outline" tabindex="-1" @mousedown.prevent @click="sendByte(4)">Ctrl+D</Button>
          <Button size="xs" variant="outline" tabindex="-1" @mousedown.prevent @click="sendByte(27)">Esc</Button>
          <template v-if="probeSegs.length">
            <span class="px-1 text-foreground/20">|</span>
            <span class="flex min-w-0 flex-wrap items-center text-xs text-muted-foreground">
              <template v-for="(seg, i) in probeSegs" :key="i">
                <span v-if="i > 0" class="px-1.5 text-foreground/25">|</span>
                <span class="inline-flex items-center gap-1">
                  <template v-for="(bit, j) in seg" :key="j">
                    <span v-if="j > 0" class="text-foreground/30">·</span>
                    <span v-if="bit.kind === 'os'" class="inline-flex items-center gap-1" :title="bit.pretty">
                      <span class="size-1.5 rounded-full" :style="{ background: bit.color }" />
                      {{ bit.label }}
                    </span>
                    <button
                      v-else-if="bit.kind === 'ip'"
                      type="button"
                      class="font-mono hover:text-foreground"
                      :title="t('common.copy')"
                      @click="copyIp(bit.ip)"
                    >
                      {{ bit.ip }}
                    </button>
                    <span v-else :class="bit.mono ? 'font-mono' : ''">{{ bit.text }}</span>
                  </template>
                </span>
              </template>
            </span>
          </template>
        </div>
        <SshTunnels v-if="ssh.tunnelsOpen[session.id]" :session="session" />
      </div>
    </div>

    <Dialog :open="Boolean(ssh.pastePrompt)" @update:open="(v: boolean) => { if (!v) ssh.cancelPaste() }">
      <DialogContent class="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{{ t("common.paste") }}</DialogTitle>
          <DialogDescription>{{ t("ssh.pasteLines", { n: ssh.pastePrompt?.lines ?? 0 }) }}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" @click="ssh.cancelPaste()">{{ t("common.cancel") }}</Button>
          <Button @click="ssh.acceptPaste()">{{ t("common.paste") }}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
</template>

<style scoped>
.ssh-term {
  color-scheme: dark;
  forced-color-adjust: none;
}
.ssh-term.is-light {
  color-scheme: light;
}
.ssh-term :deep(.xterm) {
  height: 100%;
  background: transparent;
}
.ssh-term :deep(.xterm-viewport),
.ssh-term :deep(.xterm-screen) {
  background: transparent !important;
}
.ssh-term :deep(.xterm-viewport) {
  overflow-y: auto;
}
.ssh-term :deep(textarea) {
  caret-color: transparent;
  min-width: 1px;
  min-height: 1px;
}
</style>
