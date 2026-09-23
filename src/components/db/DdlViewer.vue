<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import { EditorView, lineNumbers } from "@codemirror/view";
import { EditorState, Compartment } from "@codemirror/state";
import { sql, PostgreSQL, MySQL, SQLite, MSSQL } from "@codemirror/lang-sql";
import { cmHighlight, cmTheme } from "@/lib/codemirror";
import type { DbEngine } from "@/types";
import { useUiStore } from "@/stores/ui";

const props = defineProps<{
  modelValue: string;
  dialect: DbEngine;
}>();

const host = ref<HTMLDivElement | null>(null);
const ui = useUiStore();
let view: EditorView | null = null;
const dialectComp = new Compartment();
const themeComp = new Compartment();

function dialectExt(engine: DbEngine) {
  const dialect =
    engine === "mysql" ? MySQL : engine === "sqlite" ? SQLite : engine === "sqlserver" ? MSSQL : PostgreSQL;
  return sql({ dialect });
}

function mountEditor() {
  if (!host.value || view) return;
  view = new EditorView({
    parent: host.value,
    state: EditorState.create({
      doc: props.modelValue,
      extensions: [
        EditorState.readOnly.of(true),
        EditorView.editable.of(false),
        EditorView.lineWrapping,
        lineNumbers(),
        cmHighlight(),
        dialectComp.of(dialectExt(props.dialect)),
        themeComp.of(cmTheme(ui.settings.theme !== "light")),
      ],
    }),
  });
}

onMounted(mountEditor);
onBeforeUnmount(() => {
  view?.destroy();
  view = null;
});

watch(
  () => props.dialect,
  (engine) => {
    view?.dispatch({ effects: dialectComp.reconfigure(dialectExt(engine)) });
  },
);

watch(
  () => ui.settings.theme,
  (theme) => {
    view?.dispatch({ effects: themeComp.reconfigure(cmTheme(theme !== "light")) });
  },
);

watch(
  () => props.modelValue,
  (next) => {
    if (!view) return;
    if (next === view.state.doc.toString()) return;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: next },
    });
  },
);
</script>

<template>
  <div ref="host" class="h-full min-h-0 w-full overflow-hidden text-[12px]" />
</template>
