<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import {
  ChevronRight,
  Copy,
  Download,
  File,
  Folder,
  FolderInput,
  FolderPlus,
  FolderUp,
  FilePen,
  Pencil,
  RefreshCw,
  Shield,
  Terminal,
  Trash2,
  Upload,
} from "@lucide/vue";
import { toast } from "vue-sonner";
import { t } from "@/i18n";
import { errorMessage, invokeSsh, isTauri, pickLocalFiles, pickSavePath } from "@/lib/ipc";
import { formatBytes, formatDateTime } from "@/lib/format";
import type { Session, SshFileEntry } from "@/types";
import { useSshStore } from "@/stores/ssh";
import { useUiStore } from "@/stores/ui";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

const props = defineProps<{ session: Session }>();
const ssh = useSshStore();
const ui = useUiStore();

const selected = ref<SshFileEntry | null>(null);
const renaming = ref<SshFileEntry | null>(null);
const renameTo = ref("");
const deleting = ref<SshFileEntry | null>(null);
const editing = ref<SshFileEntry | null>(null);
const editText = ref("");
const chmodTarget = ref<SshFileEntry | null>(null);
const chmodMode = ref("0755");
const chmodRecurse = ref(false);
const mkdirOpen = ref(false);
const mkdirName = ref("");
const overwrite = ref<string[] | null>(null);
const dragging = ref(false);
const panel = ref<HTMLElement | null>(null);
const pendingDelete = computed(() => deleting.value);
const overwriteNames = computed(() =>
  (overwrite.value ?? [])
    .map(localName)
    .filter((name) => rows.value.some((row) => row.name === name)),
);
let lastIngest = 0;
let stopDrag: (() => void) | null = null;

const rows = computed(() =>
  props.session.status === "connected" ? (ssh.listing[props.session.id] ?? []) : [],
);
const path = computed(() => ssh.cwd[props.session.id] || "/");
const transfers = computed(() => (ssh.xfers[props.session.id] ?? []).filter((x) => !x.done || x.error));
const crumbs = computed(() => {
  const parts = path.value.replace(/\/+$/, "").split("/").filter(Boolean);
  const items = [{ label: "/", path: "/" }];
  let acc = "";
  for (const part of parts) {
    acc += `/${part}`;
    items.push({ label: part, path: acc });
  }
  return items;
});

onMounted(() => {
  if (props.session.status === "connected") void reload();
  if (!isTauri()) return;
  void import("@tauri-apps/api/webview").then(async ({ getCurrentWebview }) => {
    stopDrag = await getCurrentWebview().onDragDropEvent((event) => {
      const kind = event.payload.type;
      if (kind === "leave") {
        dragging.value = false;
        return;
      }
      if (kind === "enter" || kind === "over") {
        if (overPanel(event.payload.position)) dragging.value = true;
        return;
      }
      if (kind !== "drop") return;
      const accept = dragging.value || overPanel(event.payload.position);
      dragging.value = false;
      if (!accept) return;
      void ingest(event.payload.paths);
    });
  });
});

onBeforeUnmount(() => {
  stopDrag?.();
  stopDrag = null;
});

watch(
  () => props.session.id,
  () => {
    selected.value = null;
    if (props.session.status === "connected") void reload();
  },
);

watch(path, () => {
  selected.value = null;
});

watch(
  () => props.session.status,
  (status) => {
    if (status === "connected") void reload();
    else selected.value = null;
  },
);

async function reload() {
  if (!ssh.cwd[props.session.id]) await ssh.home(props.session.id);
  else await ssh.list(props.session.id, ssh.cwd[props.session.id]);
}

async function go(target: string) {
  selected.value = null;
  ssh.cwd[props.session.id] = target;
  await ssh.list(props.session.id, target);
}

function parentOf(p: string) {
  if (p === "/" || !p) return "/";
  const trimmed = p.replace(/\/+$/, "");
  const i = trimmed.lastIndexOf("/");
  return i <= 0 ? "/" : trimmed.slice(0, i);
}

function select(entry: SshFileEntry) {
  selected.value = entry;
}

async function enter(entry: SshFileEntry) {
  selected.value = entry;
  if (entry.isDir) {
    await go(entry.path);
    return;
  }
  await openEdit(entry);
}

async function openEdit(entry: SshFileEntry) {
  if (!isTauri()) {
    toast.error(t("err.needDesktop"));
    return;
  }
  try {
    editText.value = await invokeSsh<string>("ssh_sftp_read", {
      sessionId: props.session.id,
      path: entry.path,
      maxMb: ui.settings.sshEditMaxMb,
    });
    editing.value = entry;
  } catch (err) {
    toast.error(errorMessage(err));
  }
}

