// Server-rendered shell + login page. The shell carries only non-secret bootstrap data.

import type { ScheduleCalendar } from "../schedule.ts";
import type { SyncScheduleDto } from "../api/dto.ts";
import { esc, escAttr, jsonAttr } from "./html.ts";

export interface Bootstrap {
  version: string;
  page: string;
  today: string;
  now: string;
  role: "collector" | "viewer";
  read_only: boolean;
  web: { hostname: string; port: number; username: string };
  storage: { db_path: string; mode: string };
  device: { host: string; port: number; timeout_ms: number } | null;
  schedule: {
    source: "file" | "env" | "relay";
    file_path: string | null;
    calendar: ScheduleCalendar;
    month: Record<string, { in: string; out: string } | null>;
    error: string | null;
  };
  counts: { employees: number; attendance: number; profiles: number; active: number };
  password_source: "db" | "env";
  session_ttl_hours: number;
  auto_sync: { schedules: SyncScheduleDto[]; next_at: string | null };
}

const NAV: ReadonlyArray<{ path: string; label: string; collectorOnly?: boolean }> = [
  { path: "/", label: "Beranda" },
  { path: "/generate", label: "Generate" },
  { path: "/log", label: "Log Absensi" },
  { path: "/employees", label: "Karyawan" },
  { path: "/schedule", label: "Jadwal" },
  { path: "/hooks", label: "Hooks", collectorOnly: true },
  { path: "/settings", label: "Settings", collectorOnly: true },
  { path: "/about", label: "About" },
];

function navLinks(page: string, readOnly: boolean): string {
  return NAV.filter((item) => !(readOnly && item.collectorOnly === true))
    .map((item) => {
      const active = item.path === page ? ' class="active" aria-current="page"' : "";
      return `<a href="${item.path}" data-link${active}>${esc(item.label)}</a>`;
    })
    .join("");
}

function brandHtml(): string {
  return `<span class="brand-mark">RA</span><span>Absenly</span>`;
}

function logoutHtml(): string {
  return `<form method="post" action="/logout" class="logout-form">
      <button type="submit" class="button ghost">Keluar</button>
    </form>`;
}

export function renderShell(bootstrap: Bootstrap): string {
  const version = encodeURIComponent(bootstrap.version);
  const links = navLinks(bootstrap.page, bootstrap.read_only);
  return `<!doctype html>
<html lang="id">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <title>Absenly</title>
  <link rel="stylesheet" href="/assets/app.css?v=${version}">
</head>
<body class="app-body">
  <a class="skip" href="#main">Lewati ke konten</a>
  <header class="appbar">
    <button type="button" class="nav-toggle" id="nav-toggle" aria-expanded="false" aria-controls="nav-drawer">
      <span class="sr-only">Buka menu navigasi</span>
      <span class="nav-toggle-bars" aria-hidden="true"></span>
    </button>
    <div class="brand">${brandHtml()}</div>
  </header>
  <div class="nav-scrim" id="nav-scrim" hidden></div>
  <aside class="sidebar" id="nav-drawer" aria-label="Navigasi utama">
    <div class="sidebar-head">
      <a href="/" class="brand brand-link" data-link>${brandHtml()}</a>
      <button type="button" class="nav-close" id="nav-close">
        <span class="sr-only">Tutup menu</span>
        <span aria-hidden="true">×</span>
      </button>
    </div>
    <nav id="nav">${links}</nav>
    <div class="sidebar-foot">${logoutHtml()}</div>
  </aside>
  <main id="main" tabindex="-1"><p class="muted">Memuat…</p></main>
  <div id="app" data-bootstrap="${jsonAttr(bootstrap)}" hidden></div>
  <noscript><style>.appbar,.nav-toggle,.nav-close,.nav-scrim{display:none}.app-body{flex-direction:column}.sidebar{position:static;visibility:visible;transform:none;width:auto;height:auto;max-height:none;flex:none;border-right:0;border-bottom:1px solid var(--line)}</style><p class="banner warn">Dashboard memerlukan JavaScript. Navigasi dan logout tetap bisa dipakai.</p></noscript>
  <script type="module" src="/assets/app.js?v=${version}"></script>
</body>
</html>`;
}

export function renderLogin(options: {
  error?: string;
  username?: string;
  changed?: boolean;
  retryAfterSeconds?: number;
  status?: number;
}): string {
  const message =
    options.error === undefined
      ? ""
      : `<p class="banner error" role="alert">${esc(options.error)}${
          options.retryAfterSeconds === undefined
            ? ""
            : ` Coba lagi dalam ${esc(options.retryAfterSeconds)} detik.`
        }</p>`;
  const changed =
    options.changed === true
      ? '<p class="banner ok" role="status">Password berhasil diubah. Silakan login dengan password baru.</p>'
      : "";
  return `<!doctype html>
<html lang="id">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <title>Login - Absenly</title>
  <link rel="stylesheet" href="/assets/app.css">
</head>
<body class="login-page">
  <main class="login-card">
    <div class="brand"><span class="brand-mark">RA</span><span>Absenly</span></div>
    <h1>Masuk admin</h1>
    ${changed}
    ${message}
    <form method="post" action="/login" class="stack">
      <label>Username
        <input name="username" value="${escAttr(options.username ?? "")}" autocomplete="username" required autofocus>
      </label>
      <label>Password
        <input name="password" type="password" autocomplete="current-password" required>
      </label>
      <button type="submit" class="button primary">Masuk</button>
    </form>
    <p class="muted small">Password awal berasal dari <code>ABSEN_WEB_PASSWORD</code>. Setelah diganti dari Settings, password itu tidak berlaku lagi untuk login web.</p>
  </main>
</body>
</html>`;
}

export function renderError(status: number, message: string): string {
  return `<!doctype html>
<html lang="id">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(status)} - Absenly</title>
  <link rel="stylesheet" href="/assets/app.css">
</head>
<body class="login-page">
  <main class="login-card">
    <h1>${esc(status)}</h1>
    <p>${esc(message)}</p>
    <p><a href="/">Kembali ke Beranda</a></p>
  </main>
</body>
</html>`;
}
