<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import {
  ChevronRight,
  Download,
  File,
  Folder,
  FolderInput,
  FolderPlus,
  FolderUp,
  FilePen,
  LayoutGrid,
  List,
  Pencil,
  RefreshCw,
  Trash2,
  Upload,
} from "@lucide/vue";
import { toast } from "vue-sonner";
import { t } from "@/i18n";
import { errorMessage, invokeSsh, isTauri, pickLocalFiles, pickSavePath } from "@/lib/ipc";
import { formatBytes, formatDateTime } from "@/lib/format";
import type { Session, SshFileEntry } from "@/types";
import { useFtpStore } from "@/stores/ftp";
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
const ftp = useFtpStore();
const ui = useUiStore();

const selected = ref<SshFileEntry | null>(null);
const renaming = ref<SshFileEntry | null>(null);
const renameTo = ref("");
const deleting = ref<SshFileEntry | null>(null);
const editing = ref<SshFileEntry | null>(null);
const editText = ref("");
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
  props.session.status === "connected" ? (ftp.listing[props.session.id] ?? []) : [],
);
const path = computed(() => ftp.cwd[props.session.id] || "/");
const transfers = computed(() => (ftp.xfers[props.session.id] ?? []).filter((x) => !x.done || x.error));
const live = computed(() => props.session.status === "connected");
const iconView = computed(() => ui.settings.ftpFileView === "icons");
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

function setView(mode: "list" | "icons") {
  ui.settings.ftpFileView = mode;
}

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

watch(
  () => props.session.status,
  (status) => {
    if (status === "connected") void reload();
    else selected.value = null;
  },
);

async function reload() {
  if (!ftp.cwd[props.session.id]) await ftp.home(props.session.id);
  else await ftp.list(props.session.id, ftp.cwd[props.session.id]);
}

