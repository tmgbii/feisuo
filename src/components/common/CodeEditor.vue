<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { indentUnit } from "@codemirror/language";
import { Compartment, EditorState } from "@codemirror/state";
import {
  EditorView,
  highlightActiveLine,
  keymap,
  lineNumbers,
  placeholder as cmPlaceholder,
} from "@codemirror/view";
import {
  cmHighlight,
  cmJsonLint,
  cmLanguage,
  cmTheme,
  languageOfFilename,
  type CmLang,
} from "@/lib/codemirror";
import { useUiStore } from "@/stores/ui";

const props = withDefaults(
  defineProps<{
    modelValue: string;
    language?: CmLang;
    filename?: string;
    readonly?: boolean;
    placeholder?: string;
    wrap?: boolean;
    lint?: boolean;
  }>(),
  {
    wrap: true,
    lint: false,
  },
);

const emit = defineEmits<{
  "update:modelValue": [value: string];
}>();

const host = ref<HTMLDivElement | null>(null);
const ui = useUiStore();
let view: EditorView | null = null;
let resizeObs: ResizeObserver | null = null;
const langComp = new Compartment();
const themeComp = new Compartment();
const readComp = new Compartment();
const wrapComp = new Compartment();
const lintComp = new Compartment();
const phComp = new Compartment();

function resolvedLang(): CmLang {
  return props.language ?? (props.filename ? languageOfFilename(props.filename) : "plain");
}

function langExt() {
  return cmLanguage(resolvedLang());
}

function readExt() {
  return [EditorView.editable.of(!props.readonly), EditorState.readOnly.of(props.readonly)];
}

function wrapExt() {
  return props.wrap ? EditorView.lineWrapping : [];
}

function lintExt() {
  return props.lint && resolvedLang() === "json" && !props.readonly ? cmJsonLint() : [];
}

function phExt() {
  return props.placeholder ? cmPlaceholder(props.placeholder) : [];
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
        indentUnit.of("  "),
        cmHighlight(),
        langComp.of(langExt()),
        themeComp.of(cmTheme(ui.settings.theme !== "light")),
        readComp.of(readExt()),
        wrapComp.of(wrapExt()),
        lintComp.of(lintExt()),
        phComp.of(phExt()),
        keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) emit("update:modelValue", u.state.doc.toString());
        }),
      ],
    }),
  });
  resizeObs = new ResizeObserver(() => view?.requestMeasure());
  resizeObs.observe(host.value);
}

onMounted(mountEditor);
onBeforeUnmount(() => {
  resizeObs?.disconnect();
  resizeObs = null;
  view?.destroy();
  view = null;
});

watch(
  () => [props.language, props.filename] as const,
  () => {
    view?.dispatch({ effects: [langComp.reconfigure(langExt()), lintComp.reconfigure(lintExt())] });
  },
);

watch(
  () => ui.settings.theme,
  (theme) => {
    view?.dispatch({ effects: themeComp.reconfigure(cmTheme(theme !== "light")) });
  },
);

watch(
  () => props.readonly,
  () => {
    view?.dispatch({ effects: [readComp.reconfigure(readExt()), lintComp.reconfigure(lintExt())] });
  },
);

watch(
  () => props.wrap,
  () => {
    view?.dispatch({ effects: wrapComp.reconfigure(wrapExt()) });
  },
);

watch(
  () => props.lint,
  () => {
    view?.dispatch({ effects: lintComp.reconfigure(lintExt()) });
  },
);

watch(
  () => props.placeholder,
  () => {
    view?.dispatch({ effects: phComp.reconfigure(phExt()) });
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
  <div ref="host" class="h-full min-h-0 w-full overflow-hidden" />
</template>
