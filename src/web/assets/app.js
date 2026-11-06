// Client shell: clean URLs, lazy tab modules, and an in-memory request cache.
// No framework and no build step; files are served as native ES modules.

import { getJson, getAllPages, postJson } from "./lib/api.js";
import { clear, errorText, h, showError, toast } from "./lib/dom.js";

const root = document.getElementById("app");
const main = document.getElementById("main");
const boot = root ? JSON.parse(root.dataset.bootstrap ?? "{}") : {};

const TABS = {
  "/": { title: "Beranda", load: () => import("./tabs/home.js") },
  "/generate": { title: "Generate", load: () => import("./tabs/generate.js") },
  "/log": { title: "Log Absensi", load: () => import("./tabs/log.js") },
  "/employees": { title: "Karyawan", load: () => import("./tabs/employees.js") },
  "/schedule": { title: "Jadwal", load: () => import("./tabs/schedule.js") },
  "/hooks": { title: "Hooks", load: () => import("./tabs/hooks.js") },
  "/settings": { title: "Settings", load: () => import("./tabs/settings.js") },
  "/about": { title: "About", load: () => import("./tabs/about.js") },
};

if (boot.read_only === true) {
  delete TABS["/hooks"];
  delete TABS["/settings"];
}

const cache = new Map();
let renderToken = 0;

async function cached(key, loader, force = false) {
  if (!force && cache.has(key)) return cache.get(key);
  const promise = Promise.resolve().then(loader);
  cache.set(key, promise);
  try {
    return await promise;
  } catch (error) {
    if (cache.get(key) === promise) cache.delete(key);
    throw error;
  }
}

function invalidate(prefix = "") {
  for (const key of cache.keys()) {
    if (key.startsWith(prefix)) cache.delete(key);
  }
}

function navigate(path, replace = false) {
  const target = normalizePath(path);
  if (replace) history.replaceState({}, "", target);
  else history.pushState({}, "", target);
  closeDrawer();
  void render();
}

function normalizePath(path) {
  if (!path) return "/";
  const clean = path.split("?")[0].split("#")[0];
  if (clean === "/") return "/";
  return clean.replace(/\/+$/, "") || "/";
}

function currentPath() {
  return normalizePath(location.pathname);
}

// --- Mobile navigation drawer -------------------------------------------
// The sidebar is always in the DOM; below 1024px CSS turns it into an
// off-canvas drawer that these handlers open and close.

const toggle = document.getElementById("nav-toggle");
const drawer = document.getElementById("nav-drawer");
const scrim = document.getElementById("nav-scrim");
const closeButton = document.getElementById("nav-close");

function drawerOpen() {
  return drawer !== null && drawer.classList.contains("open");
}

function setDrawer(open) {
  if (drawer === null) return;
  drawer.classList.toggle("open", open);
  if (scrim !== null) scrim.hidden = !open;
  if (toggle !== null) toggle.setAttribute("aria-expanded", open ? "true" : "false");
  document.body.classList.toggle("nav-locked", open);
  if (open) closeButton?.focus();
  else if (toggle !== null) toggle.focus();
}

function openDrawer() {
  setDrawer(true);
}

function closeDrawer(restoreFocus = false) {
  if (drawer === null) return;
  const wasOpen = drawerOpen();
  drawer.classList.remove("open");
  if (scrim !== null) scrim.hidden = true;
  if (toggle !== null) toggle.setAttribute("aria-expanded", "false");
  document.body.classList.remove("nav-locked");
  if (wasOpen && restoreFocus) toggle?.focus();
}

toggle?.addEventListener("click", () => {
  if (drawerOpen()) closeDrawer(true);
  else openDrawer();
});
closeButton?.addEventListener("click", () => closeDrawer(true));
scrim?.addEventListener("click", () => closeDrawer(true));

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && drawerOpen()) {
    event.preventDefault();
    closeDrawer(true);
  }
});

function markActive(path) {
  for (const link of document.querySelectorAll("#nav a[data-link]")) {
    const target = normalizePath(new URL(link.href, location.origin).pathname);
    const active = target === path;
    link.classList.toggle("active", active);
    if (active) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  }
}

function makeContext() {
  return {
    bootstrap: boot,
    cached,
    invalidate,
    navigate,
    refresh: () => render(),
    getJson,
    getAllPages,
    postJson,
    toast,
    errorText,
  };
}

async function render() {
  const path = currentPath();
  const tab = TABS[path];
  const token = ++renderToken;
  markActive(path);
  clear(main);

  if (!tab) {
    document.title = "Tidak ditemukan · Absenly";
    main.append(
      h(
        "div",
        { class: "card" },
        h("h1", null, "404"),
        h("p", { class: "muted" }, "Halaman tidak ditemukan."),
        h("a", { href: "/", class: "button", "data-link": "" }, "Kembali ke Beranda"),
      ),
    );
    return;
  }

  document.title = `${tab.title} · Absenly`;
  main.append(h("p", { class: "loading" }, "Memuat…"));

  try {
    const module = await tab.load();
    if (token !== renderToken) return;
    clear(main);
    await module.render(main, makeContext());
  } catch (error) {
    if (token !== renderToken) return;
    showError(main, error);
  }
}

document.addEventListener("click", (event) => {
  const link = event.target.closest("a[data-link]");
  if (!link) return;
  if (event.defaultPrevented || event.button !== 0) return;
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  const url = new URL(link.href, location.origin);
  if (url.origin !== location.origin) return;
  event.preventDefault();
  navigate(url.pathname);
});

window.addEventListener("popstate", () => void render());

if (root) {
  void render();
}