async function go(target: string) {
  selected.value = null;
  ftp.cwd[props.session.id] = target;
  await ftp.list(props.session.id, target);
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

function clearSelect() {
  selected.value = null;
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
    editText.value = await invokeSsh<string>("ftp_read", {
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
    await invokeSsh("ftp_write", {
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
  await invokeSsh("ftp_upload", {
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
  if (!live.value) {
    toast.error(t("err.notConnected"));
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
    await invokeSsh("ftp_mkdir", {
      sessionId: props.session.id,
      path: joinRemote(name),
    });
    mkdirOpen.value = false;
    mkdirName.value = "";
    await ftp.list(props.session.id, path.value);
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
    await invokeSsh("ftp_download", {
      sessionId: props.session.id,
      remote: entry.path,
      local,
      offset,
      isDir: entry.isDir,
    });
  } catch (err) {
    toast.error(errorMessage(err));
  }
}

async function applyRename() {
  if (!renaming.value || !renameTo.value.trim()) return;
  try {
    await invokeSsh("ftp_rename", {
      sessionId: props.session.id,
      from: renaming.value.path,
      to: joinRemote(renameTo.value.trim()),
    });
    renaming.value = null;
    selected.value = null;
    await ftp.list(props.session.id, path.value);
  } catch (err) {
    toast.error(errorMessage(err));
  }
}

async function confirmDelete() {
  if (!deleting.value) return;
  try {
    await invokeSsh("ftp_remove", {
      sessionId: props.session.id,
      path: deleting.value.path,
      isDir: deleting.value.isDir,
    });
    deleting.value = null;
    selected.value = null;
    await ftp.list(props.session.id, path.value);
  } catch (err) {
    toast.error(errorMessage(err));
  }
}

function startRename(entry: SshFileEntry) {
  renaming.value = entry;
  renameTo.value = entry.name;
}

function metaTitle(entry: SshFileEntry) {
  const bits = [entry.path];
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

function tileClass(active: boolean) {
  return [
    "flex flex-col items-center gap-1.5 rounded-md px-1.5 py-2 text-center hover:bg-foreground/5",
    active ? "bg-primary/10 ring-1 ring-primary/25" : "",
  ];
}
</script>

<template>
  <aside
    ref="panel"
    class="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-bg-1/50"
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
      <Button size="icon-xs" variant="ghost" :title="t('common.upload')" :disabled="!live" @click="pickAndUpload(false)">
        <Upload class="size-3.5" />
      </Button>
      <Button size="icon-xs" variant="ghost" :title="t('common.uploadDir')" :disabled="!live" @click="pickAndUpload(true)">
        <FolderInput class="size-3.5" />
      </Button>
      <Button
        size="icon-xs"
        variant="ghost"
        :title="t('common.download')"
        :disabled="!live || !selected"
        @click="selected && download(selected)"
      >
        <Download class="size-3.5" />
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
        class="text-err hover:text-err"
        :title="t('common.delete')"
        :disabled="!selected"
        @click="selected && (deleting = selected)"
      >
        <Trash2 class="size-3.5" />
      </Button>
      <div class="ml-auto flex items-center gap-0.5">
        <Button
          size="icon-xs"
          :variant="iconView ? 'ghost' : 'outline'"
          :title="t('common.list')"
          @click="setView('list')"
        >
          <List class="size-3.5" />
        </Button>
        <Button
          size="icon-xs"
          :variant="iconView ? 'outline' : 'ghost'"
          :title="t('common.icons')"
          @click="setView('icons')"
        >
          <LayoutGrid class="size-3.5" />
        </Button>
      </div>
    </div>

    <div v-if="iconView" class="min-h-0 flex-1 overflow-auto p-3" @click="clearSelect">
      <div
        class="grid content-start gap-1"
        style="grid-template-columns: repeat(auto-fill, minmax(5.75rem, 1fr))"
      >
        <button
          v-if="path !== '/'"
          type="button"
          class="flex flex-col items-center gap-1.5 rounded-md px-1.5 py-2 text-muted-foreground hover:bg-foreground/5"
          @click.stop="go(parentOf(path))"
          @dblclick.stop="go(parentOf(path))"
        >
          <FolderUp class="size-9" />
          <span class="w-full truncate text-[11px]">..</span>
        </button>
        <button
          v-for="entry in rows"
          :key="entry.path"
          type="button"
          :class="tileClass(selected?.path === entry.path)"
          :title="metaTitle(entry)"
          @click.stop="select(entry)"
          @dblclick.stop="enter(entry)"
        >
          <Folder v-if="entry.isDir" class="size-9 text-primary/80" />
          <File v-else class="size-9 text-muted-foreground" />
          <span class="line-clamp-2 w-full break-all text-[11px] leading-tight">{{ entry.name }}</span>
        </button>
      </div>
      <p v-if="!rows.length" class="px-2 py-8 text-center text-[11px] text-muted-foreground">{{ t("common.noFiles") }}</p>
    </div>

    <div v-else class="min-h-0 flex-1 overflow-auto text-[12px]" @click="clearSelect">
      <div class="sticky top-0 z-10 grid grid-cols-[minmax(0,1fr)_5rem_6rem] gap-1 border-b border-border bg-bg-1 px-3 py-1 text-[10px] text-muted-foreground">
        <span>{{ t("common.name") }}</span>
        <span class="text-right">{{ t("common.size") }}</span>
        <span class="text-right">{{ t("common.time") }}</span>
      </div>
      <button
        v-if="path !== '/'"
        type="button"
        class="grid w-full grid-cols-[minmax(0,1fr)_5rem_6rem] items-center gap-1 px-3 py-1.5 text-left text-muted-foreground hover:bg-foreground/5"
        @click.stop
        @dblclick="go(parentOf(path))"
      >
        <span class="flex min-w-0 items-center gap-1.5">
          <FolderUp class="size-3.5 shrink-0" />
          <span class="truncate">..</span>
        </span>
        <span />
        <span />
      </button>
      <div
        v-for="entry in rows"
        :key="entry.path"
        class="group relative grid grid-cols-[minmax(0,1fr)_5rem_6rem] items-center gap-1 px-3 py-1.5 hover:bg-foreground/5"
        :class="selected?.path === entry.path ? 'bg-primary/10' : ''"
        :title="metaTitle(entry)"
        @click.stop="select(entry)"
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
            @click="invokeSsh('ftp_xfer_cancel', { id: item.id })"
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
</template>
