import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { javascript } from "@codemirror/lang-javascript";
import { json, jsonParseLinter } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { python } from "@codemirror/lang-python";
import { sql } from "@codemirror/lang-sql";
import { xml } from "@codemirror/lang-xml";
import { yaml } from "@codemirror/lang-yaml";
import { HighlightStyle, StreamLanguage, syntaxHighlighting } from "@codemirror/language";
import { c, cpp, java } from "@codemirror/legacy-modes/mode/clike";
import { dockerFile } from "@codemirror/legacy-modes/mode/dockerfile";
import { go } from "@codemirror/legacy-modes/mode/go";
import { nginx } from "@codemirror/legacy-modes/mode/nginx";
import { properties } from "@codemirror/legacy-modes/mode/properties";
import { rust } from "@codemirror/legacy-modes/mode/rust";
import { shell } from "@codemirror/legacy-modes/mode/shell";
import { toml } from "@codemirror/legacy-modes/mode/toml";
import { linter } from "@codemirror/lint";
import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { tags as highlightTags } from "@lezer/highlight";

export type CmLang =
  | "plain"
  | "json"
  | "javascript"
  | "typescript"
  | "jsx"
  | "tsx"
  | "html"
  | "css"
  | "xml"
  | "markdown"
  | "python"
  | "yaml"
  | "sql"
  | "shell"
  | "rust"
  | "go"
  | "java"
  | "c"
  | "cpp"
  | "toml"
  | "ini"
  | "dockerfile"
  | "nginx";

const EXT_LANG: Record<string, CmLang> = {
  json: "json",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  jsx: "jsx",
  tsx: "tsx",
  html: "html",
  htm: "html",
  vue: "html",
  svelte: "html",
  css: "css",
  scss: "css",
  less: "css",
  xml: "xml",
  svg: "xml",
  xsd: "xml",
  md: "markdown",
  markdown: "markdown",
  py: "python",
  pyw: "python",
  yml: "yaml",
  yaml: "yaml",
  sql: "sql",
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  ksh: "shell",
  fish: "shell",
  rs: "rust",
  go: "go",
  java: "java",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  hh: "cpp",
  toml: "toml",
  ini: "ini",
  cfg: "ini",
  conf: "ini",
  properties: "ini",
  env: "ini",
  service: "ini",
};

export function languageOfFilename(name: string): CmLang {
  const base = name.replace(/^.*[/\\]/, "").toLowerCase();
  if (base === "dockerfile" || base.startsWith("dockerfile.")) return "dockerfile";
  if (base === "nginx.conf" || base.endsWith(".nginx")) return "nginx";
  if (base === "makefile" || base === "gnumakefile" || base.endsWith(".mk")) return "shell";
  const dot = base.lastIndexOf(".");
  if (dot < 0) return "plain";
  return EXT_LANG[base.slice(dot + 1)] ?? "plain";
}

function stream(parser: Parameters<typeof StreamLanguage.define>[0]): Extension {
  return StreamLanguage.define(parser);
}

export function cmLanguage(lang: CmLang): Extension {
  switch (lang) {
    case "json":
      return json();
    case "javascript":
      return javascript();
    case "typescript":
      return javascript({ typescript: true });
    case "jsx":
      return javascript({ jsx: true });
    case "tsx":
      return javascript({ typescript: true, jsx: true });
    case "html":
      return html();
    case "css":
      return css();
    case "xml":
      return xml();
    case "markdown":
      return markdown();
    case "python":
      return python();
    case "yaml":
      return yaml();
    case "sql":
      return sql();
    case "shell":
      return stream(shell);
    case "rust":
      return stream(rust);
    case "go":
      return stream(go);
    case "java":
      return stream(java);
    case "c":
      return stream(c);
    case "cpp":
      return stream(cpp);
    case "toml":
      return stream(toml);
    case "ini":
      return stream(properties);
    case "dockerfile":
      return stream(dockerFile);
    case "nginx":
      return stream(nginx);
    default:
      return [];
  }
}

export function cmJsonLint(): Extension {
  const parse = jsonParseLinter();
  return linter((view) => {
    if (!view.state.doc.toString().trim()) return [];
    return parse(view);
  });
}

export function cmHighlight(): Extension {
  return syntaxHighlighting(
    HighlightStyle.define([
      { tag: highlightTags.keyword, color: "var(--primary)" },
      { tag: highlightTags.string, color: "var(--rx)" },
      { tag: highlightTags.number, color: "var(--warn)" },
      { tag: highlightTags.comment, color: "var(--muted-foreground)", fontStyle: "italic" },
      { tag: highlightTags.operator, color: "var(--foreground)" },
      { tag: highlightTags.typeName, color: "var(--primary)" },
      { tag: highlightTags.bool, color: "var(--warn)" },
      { tag: highlightTags.null, color: "var(--muted-foreground)" },
      { tag: highlightTags.propertyName, color: "var(--primary)" },
      { tag: highlightTags.atom, color: "var(--warn)" },
      { tag: highlightTags.meta, color: "var(--muted-foreground)" },
      { tag: highlightTags.heading, color: "var(--primary)", fontWeight: "600" },
      { tag: highlightTags.link, color: "var(--primary)" },
      { tag: highlightTags.processingInstruction, color: "var(--muted-foreground)" },
      { tag: highlightTags.tagName, color: "var(--primary)" },
      { tag: highlightTags.attributeName, color: "var(--warn)" },
    ]),
  );
}

export function cmTheme(dark: boolean): Extension {
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
      ".cm-lineNumbers .cm-gutterElement": { minWidth: "2.5rem", padding: "0 8px 0 6px" },
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
      ".cm-lintRange-error": {
        backgroundImage: "none",
        borderBottom: "1px dashed var(--err)",
      },
    },
    { dark },
  );
}
