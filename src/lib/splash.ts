const MIN_MS = 2000;

function splashStarted() {
  const w = window as Window & { __splashAt?: number };
  return typeof w.__splashAt === "number" ? w.__splashAt : performance.now();
}

function dismiss() {
  const root = document.documentElement;
  root.classList.remove("booting");
  root.style.removeProperty("background");
  document.body.style.removeProperty("background");
  const el = document.getElementById("splash");
  if (!el || el.classList.contains("is-done")) return;
  el.classList.add("is-done");
  window.setTimeout(() => el.remove(), 280);
}

export function hideSplash() {
  window.setTimeout(dismiss, Math.max(0, MIN_MS - (performance.now() - splashStarted())));
}
