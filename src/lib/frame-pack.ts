import type { FrameSchema } from "@/lib/frame-schema";
import { downloadJson, pickJsonFile } from "@/lib/session-pack";
import { useFrameSchemasStore } from "@/stores/frame-schemas";
import { t } from "@/i18n";
import { toast } from "vue-sonner";

function asSchemaList(raw: unknown): FrameSchema[] {
  if (Array.isArray(raw)) return raw as FrameSchema[];
  if (raw && typeof raw === "object") {
    const obj = raw as { schemas?: FrameSchema[]; schema?: FrameSchema };
    if (Array.isArray(obj.schemas)) return obj.schemas;
    if (obj.schema) return [obj.schema];
  }
  return [];
}

export function exportFrameSchemas(list: FrameSchema[]) {
  const items = list.filter((s) => !s.builtin);
  if (!items.length) {
    toast.error(t("pack.noSchema"));
    return;
  }
  downloadJson("feisuo-frame-schemas.json", { version: 1, schemas: items });
}

export async function importFrameSchemas() {
  let raw: unknown;
  try {
    raw = await pickJsonFile();
  } catch (err) {
    toast.error(err instanceof Error ? err.message : t("pack.importFail"));
    return;
  }
  const list = asSchemaList(raw);
  if (!list.length) {
    toast.error(t("pack.noSchemaInFile"));
    return;
  }
  useFrameSchemasStore().importList(list);
  toast.success(t("pack.importedSchemas", { n: list.length }));
}
