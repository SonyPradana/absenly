// Server-rendered employee dashboard (`/me`). Employee-only, scoped by the session.
// It reuses the share-page CSS classes so the public link and /me look the same.
import type { DailyRow } from "../recap.ts";
import type { ShareMonthMetrics } from "../share-report.ts";
import { esc } from "./html.ts";

export interface MePageData {
  idNumber: string;
  name: string;
  month: string;
  through: string;
  generatedAt: number;
  lastSync: { at: number; ok: boolean } | null;
  rows: DailyRow[];
  current: ShareMonthMetrics;
  previous: ShareMonthMetrics | null;
  compareNote: string;
  today: { holiday: boolean; inTime: string | null; outTime: string | null } | null;
  months: string[];
  changed?: boolean;
}

const MONTHS = [
  "Januari",
  "Februari",
  "Maret",
  "April",
  "Mei",
  "Juni",
  "Juli",
  "Agustus",
  "September",
  "Oktober",
  "November",
  "Desember",
];
const MONTHS_SHORT = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "Mei",
  "Jun",
  "Jul",
  "Agu",
  "Sep",
  "Okt",
  "Nov",
  "Des",
];
const WEEKDAYS_SHORT = ["Min", "Sen", "Sel", "Rab", "Kam", "Jum", "Sab"];

function monthLabel(month: string): string {
  const [year, value] = month.split("-");
  return `${MONTHS[Number(value) - 1] ?? month} ${year ?? ""}`.trim();
}

function dateParts(date: string): { year: number; month: number; day: number } {
  const [year, month, day] = date.split("-").map(Number);
  return { year: year ?? 0, month: month ?? 1, day: day ?? 1 };
}

function dateShort(date: string): string {
  const { month, day } = dateParts(date);
  return `${day} ${MONTHS_SHORT[month - 1] ?? month}`;
}

function dateLabel(date: string): string {
  const { year, month, day } = dateParts(date);
  const weekday = WEEKDAYS_SHORT[new Date(Date.UTC(year, month - 1, day)).getUTCDay()] ?? "";
  return `${weekday}, ${String(day).padStart(2, "0")}/${String(month).padStart(2, "0")}`;
}

function percent(value: number | null): string {
  return value === null ? "—" : `${Math.round(value * 100)}%`;
}

function minutes(value: number): string {
  if (value < 60) return `${value} mnt`;
  const hours = Math.floor(value / 60);
  const rest = value % 60;
  return rest === 0 ? `${hours} jam` : `${hours} jam ${rest} mnt`;
}

function delta(value: number | null, unit: string, positiveIsGood = false): string {
  if (value === null) return "";
  const rounded = Math.round(value * 10) / 10;
  const sign = rounded > 0 ? "+" : "";
  const tone = rounded === 0 ? "" : rounded > 0 === positiveIsGood ? "good" : "bad";
  return `<span class="share-delta ${tone}">${sign}${rounded} ${esc(unit)}</span>`;
}

function statusLabel(status: DailyRow["status"]): string {
  return {
    lengkap: "Lengkap",
    telat: "Telat",
    pulang_cepat: "Pulang cepat",
    tanpa_masuk: "Tanpa masuk",
    belum_pulang: "Belum pulang",
    piket: "Piket",
    libur: "Libur",
  }[status];
}

function statusClass(status: DailyRow["status"]): string {
  if (status === "lengkap" || status === "piket") return "ok";
  if (status === "telat" || status === "pulang_cepat") return "warn";
  if (status === "tanpa_masuk" || status === "belum_pulang") return "danger";
  return "";
}

function card(label: string, value: string, note: string, topRight = ""): string {
  return `<article class="share-stat">
    <div class="share-stat-head"><span>${esc(label)}</span>${topRight}</div>
    <strong class="share-stat-value">${esc(value)}</strong>
    <span class="share-stat-note">${esc(note)}</span>
  </article>`;
}

