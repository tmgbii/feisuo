import { ref } from "vue";
import type { DataMode } from "@/types";

export const pendingComposerInsert = ref<{ content: string; mode: DataMode } | null>(null);

export function insertToComposer(content: string, mode: DataMode = "hex") {
  pendingComposerInsert.value = { content, mode };
}
