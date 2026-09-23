<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { toast } from "vue-sonner";
import { Copy, Plus, X } from "@lucide/vue";
import type { HttpConfig, HttpPair, Session } from "@/types";
import type { HttpResponsePayload } from "@/lib/ipc";
import type { CmLang } from "@/lib/codemirror";
import { t } from "@/i18n";
import { errorMessage, invokeHttp } from "@/lib/ipc";
import { formatBytes } from "@/lib/format";
import { useSessionsStore } from "@/stores/sessions";
import { useUiStore } from "@/stores/ui";
import AppSelect from "@/components/common/AppSelect.vue";
import SuggestInput from "@/components/common/SuggestInput.vue";
import PageHelp from "@/components/common/PageHelp.vue";
import CodeEditor from "@/components/common/CodeEditor.vue";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { HTTP_HEADER_NAMES, headerValueOptions } from "@/lib/http-suggest";

const props = defineProps<{ session: Session }>();
const sessions = useSessionsStore();
const ui = useUiStore();

const methods: HttpConfig["method"][] = [
  "GET",
  "POST",
  "PUT",
  "DELETE",
  "PATCH",
  "HEAD",
  "OPTIONS",
];

const methodTone: Record<HttpConfig["method"], string> = {
  GET: "font-mono font-medium text-rx",
  POST: "font-mono font-medium text-warn",
  PUT: "font-mono font-medium text-sky-400",
  PATCH: "font-mono font-medium text-violet-400",
  DELETE: "font-mono font-medium text-err",
  HEAD: "font-mono font-medium text-muted-foreground",
  OPTIONS: "font-mono font-medium text-muted-foreground",
};

const sending = ref(false);
const response = ref<HttpResponsePayload | null>(null);
const responseSeq = ref(0);
const errorText = ref("");
const requestPct = ref(36);

function cfg(): HttpConfig {
  return props.session.config as HttpConfig;
}

function patch(data: Partial<HttpConfig>) {
  sessions.updateConfig(props.session.id, data);
}

function ensureHttpShape() {
  const c = cfg();
  if (c.kind !== "http") return;
  const next: Partial<HttpConfig> = {};
  if (!c.params?.length) next.params = [{ key: "", value: "" }];
  if (!c.headers?.length) next.headers = [{ key: "", value: "" }];
  if (c.body == null) next.body = "";
  if (!c.authType) next.authType = "none";
  if (c.authUser == null) next.authUser = "";
  if (c.authPass == null) next.authPass = "";
  if (c.authToken == null) next.authToken = "";
  if (Object.keys(next).length) patch(next);
}

watch(
  () => props.session.id,
  () => {
    response.value = null;
    errorText.value = "";
    ensureHttpShape();
  },
  { immediate: true },
);

function filledCount(rows: HttpPair[] | undefined) {
  return (rows ?? []).filter((row) => row.key.trim()).length;
}

const paramCount = computed(() => filledCount(cfg().params));
const headerCount = computed(() => filledCount(cfg().headers));

const sendsBody = computed(() => {
  const method = cfg().method;
  return method !== "GET" && method !== "HEAD";
});

function addRow(field: "params" | "headers") {
  patch({ [field]: [...(cfg()[field] ?? []), { key: "", value: "" }] });
}

function removeRow(field: "params" | "headers", index: number) {
  const list = [...(cfg()[field] ?? [])];
  list.splice(index, 1);
  if (list.length === 0) list.push({ key: "", value: "" });
  patch({ [field]: list });
}

function setPair(field: "params" | "headers", index: number, key: keyof HttpPair, value: string) {
  const list = (cfg()[field] ?? []).map((row, i) =>
    i === index ? { ...row, [key]: value } : row,
  );
  patch({ [field]: list });
}

function setMethod(method: HttpConfig["method"]) {
  const next: Partial<HttpConfig> = { method };
  if (method !== "GET" && method !== "HEAD") {
    const headers = [...(cfg().headers ?? [])];
    const hasType = headers.some((row) => row.key.trim().toLowerCase() === "content-type");
    if (!hasType) {
      const row = { key: "Content-Type", value: "application/json" };
      const blank = headers.findIndex((item) => !item.key.trim() && !item.value);
      if (blank >= 0) headers[blank] = row;
      else headers.unshift(row);
      next.headers = headers;
    }
  }
  patch(next);
}