function dateTimeLabel(ms: number): string {
  return new Intl.DateTimeFormat("id-ID", {
    timeZone: "Asia/Jakarta",
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(ms));
}

function todayValue(today: MePageData["today"]): { value: string; note: string } {
  if (today === null) return { value: "—", note: "Bulan lampau" };
  if (today.holiday) return { value: "Libur", note: "Tidak ada jadwal" };
  const note =
    today.inTime === null && today.outTime === null
      ? "Belum absen"
      : today.inTime === null
        ? "Tanpa masuk"
        : today.outTime === null
          ? "Belum pulang"
          : "Masuk → pulang";
  return { value: `${today.inTime ?? "—"} → ${today.outTime ?? "—"}`, note };
}

export function renderMePage(data: MePageData): string {
  const current = data.current;
  const previous = data.previous;
  const punctualityDelta =
    current.onTimeRate === null || previous === null || previous.onTimeRate === null
      ? null
      : (current.onTimeRate - previous.onTimeRate) * 100;
  const minutesDelta = previous === null ? null : current.lateMinutes - previous.lateMinutes;
  const streak = current.longestLateStreak;
  const today = todayValue(data.today);
  const syncLabel =
    data.lastSync === null
      ? "belum ada"
      : `${dateTimeLabel(data.lastSync.at)} WIB${data.lastSync.ok ? "" : " (gagal)"}`;
  const options = data.months
    .map(
      (month) =>
        `<option value="${esc(month)}"${month === data.month ? " selected" : ""}>${esc(monthLabel(month))}</option>`,
    )
    .join("");
  const tableRows = data.rows
    .map((row) => {
      const late = (row.lateMinutes ?? 0) > 0 ? minutes(row.lateMinutes!) : "—";
      const early = (row.earlyMinutes ?? 0) > 0 ? minutes(row.earlyMinutes!) : "—";
      return `<tr>
        <td>${esc(dateLabel(row.date))}</td>
        <td class="mono">${esc(row.inTime ?? "—")}</td>
        <td class="mono">${esc(row.outTime ?? "—")}</td>
        <td>${esc(late)}</td>
        <td>${esc(early)}</td>
        <td><span class="badge ${statusClass(row.status)}">${esc(statusLabel(row.status))}</span></td>
      </tr>`;
    })
    .join("");

  return `<!doctype html>
<html lang="id">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <meta name="robots" content="noindex, nofollow">
  <title>Rekap ${esc(data.name)} - ${esc(monthLabel(data.month))}</title>
  <link rel="stylesheet" href="/assets/app.css">
  <script type="module" src="/assets/me-menu.js"></script>
</head>
<body class="share-page">
  <header class="topbar share-topbar">
    <div class="brand"><span class="brand-mark">RA</span><span>Absenly</span></div>
    <button type="button" class="button ghost topbar-burger" id="topbar-burger" aria-expanded="false" aria-controls="topbar-menu" aria-label="Menu akun">☰</button>
    <div class="topbar-menu" id="topbar-menu">
      <a class="button ghost" href="/me/password">Ganti password</a>
      <form method="post" action="/logout" class="logout-form">
        <button type="submit" class="button ghost">Keluar</button>
      </form>
    </div>
  </header>
  <main class="share-main">
    ${data.changed === true ? '<p class="banner ok">Password diganti. Sesi login di perangkat lain sudah keluar.</p>' : ""}
    <section class="share-head">
      <div>
        <p class="small muted">Rekap absensi ${esc(monthLabel(data.month))}</p>
        <h1>${esc(data.name)}</h1>
        <p class="muted">ID ${esc(data.idNumber)} · data sampai ${esc(dateShort(data.through))} ${esc(data.through.slice(0, 4))}</p>
      </div>
      <form method="get" action="/me" class="stack small">
        <label>Bulan
          <select name="month">${options}</select>
        </label>
        <button type="submit" class="button">Tampilkan</button>
      </form>
    </section>
    <section class="share-stats" aria-label="Ringkasan rekap">
      ${card("Total absen", `${current.presentDays} hari`, `${current.workdays} hari kerja`)}
      ${card(
        "Persentase ketepatan",
        percent(current.onTimeRate),
        "hari tepat waktu / hari hadir",
        delta(punctualityDelta, "pp", true),
      )}
      ${card("Telat vs tidak telat", `${current.lateDays} / ${current.onTimeDays}`, "hari telat / tepat waktu")}
      ${card("Total menit telat", minutes(current.lateMinutes), data.compareNote, delta(minutesDelta, "mnt"))}
      ${card(
        "Streak telat",
        `${streak?.days ?? 0} hari`,
        streak === null ? "Tidak ada streak" : `${dateShort(streak.from)}–${dateShort(streak.to)}`,
      )}
      ${card("Pulang cepat", `${current.earlyDays} hari`, minutes(current.earlyMinutes))}
      ${card("Absen hari ini", today.value, today.note)}
    </section>
    <section class="card share-daily">
      <h2>Rekap harian</h2>
      <p class="card-sub">IN adalah punch paling awal sebelum 10:00; OUT adalah punch paling akhir setelah 10:00.</p>
      ${
        data.rows.length === 0
          ? '<p class="empty">Belum ada absensi pada bulan ini.</p>'
          : `<div class="table-wrap">
              <table>
                <thead><tr><th>Tanggal</th><th>Masuk</th><th>Pulang</th><th>Telat</th><th>Pulang cepat</th><th>Status</th></tr></thead>
                <tbody>${tableRows}</tbody>
              </table>
            </div>`
      }
    </section>
    <div class="share-foot">
      <p><strong>Sync terakhir: ${esc(syncLabel)}.</strong></p>
      <p class="small muted">Halaman ini hanya menampilkan data absensi Anda sendiri.</p>
    </div>
  </main>
</body>
</html>`;
}

export interface MePasswordPageData {
  idNumber: string;
  name: string;
  error?: string;
  retryAfterSeconds?: number;
}

// Self-service password change. Server-rendered form, no client JS.
export function renderMePasswordPage(data: MePasswordPageData): string {
  const error = data.error === undefined ? "" : `<p class="banner error">${esc(data.error)}</p>`;
  const retry =
    data.retryAfterSeconds === undefined
      ? ""
      : `<p class="small muted">Coba lagi dalam ${esc(String(data.retryAfterSeconds))} detik.</p>`;
  return `<!doctype html>
<html lang="id">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <meta name="robots" content="noindex, nofollow">
  <title>Ganti password - Absenly</title>
  <link rel="stylesheet" href="/assets/app.css">
</head>
<body class="share-page">
  <header class="topbar share-topbar">
    <div class="brand"><span class="brand-mark">RA</span><span>Absenly</span></div>
    <form method="post" action="/logout" class="logout-form">
      <button type="submit" class="button ghost">Keluar</button>
    </form>
  </header>
  <main class="share-main">
    <section class="card">
      <h1>Ganti password</h1>
      <p class="card-sub">${esc(data.name)} · ID ${esc(data.idNumber)}</p>
      ${error}
      ${retry}
      <form method="post" action="/me/password" class="stack">
        <label>Password lama
          <input type="password" name="old_password" autocomplete="current-password" required>
        </label>
        <label>Password baru
          <input type="password" name="new_password" autocomplete="new-password" minlength="8" required>
        </label>
        <label>Ulangi password baru
          <input type="password" name="confirm_password" autocomplete="new-password" minlength="8" required>
        </label>
        <p class="small muted">Minimal 8 karakter. Setelah disimpan, sesi login di perangkat lain keluar.</p>
        <div class="inline">
          <button type="submit" class="button primary">Simpan password</button>
          <a class="button" href="/me">Batal</a>
        </div>
      </form>
    </section>
  </main>
</body>
</html>`;
}

export function renderMeError(status: number, message: string): string {
  return `<!doctype html>
<html lang="id">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex, nofollow">
  <title>Absenly</title>
  <link rel="stylesheet" href="/assets/app.css">
</head>
<body class="share-page">
  <main class="share-main">
    <section class="card share-error">
      <h1>${esc(String(status))}</h1>
      <p class="muted">${esc(message)}</p>
      <p><a href="/login">Kembali ke halaman login</a></p>
    </section>
  </main>
</body>
</html>`;
}