async function saveEdit() {
  if (!editing.value) return;
  try {
    await invokeSsh("ssh_sftp_write", {
      sessionId: props.session.id,
      path: editing.value.path,
      content: editText.value,
    });
    editing.value = null;
  } catch (err) {
    toast.error(errorMessage(err));
  }
}

function joinRemote(name: string) {
  const dir = path.value.replace(/\/+$/, "");
  return dir === "" || dir === "/" ? `/${name}` : `${dir}/${name}`;
}

function overPanel(pos: { x: number; y: number }) {
  const el = panel.value;
  if (!el) return false;
  const r = el.getBoundingClientRect();
  const scale = window.devicePixelRatio || 1;
  const points = [
    [pos.x, pos.y],
    [pos.x / scale, pos.y / scale],
    [pos.x * scale, pos.y * scale],
  ];
  return points.some(([x, y]) => x >= r.left && x <= r.right && y >= r.top && y <= r.bottom);
}

function isInside(path: string, dir: string) {
  const p = path.replace(/\\/g, "/").toLowerCase();
  const d = dir.replace(/\\/g, "/").toLowerCase().replace(/\/+$/, "");
  return p === d || p.startsWith(`${d}/`);
}

function dropPaths(e: DragEvent): string[] {
  const files = [...(e.dataTransfer?.files ?? [])] as Array<File & { path?: string; webkitRelativePath?: string }>;
  const items = [...(e.dataTransfer?.items ?? [])];
  const dirs: string[] = [];
  const loose: string[] = [];
  for (let i = 0; i < Math.max(items.length, files.length); i++) {
    const file = files[i];
    const local = file?.path;
    if (!local) continue;
    const entry = (items[i] as DataTransferItem & { webkitGetAsEntry?: () => FileSystemEntry | null } | undefined)
      ?.webkitGetAsEntry?.();
    if (entry?.isDirectory) dirs.push(local);
    else loose.push(local);
  }
  if (dirs.length) {
    return [...dirs, ...loose.filter((p) => !dirs.some((d) => isInside(p, d)))];
  }
  const roots = new Set<string>();
  for (const file of files) {
    const rel = file.webkitRelativePath?.replace(/\\/g, "/");
    const local = file.path?.replace(/\\/g, "/");
    if (!rel || !local || !local.endsWith(rel)) continue;
    const top = rel.split("/")[0];
    if (!top) continue;
    const prefix = local.slice(0, local.length - rel.length).replace(/\/+$/, "");
    const root = `${prefix}/${top}`;
    roots.add(file.path!.startsWith("/") || !file.path!.includes("\\") ? root : root.replace(/\//g, "\\"));
  }
  if (roots.size) return [...roots];
  return loose;
}

function localName(local: string) {
  return local.replace(/\\/g, "/").split("/").filter(Boolean).pop() || "file";
}

function joinLocal(dir: string, name: string) {
  const sep = dir.includes("\\") ? "\\" : "/";
  return `${dir.replace(/[\\/]+$/, "")}${sep}${name}`;
}

async function uploadPath(local: string) {
  await invokeSsh("ssh_sftp_upload", {
    sessionId: props.session.id,
    local,
    remote: joinRemote(localName(local)),
    offset: 0,
  });
}

async function runUpload(paths: string[]) {
  for (const local of paths) {
    try {
      await uploadPath(local);
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }
}

async function ingest(paths: string[]) {
  const uniq = [...new Set(paths.filter(Boolean))];
  if (!uniq.length) return;
  const now = Date.now();
  if (now - lastIngest < 400) return;
  lastIngest = now;
  if (!isTauri()) {
    toast.error(t("err.needDesktop"));
    return;
  }
  const clash = uniq.filter((local) => rows.value.some((row) => row.name === localName(local)));
  if (clash.length) {
    overwrite.value = uniq;
    return;
  }
  await runUpload(uniq);
}

function cancelOverwrite() {
  overwrite.value = null;
  lastIngest = 0;
}

async function confirmOverwrite() {
  const paths = overwrite.value ?? [];
  overwrite.value = null;
  await runUpload(paths);
}

async function pickAndUpload(directory = false) {
  if (!isTauri()) {
    toast.error(t("err.needDesktop"));
    return;
  }
  const files = await pickLocalFiles({
    multiple: !directory,
    directory,
    title: directory ? t("common.uploadDir") : t("common.upload"),
  });
  await ingest(files);
}

function onDragOver(e: DragEvent) {
  e.preventDefault();
  dragging.value = true;
}

function onDragLeave() {
  dragging.value = false;
}

async function onDrop(e: DragEvent) {
  e.preventDefault();
  dragging.value = false;
  const paths = dropPaths(e);
  if (!paths.length) return;
  await ingest(paths);
}

async function applyMkdir() {
  const name = mkdirName.value.trim();
  if (!name) return;
  try {
    await invokeSsh("ssh_sftp_mkdir", {
      sessionId: props.session.id,
      path: joinRemote(name),
    });
    mkdirOpen.value = false;
    mkdirName.value = "";
    await ssh.list(props.session.id, path.value);
  } catch (err) {
    toast.error(errorMessage(err));
  }
}

async function download(entry: SshFileEntry) {
  if (!isTauri()) {
    toast.error(t("err.needDesktop"));
    return;
  }
  let local: string | null = null;
  if (entry.isDir) {
    const dests = await pickLocalFiles({ directory: true, title: t("common.downloadTo") });
    const dest = dests[0];
    if (!dest) return;
    local = joinLocal(dest, entry.name);
  } else {
    local = await pickSavePath(entry.name);
    if (!local) return;
  }
  try {
    let offset = 0;
    if (!entry.isDir) {
      try {
        offset = await invokeSsh<number>("ssh_local_size", { path: local });
      } catch {
        offset = 0;
      }
    }
    await invokeSsh("ssh_sftp_download", {
      sessionId: props.session.id,
      remote: entry.path,
      local,
      offset,
    });
  } catch (err) {
    toast.error(errorMessage(err));
  }
}

async function applyRename() {
  if (!renaming.value || !renameTo.value.trim()) return;
  try {
    await invokeSsh("ssh_sftp_rename", {
      sessionId: props.session.id,
      from: renaming.value.path,
      to: joinRemote(renameTo.value.trim()),
    });
    renaming.value = null;
    selected.value = null;
    await ssh.list(props.session.id, path.value);
  } catch (err) {
    toast.error(errorMessage(err));
  }
}

async function confirmDelete() {
  if (!deleting.value) return;
  try {
    await invokeSsh("ssh_sftp_remove", {
      sessionId: props.session.id,
      path: deleting.value.path,
      isDir: deleting.value.isDir,
    });
    deleting.value = null;
    selected.value = null;
    await ssh.list(props.session.id, path.value);
  } catch (err) {
    toast.error(errorMessage(err));
  }
}

async function applyChmod() {
  if (!chmodTarget.value) return;
  const mode = Number.parseInt(chmodMode.value, 8);
  if (!Number.isFinite(mode)) {
    toast.error(t("common.invalidMode"));
    return;
  }
  try {
    await invokeSsh("ssh_sftp_chmod", {
      sessionId: props.session.id,
      path: chmodTarget.value.path,
      mode,
      recursive: chmodRecurse.value,
    });
    chmodTarget.value = null;
    await ssh.list(props.session.id, path.value);
  } catch (err) {
    toast.error(errorMessage(err));
  }
}

function startRename(entry: SshFileEntry) {
  renaming.value = entry;
  renameTo.value = entry.name;
}

function startChmod(entry: SshFileEntry) {
  chmodTarget.value = entry;
  chmodMode.value = entry.mode || "0755";
  chmodRecurse.value = false;
}

function copyPath(p: string) {
  if (p) void navigator.clipboard.writeText(p);
}

function cdHere(entry?: SshFileEntry | null) {
  if (entry) ssh.cdTerminal(props.session.id, entry.path, entry.isDir);
  else ssh.cdTerminal(props.session.id, path.value, true);
}

function metaTitle(entry: SshFileEntry) {
  const bits = [`${entry.path}`, entry.mode];
  if (!entry.isDir) bits.push(formatBytes(entry.size));
  if (entry.mtime) bits.push(formatDateTime(entry.mtime * 1000));
  return bits.join(" · ");
}

function mtimeText(entry: SshFileEntry) {
  if (!entry.mtime) return "—";
  return formatDateTime(entry.mtime * 1000).slice(5, 16);
}

function pct(item: { transferred: number; total: number }) {
  if (!item.total) return 0;
  return Math.min(100, Math.round((item.transferred / item.total) * 100));
}
</script>

<template>
  <aside
    ref="panel"
    class="relative flex w-80 min-w-0 shrink-0 flex-col overflow-hidden border-r border-border bg-bg-1/50"
    @dragover="onDragOver"
    @dragleave="onDragLeave"
    @drop="onDrop"
  >
    <div class="flex h-9 items-center gap-0.5 border-b border-border px-1.5">
      <Button
        size="icon-xs"
        variant="ghost"
        class="text-muted-foreground"
        :disabled="path === '/'"
        :title="t('common.parent')"
        @click="go(parentOf(path))"
      >
        <FolderUp class="size-3.5" />
      </Button>
      <div class="flex min-w-0 flex-1 items-center overflow-hidden font-mono text-[11px]">
        <button
          v-for="(crumb, i) in crumbs"
          :key="crumb.path"
          type="button"
          class="flex min-w-0 items-center text-muted-foreground hover:text-foreground"
          @click="go(crumb.path)"
        >
          <ChevronRight v-if="i > 0" class="size-3 shrink-0 opacity-50" />
          <span class="truncate" :class="i === crumbs.length - 1 ? 'text-foreground' : ''">{{ crumb.label }}</span>
        </button>
      </div>
      <Button size="icon-xs" variant="ghost" class="text-muted-foreground" :title="t('common.refresh')" @click="reload">
        <RefreshCw class="size-3.5" />
      </Button>
    </div>

    <div class="flex items-center gap-0.5 border-b border-border px-1.5 py-1">
      <Button size="icon-xs" variant="ghost" :title="t('common.upload')" @click="pickAndUpload(false)">
        <Upload class="size-3.5" />
      </Button>
      <Button size="icon-xs" variant="ghost" :title="t('common.uploadDir')" @click="pickAndUpload(true)">
        <FolderInput class="size-3.5" />
      </Button>
      <Button
        size="icon-xs"
        variant="ghost"
        :title="t('common.download')"
        :disabled="!selected"
        @click="selected && download(selected)"
      >
        <Download class="size-3.5" />
      </Button>
      <Button
        size="icon-xs"
        variant="ghost"
        :title="t('ssh.copyPath')"
        @click="copyPath(selected?.path ?? path)"
      >
        <Copy class="size-3.5" />
      </Button>
      <Button
        size="icon-xs"
        variant="ghost"
        :title="t('ssh.cd')"
        @click="cdHere(selected)"
      >
        <Terminal class="size-3.5" />
      </Button>
      <Button size="icon-xs" variant="ghost" :title="t('common.mkdir')" @click="mkdirOpen = true; mkdirName = ''">
        <FolderPlus class="size-3.5" />
      </Button>
      <Button
        size="icon-xs"
        variant="ghost"
        :title="t('common.edit')"
        :disabled="!selected || selected.isDir"
        @click="selected && openEdit(selected)"
      >
        <FilePen class="size-3.5" />
      </Button>
      <Button
        size="icon-xs"
        variant="ghost"
        :title="t('common.rename')"
        :disabled="!selected"
        @click="selected && startRename(selected)"
      >
        <Pencil class="size-3.5" />
      </Button>
      <Button
        size="icon-xs"
        variant="ghost"
        title="chmod"
        :disabled="!selected"
        @click="selected && startChmod(selected)"
      >
        <Shield class="size-3.5" />
      </Button>
      <Button
        size="icon-xs"
        variant="ghost"
        class="text-err hover:text-err"
        :title="t('common.delete')"
        :disabled="!selected"
        @click="selected && (deleting = selected)"
      >
        <Trash2 class="size-3.5" />
      </Button>
    </div>

    <div class="min-h-0 flex-1 overflow-auto text-[12px]">
      <div class="sticky top-0 z-10 grid grid-cols-[minmax(0,1fr)_3.5rem_4.5rem_2.5rem] gap-1 border-b border-border bg-bg-1 px-2 py-1 text-[10px] text-muted-foreground">
        <span>{{ t("common.name") }}</span>
        <span class="text-right">{{ t("common.size") }}</span>
        <span class="text-right">{{ t("common.time") }}</span>
        <span class="text-right">{{ t("common.mode") }}</span>
      </div>
      <button
        v-if="path !== '/'"
        type="button"
        class="grid w-full grid-cols-[minmax(0,1fr)_3.5rem_4.5rem_2.5rem] items-center gap-1 px-2 py-1 text-left text-muted-foreground hover:bg-foreground/5"
        @dblclick="go(parentOf(path))"
      >
        <span class="flex min-w-0 items-center gap-1.5">
          <FolderUp class="size-3.5 shrink-0" />
          <span class="truncate">..</span>
        </span>
        <span />
        <span />
        <span />
      </button>
      <div
        v-for="entry in rows"
        :key="entry.path"
        class="group relative grid grid-cols-[minmax(0,1fr)_3.5rem_4.5rem_2.5rem] items-center gap-1 px-2 py-1 hover:bg-foreground/5"
        :class="selected?.path === entry.path ? 'bg-primary/10' : ''"
        :title="metaTitle(entry)"
        @click="select(entry)"
        @dblclick="enter(entry)"
      >
        <div class="relative flex min-w-0 items-center gap-1.5">
          <Folder v-if="entry.isDir" class="size-3.5 shrink-0 text-primary/80" />
          <File v-else class="size-3.5 shrink-0 text-muted-foreground" />
          <span class="truncate font-mono">{{ entry.name }}</span>
          <span class="absolute inset-y-0 right-0 hidden items-center gap-0.5 bg-bg-1/95 pl-2 group-hover:flex">
            <button
              type="button"
              class="rounded p-0.5 text-muted-foreground hover:bg-foreground/10 hover:text-foreground"
              :title="t('ssh.copyPath')"
              @click.stop="copyPath(entry.path)"
            >
              <Copy class="size-3" />
            </button>
            <button
              type="button"
              class="rounded p-0.5 text-muted-foreground hover:bg-foreground/10 hover:text-foreground"
              :title="t('ssh.cd')"
              @click.stop="cdHere(entry)"
            >
              <Terminal class="size-3" />
            </button>
            <button
              type="button"
              class="rounded p-0.5 text-muted-foreground hover:bg-foreground/10 hover:text-foreground"
              :title="t('common.download')"
              @click.stop="download(entry)"
            >
              <Download class="size-3" />
            </button>
            <button
              v-if="!entry.isDir"
              type="button"
              class="rounded p-0.5 text-muted-foreground hover:bg-foreground/10 hover:text-foreground"
              :title="t('common.edit')"
              @click.stop="openEdit(entry)"
            >
              <FilePen class="size-3" />
            </button>
            <button
              type="button"
              class="rounded p-0.5 text-muted-foreground hover:bg-foreground/10 hover:text-foreground"
              :title="t('common.rename')"
              @click.stop="startRename(entry)"
            >
              <Pencil class="size-3" />
            </button>
            <button
              type="button"
              class="rounded p-0.5 text-muted-foreground hover:bg-foreground/10 hover:text-foreground"
              title="chmod"
              @click.stop="startChmod(entry)"
            >
              <Shield class="size-3" />
            </button>
            <button
              type="button"
              class="rounded p-0.5 text-err hover:bg-err/10"
              :title="t('common.delete')"
              @click.stop="deleting = entry"
            >
              <Trash2 class="size-3" />
            </button>
          </span>
        </div>
        <span class="text-right font-mono text-[11px] text-muted-foreground">
          {{ entry.isDir ? "—" : formatBytes(entry.size) }}
        </span>
        <span class="truncate text-right font-mono text-[11px] text-muted-foreground">{{ mtimeText(entry) }}</span>
        <span class="text-right font-mono text-[11px] text-muted-foreground">{{ entry.mode }}</span>
      </div>
      <p v-if="!rows.length" class="px-2 py-8 text-center text-[11px] text-muted-foreground">{{ t("common.noFiles") }}</p>
    </div>
    <div
      v-if="dragging"
      class="pointer-events-none absolute inset-0 flex items-center justify-center bg-primary/10 text-xs text-primary"
    >
      {{ t("common.dropFiles") }}
    </div>

    <div v-if="transfers.length" class="space-y-1.5 border-t border-border px-2 py-2">
      <div v-for="item in transfers" :key="item.id" class="space-y-0.5">
        <div class="flex items-center gap-2 text-[11px]">
          <span class="min-w-0 flex-1 truncate font-mono">{{ item.name }}</span>
          <span class="shrink-0 text-muted-foreground">{{ pct(item) }}%</span>
          <button
            v-if="!item.done"
            type="button"
            class="text-err"
            @click="invokeSsh('ssh_xfer_cancel', { id: item.id })"
          >
            {{ t("common.cancel") }}
          </button>
        </div>
        <div class="h-1 overflow-hidden rounded-full bg-foreground/10">
          <div
            class="h-full rounded-full"
            :class="item.error ? 'bg-err' : 'bg-primary'"
            :style="{ width: `${pct(item)}%` }"
          />
        </div>
        <p v-if="item.error" class="text-[10px] text-err">{{ item.error }}</p>
      </div>
    </div>
  </aside>

  <Dialog :open="mkdirOpen" @update:open="(v: boolean) => { mkdirOpen = v }">
    <DialogContent class="sm:max-w-sm">
      <DialogHeader>
        <DialogTitle>{{ t("common.mkdir") }}</DialogTitle>
      </DialogHeader>
      <Input v-model="mkdirName" class="h-8 font-mono text-xs" :placeholder="t('common.name')" @keyup.enter="applyMkdir" />
      <DialogFooter>
        <Button variant="outline" @click="mkdirOpen = false">{{ t("common.cancel") }}</Button>
        <Button @click="applyMkdir">{{ t("common.ok") }}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>

  <Dialog :open="Boolean(renaming)" @update:open="(v: boolean) => { if (!v) renaming = null }">
    <DialogContent class="sm:max-w-sm">
      <DialogHeader>
        <DialogTitle>{{ t("common.rename") }}</DialogTitle>
      </DialogHeader>
      <Input v-model="renameTo" class="h-8 font-mono text-xs" />
      <DialogFooter>
        <Button variant="outline" @click="renaming = null">{{ t("common.cancel") }}</Button>
        <Button @click="applyRename">{{ t("common.ok") }}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>

  <Dialog :open="Boolean(pendingDelete)" @update:open="(v: boolean) => { if (!v) deleting = null }">
    <DialogContent class="sm:max-w-md">
      <DialogHeader>
        <DialogTitle>{{ t("common.delete") }}</DialogTitle>
        <DialogDescription class="font-mono break-all">
          {{ deleting?.path }} · {{ t("common.noTrash") }}
        </DialogDescription>
      </DialogHeader>
      <DialogFooter>
        <Button variant="outline" @click="deleting = null">{{ t("common.cancel") }}</Button>
        <Button variant="destructive" @click="confirmDelete">{{ t("common.delete") }}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>

  <Dialog :open="Boolean(overwrite)" @update:open="(v: boolean) => { if (!v) cancelOverwrite() }">
    <DialogContent class="sm:max-w-md">
      <DialogHeader>
        <DialogTitle>{{ t("common.overwrite") }}</DialogTitle>
        <DialogDescription class="font-mono break-all">
          {{ overwriteNames.join(" · ") }} · {{ t("common.noUndo") }}
        </DialogDescription>
      </DialogHeader>
      <DialogFooter>
        <Button variant="outline" @click="cancelOverwrite">{{ t("common.cancel") }}</Button>
        <Button variant="destructive" @click="confirmOverwrite">{{ t("common.overwrite") }}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>

  <Dialog :open="Boolean(editing)" @update:open="(v: boolean) => { if (!v) editing = null }">
    <DialogContent class="flex max-h-[90vh] w-[min(960px,92vw)] flex-col sm:max-w-[min(960px,92vw)]">
      <DialogHeader>
        <DialogTitle class="truncate pr-8 font-mono text-sm">{{ editing?.name }}</DialogTitle>
      </DialogHeader>
      <Textarea v-model="editText" class="min-h-[min(60vh,28rem)] flex-1 font-mono text-[12px]" />
      <DialogFooter>
        <Button variant="outline" @click="editing = null">{{ t("common.cancel") }}</Button>
        <Button @click="saveEdit">{{ t("common.write") }}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>

  <Dialog :open="Boolean(chmodTarget)" @update:open="(v: boolean) => { if (!v) chmodTarget = null }">
    <DialogContent class="sm:max-w-sm">
      <DialogHeader>
        <DialogTitle>chmod</DialogTitle>
        <DialogDescription class="font-mono break-all">
          {{ chmodTarget?.path }}
          <span v-if="chmodRecurse" class="mt-1 block text-err">{{ t("common.recurseWarn") }}</span>
        </DialogDescription>
      </DialogHeader>
      <Input v-model="chmodMode" class="h-8 font-mono" placeholder="0755" />
      <label class="flex items-center gap-2 text-xs text-muted-foreground">
        <input v-model="chmodRecurse" type="checkbox" />
        {{ t("common.recursive") }}
      </label>
      <DialogFooter>
        <Button variant="outline" @click="chmodTarget = null">{{ t("common.cancel") }}</Button>
        <Button @click="applyChmod">{{ t("common.ok") }}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