function withParams(raw: string) {
  const q = (cfg().params ?? []).filter((p) => p.key.trim());
  if (!q.length) return raw;
  try {
    const url = new URL(raw);
    for (const p of q) url.searchParams.set(p.key.trim(), p.value);
    return url.toString();
  } catch {
    const join = raw.includes("?") ? "&" : "?";
    return (
      raw +
      join +
      q
        .map((p) => `${encodeURIComponent(p.key.trim())}=${encodeURIComponent(p.value)}`)
        .join("&")
    );
  }
}

function basicToken(user: string, pass: string) {
  const bytes = new TextEncoder().encode(`${user}:${pass}`);
  let bin = "";
  for (const byte of bytes) bin += String.fromCharCode(byte);
  return btoa(bin);
}

function authHeaders(): HttpPair[] {
  const c = cfg();
  if (c.authType === "basic" && c.authUser) {
    return [{ key: "Authorization", value: `Basic ${basicToken(c.authUser, c.authPass)}` }];
  }
  if (c.authType === "bearer" && c.authToken?.trim()) {
    return [{ key: "Authorization", value: `Bearer ${c.authToken.trim()}` }];
  }
  return [];
}

function readEnvelope(text: string): { code: number; msg: string } | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{")) return null;
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const obj = value as Record<string, unknown>;
  if (typeof obj.code !== "number" || !Number.isInteger(obj.code)) return null;
  const msg = obj.msg ?? obj.message;
  if (typeof msg !== "string") return null;
  return { code: obj.code, msg };
}

const envelope = computed(() => readEnvelope(response.value?.body ?? ""));

const prettyBody = computed(() => {
  const text = response.value?.body ?? "";
  if (!text) return "";
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
});

function langOf(contentType: string, text: string): CmLang {
  const ct = contentType.toLowerCase();
  if (ct.includes("json")) return "json";
  if (ct.includes("html")) return "html";
  if (ct.includes("xml")) return "xml";
  const trimmed = text.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) return "json";
  return "plain";
}

const responseLang = computed((): CmLang => {
  const res = response.value;
  if (!res) return "plain";
  const ct = res.headers.find((h) => h.key.toLowerCase() === "content-type")?.value ?? "";
  return langOf(ct, res.body);
});

const verdict = computed(() => {
  const res = response.value;
  if (!res) return null;
  const env = envelope.value;
  const http = `${res.status}${res.statusText ? ` ${res.statusText}` : ""}`;
  if (env && env.code !== 0 && env.code !== 200) {
    const tone = env.code >= 400 || res.status >= 400 ? "err" : "warn";
    return {
      tone,
      primary: String(env.code),
      secondary: env.msg,
      showHttp: env.code !== res.status,
    };
  }
  let tone: "ok" | "err" | "warn" = "ok";
  if (res.status >= 400) tone = "err";
  else if (res.status < 200 || res.status >= 300) tone = "warn";
  const secondary = env && env.code !== res.status ? String(env.code) : "";
  return { tone, primary: http, secondary, showHttp: false };
});

const toneClass = computed(() => {
  if (verdict.value?.tone === "err") return "text-err";
  if (verdict.value?.tone === "warn") return "text-warn";
  return "text-rx";
});

const metaText = computed(() => {
  const res = response.value;
  if (!res) return "";
  const parts: string[] = [];
  if (verdict.value?.showHttp) parts.push(`HTTP ${res.status}`);
  parts.push(`${res.timeMs} ms`, formatBytes(res.byteLength));
  if (res.truncated) parts.push(t("http.truncated"));
  return parts.join(" · ");
});

const bodyTypes = computed(() => [
  { value: "application/json", label: "JSON" },
  { value: "application/xml", label: "XML" },
  { value: "application/x-www-form-urlencoded", label: t("http.form") },
  { value: "text/plain", label: t("http.text") },
  { value: "application/octet-stream", label: t("http.binary") },
]);

