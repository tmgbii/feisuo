import { defineStore } from "pinia";
import { computed, ref } from "vue";
import { t } from "@/i18n";
import { BUILTIN_SCHEMAS } from "@/lib/frame-builtins";
import { blankSchema, schemaLabel, type FrameSchema } from "@/lib/frame-schema";

const BUILTIN_IDS = new Set(BUILTIN_SCHEMAS.map((s) => s.schemaId));
const BUILTIN_ORDER = new Map(BUILTIN_SCHEMAS.map((s, i) => [s.schemaId, i]));

function builtins(): FrameSchema[] {
  return BUILTIN_SCHEMAS.map((s) => JSON.parse(JSON.stringify(s)) as FrameSchema);
}

function normalize(item: FrameSchema): FrameSchema {
  return {
    schemaId: item.schemaId || crypto.randomUUID(),
    name: item.name || t("pack.unnamed"),
    builtin: Boolean(item.builtin),
    sample: item.sample,
    endian: item.endian === "little" ? "little" : "big",
    frame: {
      head: item.frame?.head ?? "",
      tail: item.frame?.tail ?? "",
      lengthField: item.frame?.lengthField,
      checksum: item.frame?.checksum,
      escape: item.frame?.escape ?? null,
    },
    fields: Array.isArray(item.fields) ? item.fields : [],
  };
}

export const useFrameSchemasStore = defineStore("frame-schemas", () => {
  const schemas = ref<FrameSchema[]>(builtins());
  const activeId = ref(BUILTIN_SCHEMAS[0]?.schemaId ?? "");

  const sorted = computed(() =>
    [...schemas.value].sort((a, b) => {
      if (a.builtin !== b.builtin) return a.builtin ? -1 : 1;
      if (a.builtin && b.builtin) return (BUILTIN_ORDER.get(a.schemaId) ?? 0) - (BUILTIN_ORDER.get(b.schemaId) ?? 0);
      return a.name.localeCompare(b.name, "zh");
    }),
  );
  const active = computed(() => schemas.value.find((s) => s.schemaId === activeId.value) ?? schemas.value[0] ?? null);

  function snapshot(): FrameSchema[] {
    return schemas.value.filter((s) => !s.builtin);
  }

  function hydrate(list: FrameSchema[]) {
    const extra = (list ?? [])
      .map(normalize)
      .filter((s) => !s.builtin && !BUILTIN_IDS.has(s.schemaId));
    schemas.value = [...builtins(), ...extra];
    if (!schemas.value.some((s) => s.schemaId === activeId.value)) {
      activeId.value = schemas.value[0]?.schemaId ?? "";
    }
  }

  function upsert(schema: FrameSchema) {
    const next = normalize({ ...schema, builtin: false });
    const i = schemas.value.findIndex((s) => s.schemaId === next.schemaId);
    if (i >= 0) {
      if (schemas.value[i].builtin) {
        next.schemaId = crypto.randomUUID();
        schemas.value.push(next);
      } else schemas.value[i] = next;
    } else schemas.value.push(next);
    activeId.value = next.schemaId;
  }

  function create(): FrameSchema {
    const item = blankSchema();
    schemas.value.push(item);
    activeId.value = item.schemaId;
    return item;
  }

  function remove(id: string) {
    const item = schemas.value.find((s) => s.schemaId === id);
    if (!item || item.builtin) return;
    schemas.value = schemas.value.filter((s) => s.schemaId !== id);
    if (activeId.value === id) activeId.value = schemas.value[0]?.schemaId ?? "";
  }

  function duplicate(id: string) {
    const item = schemas.value.find((s) => s.schemaId === id);
    if (!item) return;
    const copy = normalize({
      ...JSON.parse(JSON.stringify(item)) as FrameSchema,
      schemaId: crypto.randomUUID(),
      name: t("pack.copyName", { name: schemaLabel(item.name) }),
      builtin: false,
    });
    schemas.value.push(copy);
    activeId.value = copy.schemaId;
  }

  function importList(list: FrameSchema[]) {
    for (const item of list) {
      if (!item?.name && !item?.frame) continue;
      upsert({ ...item, builtin: false, schemaId: item.schemaId || crypto.randomUUID() });
    }
  }

  function select(id: string) {
    if (schemas.value.some((s) => s.schemaId === id)) activeId.value = id;
  }

  return { schemas, sorted, activeId, active, snapshot, hydrate, upsert, create, remove, duplicate, importList, select };
});
