import { computed, ref } from "vue";
import { en } from "./en";
import { zh } from "./zh";

export type LocalePref = "system" | "zh" | "en";
export type LocaleId = "zh" | "en";

const pref = ref<LocalePref>("system");

export function osLocale(): LocaleId {
  const lang = typeof navigator === "undefined" ? "" : navigator.language;
  return lang.toLowerCase().startsWith("zh") ? "zh" : "en";
}

export function setLocalePref(next: LocalePref) {
  pref.value = next;
}

export function localePref(): LocalePref {
  return pref.value;
}

export const resolvedLocale = computed<LocaleId>(() =>
  pref.value === "system" ? osLocale() : pref.value,
);

type Dict = typeof zh;

function lookup(dict: Dict, path: string): string | undefined {
  let cur: unknown = dict;
  for (const part of path.split(".")) {
    if (!cur || typeof cur !== "object" || !(part in cur)) return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return typeof cur === "string" ? cur : undefined;
}

export function t(key: string, vars?: Record<string, string | number>): string {
  const dict = resolvedLocale.value === "en" ? en : zh;
  let out = lookup(dict, key) ?? lookup(zh, key) ?? key;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      out = out.split(`{${k}}`).join(String(v));
    }
  }
  return out;
}

const ERR_PREFIX: [string, string, string][] = [
  ["over_mb:", "err.overMb", "n"],
  ["exists:", "err.exists", "path"],
  ["connect_failed:", "err.connectFailed", "detail"],
  ["bind_failed:", "err.bindFailed", "detail"],
  ["listen_failed:", "err.listenFailed", "detail"],
  ["bad_method:", "err.badMethod", "method"],
];

export function translateError(raw: string): string {
  const lower = raw.toLowerCase();
  if (
    raw === "local_network" ||
    lower.includes("no route to host") ||
    lower.includes("host is unreachable")
  ) {
    return t("err.local_network");
  }
  const keyed = lookup(resolvedLocale.value === "en" ? en : zh, `err.${raw}`) ?? lookup(zh, `err.${raw}`);
  if (keyed) return keyed;
  for (const [prefix, key, name] of ERR_PREFIX) {
    if (raw.startsWith(prefix)) return t(key, { [name]: raw.slice(prefix.length) });
  }
  return raw;
}