const contentType = computed(() => {
  const row = (cfg().headers ?? []).find((h) => h.key.trim().toLowerCase() === "content-type");
  return row?.value?.trim() || "application/json";
});

const bodyLang = computed(() => langOf(contentType.value, cfg().body ?? ""));

const bodyTypeOptions = computed(() => {
  const list = bodyTypes.value;
  const cur = contentType.value;
  if (list.some((item) => item.value === cur)) return list;
  return [{ value: cur, label: cur }, ...list];
});

function setContentType(value: string) {
  const list = [...(cfg().headers ?? [])];
  const index = list.findIndex((h) => h.key.trim().toLowerCase() === "content-type");
  if (index >= 0) list[index] = { ...list[index], key: "Content-Type", value };
  else list.unshift({ key: "Content-Type", value });
  patch({ headers: list });
}

const authOptions = computed(() => [
  { value: "none", label: t("http.authNone") },
  { value: "basic", label: "Basic" },
  { value: "bearer", label: "Bearer" },
]);

function valueOptions(key: string) {
  return headerValueOptions(key);
}

async function copyBody() {
  const text = prettyBody.value;
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    toast.success(t("common.copied"));
  } catch {
    toast.error(t("err.copyFail"));
  }
}

async function send() {
  if (sending.value) return;
  const url = withParams(cfg().url.trim());
  if (!url) {
    toast.error(t("err.missing_url"));
    return;
  }
  sending.value = true;
  errorText.value = "";
  try {
    const method = cfg().method;
    const res = await invokeHttp({
      method,
      url,
      headers: [...(cfg().headers ?? []).filter((h) => h.key.trim()), ...authHeaders()],
      body: sendsBody.value ? cfg().body : null,
      timeoutMs: ui.settings.httpTimeoutMs,
    });
    response.value = res;
    responseSeq.value += 1;
  } catch (err) {
    response.value = null;
    errorText.value = errorMessage(err);
    toast.error(errorText.value);
  } finally {
    sending.value = false;
  }
}

function onKey(event: KeyboardEvent) {
  if (!(event.ctrlKey || event.metaKey) || event.key !== "Enter") return;
  const el = event.target as HTMLElement | null;
  if (el?.closest("[role=dialog]")) return;
  event.preventDefault();
  void send();
}

function onSplitDown(event: PointerEvent) {
  const handle = event.currentTarget as HTMLElement;
  const grid = handle.parentElement;
  if (!grid) return;
  handle.setPointerCapture(event.pointerId);
  const move = (ev: PointerEvent) => {
    const rect = grid.getBoundingClientRect();
    if (rect.height <= 0) return;
    const pct = ((ev.clientY - rect.top) / rect.height) * 100;
    requestPct.value = Math.min(62, Math.max(22, pct));
  };
  const up = (ev: PointerEvent) => {
    handle.releasePointerCapture(ev.pointerId);
    handle.removeEventListener("pointermove", move);
    handle.removeEventListener("pointerup", up);
  };
  handle.addEventListener("pointermove", move);
  handle.addEventListener("pointerup", up);
}

onMounted(() => window.addEventListener("keydown", onKey));
onUnmounted(() => window.removeEventListener("keydown", onKey));
</script>

