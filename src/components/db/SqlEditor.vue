<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import { EditorView, keymap, lineNumbers, highlightActiveLine, placeholder } from "@codemirror/view";
import { EditorState, Compartment } from "@codemirror/state";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { sql, PostgreSQL, MySQL, SQLite } from "@codemirror/lang-sql";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";
import type { DbEngine } from "@/types";
import { useUiStore } from "@/stores/ui";

const props = defineProps<{
  modelValue: string;
  dialect: DbEngine;
}>();

const emit = defineEmits<{
  "update:modelValue": [value: string];
  run: [sql: string];
}>();

const host = ref<HTMLDivElement | null>(null);
const ui = useUiStore();
let view: EditorView | null = null;
const dialectComp = new Compartment();
const themeComp = new Compartment();

const highlight = HighlightStyle.define([
  { tag: t.keyword, color: "var(--primary)" },
  { tag: t.string, color: "var(--rx)" },
  { tag: t.number, color: "var(--warn)" },
  { tag: t.comment, color: "var(--muted-foreground)", fontStyle: "italic" },
  { tag: t.operator, color: "var(--foreground)" },
  { tag: t.typeName, color: "var(--primary)" },
  { tag: t.bool, color: "var(--warn)" },
  { tag: t.null, color: "var(--muted-foreground)" },
]);

function dialectExt(engine: DbEngine) {
  const dialect = engine === "mysql" ? MySQL : engine === "sqlite" ? SQLite : PostgreSQL;
  return sql({ dialect });
}

function themeExt(dark: boolean) {
  return EditorView.theme(
    {
      "&": {
        height: "100%",
        backgroundColor: "transparent",
        color: "var(--foreground)",
        fontSize: "13px",
      },
      "&.cm-focused": { outline: "none" },
      ".cm-scroller": {
        overflow: "auto",
        fontFamily: '"JetBrains Mono", ui-monospace, monospace',
      },
      ".cm-content": { caretColor: "var(--primary)", padding: "8px 0" },
      ".cm-gutters": {
        backgroundColor: "transparent",
        color: "var(--muted-foreground)",
        border: "none",
      },
      ".cm-activeLine": {
        backgroundColor: "color-mix(in srgb, var(--primary) 8%, transparent)",
      },
      ".cm-activeLineGutter": { backgroundColor: "transparent" },
      ".cm-selectionBackground, &.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground":
        {
          backgroundColor: "color-mix(in srgb, var(--primary) 28%, transparent) !important",
        },
      ".cm-cursor": { borderLeftColor: "var(--primary)" },
      ".cm-placeholder": { color: "var(--muted-foreground)" },
    },
    { dark },
  );
}

function sqlToRun(ed: EditorView): string {
  const sel = ed.state.selection.main;
  const text = sel.empty ? ed.state.doc.toString() : ed.state.sliceDoc(sel.from, sel.to);
  return text.trim();
}

function mountEditor() {
  if (!host.value || view) return;
  view = new EditorView({
    parent: host.value,
    state: EditorState.create({
      doc: props.modelValue,
      extensions: [
        lineNumbers(),
        highlightActiveLine(),
        history(),
        syntaxHighlighting(highlight),
        dialectComp.of(dialectExt(props.dialect)),
        themeComp.of(themeExt(ui.settings.theme !== "light")),
        placeholder("SELECT"),
        keymap.of([
          {
            key: "Mod-Enter",
            run: (ed) => {
              emit("run", sqlToRun(ed));
              return true;
            },
          },
          ...defaultKeymap,
          ...historyKeymap,
          indentWithTab,
        ]),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) emit("update:modelValue", u.state.doc.toString());
        }),
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
    view?.dispatch({ effects: themeComp.reconfigure(themeExt(theme !== "light")) });
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

defineExpose({
  runSql(): string {
    return view ? sqlToRun(view) : props.modelValue.trim();
  },
});
</script>

<template>
  <div ref="host" class="h-full min-h-0 w-full overflow-hidden" />
</template>
