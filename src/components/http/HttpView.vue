<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { toast } from "vue-sonner";
import { Plus, X } from "@lucide/vue";
import type { HttpConfig, HttpPair, Session } from "@/types";
import type { HttpResponsePayload } from "@/lib/ipc";
import { t } from "@/i18n";
import { errorMessage, invokeHttp } from "@/lib/ipc";
import { formatBytes } from "@/lib/format";
import { useSessionsStore } from "@/stores/sessions";
import { useUiStore } from "@/stores/ui";
import AppSelect from "@/components/common/AppSelect.vue";
import SuggestInput from "@/components/common/SuggestInput.vue";
import PageHelp from "@/components/common/PageHelp.vue";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
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

const sending = ref(false);
const response = ref<HttpResponsePayload | null>(null);
const errorText = ref("");

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
  if (!c.headers?.length) next.headers = [{ key: "Content-Type", value: "application/json" }];
  if (c.body == null) next.body = "{\n  \n}";
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

function authHeaders(): HttpPair[] {
  const c = cfg();
  if (c.authType === "basic" && c.authUser) {
    return [
      {
        key: "Authorization",
        value: `Basic ${btoa(`${c.authUser}:${c.authPass}`)}`,
      },
    ];
  }
  if (c.authType === "bearer" && c.authToken?.trim()) {
    return [{ key: "Authorization", value: `Bearer ${c.authToken.trim()}` }];
  }
  return [];
}

const prettyBody = computed(() => {
  const text = response.value?.body ?? "";
  if (!text) return "";
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
});

const statusClass = computed(() => {
  const status = response.value?.status ?? 0;
  if (status >= 200 && status < 300) return "text-emerald-400";
  if (status >= 400) return "text-err";
  if (status) return "text-amber-400";
  return "text-muted-foreground";
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

async function send() {
  const url = withParams(cfg().url.trim());
  if (!url) {
    toast.error(t("err.missing_url"));
    return;
  }
  sending.value = true;
  errorText.value = "";
  try {
    const method = cfg().method;
    const skipBody = method === "GET" || method === "HEAD";
    const res = await invokeHttp({
      method,
      url,
      headers: [...(cfg().headers ?? []).filter((h) => h.key.trim()), ...authHeaders()],
      body: skipBody ? null : cfg().body,
      timeoutMs: ui.settings.httpTimeoutMs,
    });
    response.value = res;
  } catch (err) {
    response.value = null;
    errorText.value = errorMessage(err);
    toast.error(errorText.value);
  } finally {
    sending.value = false;
  }
}
</script>

<template>
  <div class="flex h-full min-w-0 flex-col">
    <div class="flex items-center gap-2 border-b border-border bg-bg-1/40 px-3 py-2">
      <AppSelect
        :model-value="cfg().method"
        :options="methods"
        size="default"
        class="w-[108px]"
        @update:model-value="patch({ method: $event as HttpConfig['method'] })"
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
      </Button>
    </div>

    <Tabs default-value="headers" class="flex min-h-0 flex-1 flex-col">
      <div class="border-b border-border px-3">
        <TabsList variant="line" class="h-9">
          <TabsTrigger value="params">Params</TabsTrigger>
          <TabsTrigger value="headers">Headers</TabsTrigger>
          <TabsTrigger value="body">Body</TabsTrigger>
          <TabsTrigger value="auth">Auth</TabsTrigger>
        </TabsList>
      </div>
      <TabsContent value="params" class="space-y-2 overflow-auto p-4">
        <div v-for="(row, i) in cfg().params" :key="i" class="flex gap-2">
          <Input :model-value="row.key" class="h-7 text-xs" placeholder="Key" @update:model-value="setPair('params', i, 'key', String($event))" />
          <Input :model-value="row.value" class="h-7 text-xs" placeholder="Value" @update:model-value="setPair('params', i, 'value', String($event))" />
          <Button variant="ghost" size="icon-xs" @click="removeRow('params', i)">
            <X class="size-3" />
          </Button>
        </div>
        <Button variant="outline" size="sm" class="text-muted-foreground" @click="addRow('params')">
          <Plus class="size-3.5" />
          {{ t("http.addParam") }}
        </Button>
      </TabsContent>
      <TabsContent value="headers" class="space-y-2 overflow-auto p-4">
        <div v-for="(row, i) in cfg().headers" :key="i" class="flex gap-2">
          <SuggestInput
            :model-value="row.key"
            :options="HTTP_HEADER_NAMES"
            placeholder="Header"
            @update:model-value="setPair('headers', i, 'key', $event)"
          />
          <SuggestInput
            v-if="valueOptions(row.key).length"
            :model-value="row.value"
            :options="valueOptions(row.key)"
            placeholder="Value"
            @update:model-value="setPair('headers', i, 'value', $event)"
          />
          <Input
            v-else
            :model-value="row.value"
            class="h-7 text-xs"
            placeholder="Value"
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
      <TabsContent value="body" class="space-y-2 p-3">
        <AppSelect
          :model-value="contentType"
          :options="bodyTypeOptions"
          class="w-36"
          @update:model-value="setContentType($event)"
        />
        <Textarea
          :model-value="cfg().body"
          class="selectable h-40 resize-none font-mono text-[13px]"
          @update:model-value="patch({ body: String($event) })"
        />
      </TabsContent>
      <TabsContent value="auth" class="space-y-3 p-4">
        <AppSelect
          :model-value="cfg().authType"
          :options="authOptions"
          class="w-44"
          @update:model-value="patch({ authType: $event as HttpConfig['authType'] })"
        />
        <div v-if="cfg().authType === 'basic'" class="flex gap-2">
          <Input :model-value="cfg().authUser" class="h-7 text-xs" :placeholder="t('bar.username')" @update:model-value="patch({ authUser: String($event) })" />
          <Input :model-value="cfg().authPass" class="h-7 text-xs" type="password" :placeholder="t('common.password')" @update:model-value="patch({ authPass: String($event) })" />
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

    <div class="border-t border-border px-3 py-2 text-xs">
      <span v-if="response" :class="statusClass">
        {{ response.status }} {{ response.statusText }} · {{ response.timeMs }}ms ·
        {{ formatBytes(response.byteLength) }}
        <span v-if="response.truncated" class="text-amber-400">{{ t("http.truncated") }}</span>
      </span>
      <span v-else-if="errorText" class="text-err">{{ errorText }}</span>
      <span v-else class="text-muted-foreground">
        —
      </span>
    </div>
    <div class="min-h-40 flex-1 overflow-auto border-t border-border">
      <div v-if="response?.headers.length" class="border-b border-border px-3 py-2 text-[11px] text-muted-foreground">
        <div v-for="(h, i) in response.headers" :key="i" class="font-mono">
          {{ h.key }}: {{ h.value }}
        </div>
      </div>
      <pre class="selectable p-4 font-mono text-xs whitespace-pre-wrap">{{ prettyBody || "—" }}</pre>
    </div>
  </div>
</template>