<template>
  <div class="flex h-full min-h-0 min-w-0 flex-col">
    <div class="flex shrink-0 items-center gap-2 border-b border-border bg-bg-1/40 px-3 py-2">
      <AppSelect
        :model-value="cfg().method"
        :options="methods"
        size="default"
        class="w-[108px]"
        :class="methodTone[cfg().method]"
        @update:model-value="setMethod($event as HttpConfig['method'])"
      />
      <Input
        :model-value="cfg().url"
        class="h-8 flex-1 font-mono text-xs"
        placeholder="http://127.0.0.1:8080/api"
        @update:model-value="patch({ url: String($event) })"
      />
      <PageHelp page="http" />
      <Button size="sm" :disabled="sending" @click="send">
        {{ sending ? t("common.sending") : t("common.send") }}
        <kbd v-if="!sending" class="ml-1 font-mono text-[10px] opacity-70">Ctrl+Enter</kbd>
      </Button>
    </div>

    <div
      class="grid min-h-0 flex-1"
      :style="{ gridTemplateRows: `${requestPct}% 6px minmax(0, 1fr)` }"
    >
      <Tabs default-value="headers" class="min-h-0 gap-0 overflow-hidden">
        <div class="shrink-0 border-b border-border px-3">
          <TabsList variant="line" class="h-9">
            <TabsTrigger value="params">
              {{ t("http.params") }}
              <span v-if="paramCount" class="font-mono text-[10px] tabular-nums text-muted-foreground">{{ paramCount }}</span>
            </TabsTrigger>
            <TabsTrigger value="headers">
              {{ t("http.headers") }}
              <span v-if="headerCount" class="font-mono text-[10px] tabular-nums text-muted-foreground">{{ headerCount }}</span>
            </TabsTrigger>
            <TabsTrigger value="body">{{ t("http.body") }}</TabsTrigger>
            <TabsTrigger value="auth">{{ t("http.auth") }}</TabsTrigger>
          </TabsList>
        </div>
        <TabsContent value="params" class="mt-0 min-h-0 space-y-1.5 overflow-auto p-3">
          <div v-for="(row, i) in cfg().params" :key="i" class="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_1.75rem] items-center gap-1.5">
            <Input
              :model-value="row.key"
              class="h-7 text-xs"
              :placeholder="t('http.name')"
              @update:model-value="setPair('params', i, 'key', String($event))"
            />
            <Input
              :model-value="row.value"
              class="h-7 text-xs"
              :placeholder="t('http.value')"
              @update:model-value="setPair('params', i, 'value', String($event))"
            />
            <Button variant="ghost" size="icon-xs" @click="removeRow('params', i)">
              <X class="size-3" />
            </Button>
          </div>
          <Button variant="outline" size="sm" class="text-muted-foreground" @click="addRow('params')">
            <Plus class="size-3.5" />
            {{ t("http.addParam") }}
          </Button>
        </TabsContent>
        <TabsContent value="headers" class="mt-0 min-h-0 space-y-1.5 overflow-auto p-3">
          <div v-for="(row, i) in cfg().headers" :key="i" class="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_1.75rem] items-center gap-1.5">
            <SuggestInput
              :model-value="row.key"
              :options="HTTP_HEADER_NAMES"
              :placeholder="t('http.name')"
              @update:model-value="setPair('headers', i, 'key', $event)"
            />
            <SuggestInput
              v-if="valueOptions(row.key).length"
              :model-value="row.value"
              :options="valueOptions(row.key)"
              :placeholder="t('http.value')"
              @update:model-value="setPair('headers', i, 'value', $event)"
            />
            <Input
              v-else
              :model-value="row.value"
              class="h-7 text-xs"
              :placeholder="t('http.value')"
              @update:model-value="setPair('headers', i, 'value', String($event))"
            />
            <Button variant="ghost" size="icon-xs" @click="removeRow('headers', i)">
              <X class="size-3" />
            </Button>
          </div>
          <Button variant="outline" size="sm" class="text-muted-foreground" @click="addRow('headers')">
            <Plus class="size-3.5" />
            {{ t("http.addHeader") }}
          </Button>
        </TabsContent>
        <TabsContent value="body" class="mt-0 flex min-h-0 flex-col overflow-hidden p-0">
          <p v-if="!sendsBody" class="px-3 py-2 text-xs text-muted-foreground">{{ t("http.noBody") }}</p>
          <template v-else>
            <div class="flex shrink-0 items-center border-b border-border px-3 py-1.5">
              <AppSelect
                :model-value="contentType"
                :options="bodyTypeOptions"
                class="w-40"
                @update:model-value="setContentType($event)"
              />
            </div>
            <div class="min-h-0 flex-1">
              <CodeEditor
                :model-value="cfg().body"
                :language="bodyLang"
                :lint="bodyLang === 'json'"
                @update:model-value="patch({ body: $event })"
              />
            </div>
          </template>
        </TabsContent>
        <TabsContent value="auth" class="mt-0 min-h-0 space-y-3 overflow-auto p-3">
          <AppSelect
            :model-value="cfg().authType"
            :options="authOptions"
            class="w-44"
            @update:model-value="patch({ authType: $event as HttpConfig['authType'] })"
          />
          <div v-if="cfg().authType === 'basic'" class="flex gap-2">
            <Input
              :model-value="cfg().authUser"
              class="h-7 text-xs"
              :placeholder="t('bar.username')"
              @update:model-value="patch({ authUser: String($event) })"
            />
            <Input
              :model-value="cfg().authPass"
              class="h-7 text-xs"
              type="password"
              :placeholder="t('common.password')"
              @update:model-value="patch({ authPass: String($event) })"
            />
          </div>
          <Input
            v-else-if="cfg().authType === 'bearer'"
            :model-value="cfg().authToken"
            class="h-7 text-xs"
            placeholder="Token"
            @update:model-value="patch({ authToken: String($event) })"
          />
        </TabsContent>
      </Tabs>

      <div
        class="cursor-row-resize border-y border-border bg-bg-1/60 hover:bg-foreground/15"
        @pointerdown="onSplitDown"
      />

      <div class="flex min-h-0 flex-col overflow-hidden">
        <div class="flex h-8 shrink-0 items-center gap-2 border-b border-border px-3 text-xs">
          <template v-if="verdict">
            <span class="font-mono text-[13px] font-medium tabular-nums" :class="toneClass">{{ verdict.primary }}</span>
            <span v-if="verdict.secondary" class="min-w-0 truncate">{{ verdict.secondary }}</span>
          </template>
          <span v-else-if="errorText" class="min-w-0 truncate text-err">{{ errorText }}</span>
          <span v-if="metaText" class="ml-auto shrink-0 font-mono tabular-nums text-muted-foreground">{{ metaText }}</span>
          <Button
            v-if="prettyBody"
            variant="ghost"
            size="icon-xs"
            class="text-muted-foreground"
            :class="metaText ? '' : 'ml-auto'"
            @click="copyBody"
          >
            <Copy class="size-3.5" />
          </Button>
        </div>
        <Tabs default-value="body" class="min-h-0 flex-1 gap-0 overflow-hidden">
          <div class="shrink-0 border-b border-border px-3">
            <TabsList variant="line" class="h-8">
              <TabsTrigger value="body">{{ t("http.body") }}</TabsTrigger>
              <TabsTrigger value="headers">
                {{ t("http.resHeaders") }}
                <span v-if="response" class="font-mono text-[10px] tabular-nums text-muted-foreground">{{ response.headers.length }}</span>
              </TabsTrigger>
            </TabsList>
          </div>
          <TabsContent value="body" class="mt-0 min-h-0 overflow-hidden p-0">
            <CodeEditor
              v-if="prettyBody"
              :key="responseSeq"
              :model-value="prettyBody"
              :language="responseLang"
              readonly
            />
            <p v-else class="px-3 py-2 text-xs text-muted-foreground">—</p>
          </TabsContent>
          <TabsContent value="headers" class="mt-0 min-h-0 overflow-auto p-0">
            <div
              v-if="response?.headers.length"
              class="grid grid-cols-[minmax(9rem,16rem)_minmax(0,1fr)] gap-x-4 border-b border-border px-3 py-1.5 text-[11px] text-muted-foreground"
            >
              <span>{{ t("http.name") }}</span>
              <span>{{ t("http.value") }}</span>
            </div>
            <div
              v-for="(h, i) in response?.headers ?? []"
              :key="i"
              class="grid grid-cols-[minmax(9rem,16rem)_minmax(0,1fr)] gap-x-4 border-b border-border/50 px-3 py-1 font-mono text-[12px]"
            >
              <span class="truncate text-muted-foreground">{{ h.key }}</span>
              <span class="min-w-0 break-all">{{ h.value || "—" }}</span>
            </div>
            <p v-if="!response?.headers.length" class="px-3 py-2 text-xs text-muted-foreground">—</p>
          </TabsContent>
        </Tabs>
      </div>
    </div>
  </div>
</template>
