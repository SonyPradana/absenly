// Home: today cards, monthly health, rankings, and the latest raw punches.

import { getAllPages, getJson, postJson } from "../lib/api.js";
import { busy, h, toast } from "../lib/dom.js";
import {
  addDays,
  formatDate,
  formatDateShort,
  formatMinutes,
  formatPercent,
  formatSeconds,
  formatTime,
  monthLabel,
  monthRange,
  weekdayForDate,
  weekdayName,
  weekdayShort,
} from "../lib/format.js";
import {
  chartScale,
  lateRanking,
  lateStreakRanking,
  monthMetrics,
  stableRanking,
  todayMetrics,
  withRankMovement,
  workdayCutoff,
} from "../lib/metrics.js";

function stat(label, value, note) {
  return h(
    "div",
    { class: "stat" },
    h("span", { class: "stat-label" }, label),
    h("span", { class: "stat-value" }, value),
    note ? h("span", { class: "stat-note" }, note) : null,
  );
}

function card(title, subtitle, ...children) {
  return h(
    "section",
    { class: "card" },
    h("h2", null, title),
    subtitle ? h("p", { class: "card-sub" }, subtitle) : null,
    ...children,
  );
}

function previousMonthValue(month) {
  const [year, value] = month.split("-").map(Number);
  const date = new Date(Date.UTC(year, value - 2, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

function loadMonth(month) {
  const range = monthRange(month);
  return getAllPages("/api/v1/recap", {
    from: range.from,
    to: range.to,
    per_page: 200,
  });
}

async function loadLastLogs(day) {
  const months = [day.slice(0, 7), addDays(`${day.slice(0, 7)}-01`, -1).slice(0, 7)];
  for (const month of months) {
    const first = await getJson(`/api/v1/attendance?month=${month}&page=1&per_page=100`);
    const total = first.meta?.total ?? 0;
    const pages = first.meta?.total_pages ?? 0;
    if (total === 0 || pages === 0) continue;
    const last = await getJson(`/api/v1/attendance?month=${month}&page=${pages}&per_page=100`);
    return (last.data ?? []).slice(-10).reverse();
  }
  return [];
}

function rankingList(items, renderMeta, emptyText, renderMove = null) {
  if (items.length === 0) return h("p", { class: "empty" }, emptyText);
  return h(
    "ol",
    { class: "rank-list" },
    ...items.map((item, index) =>
      h(
        "li",
        { class: "rank-item" },
        h(
          "span",
          null,
          h("span", { class: "rank-name" }, `${index + 1}. ${item.name}`),
          h("span", { class: "rank-meta" }, ` · ${item.id}`),
        ),
        h(
          "span",
          { class: "rank-side" },
          h("span", { class: "rank-meta" }, renderMeta(item)),
          renderMove ? renderMove(item) : null,
        ),
      ),
    ),
  );
}

function movementBadge(value) {
  if (value === null || value === undefined) {
    return h("span", { class: "rank-move new", title: "Belum ada posisi bulan lalu" }, "baru");
  }
  if (value === 0) {
    return h("span", { class: "rank-move flat", title: "Posisi sama dengan bulan lalu" }, "–");
  }
  const up = value > 0;
  const label = `${up ? "Naik" : "Turun"} ${Math.abs(value)} peringkat dari bulan lalu`;
  return h(
    "span",
    {
      class: `rank-move ${up ? "up" : "down"}`,
      title: label,
      "aria-label": label,
    },
    `${up ? "↑" : "↓"}${Math.abs(value)}`,
  );
}

function chart(days) {
  const scale = chartScale(days);
  const note =
    scale.mode === "log"
      ? h(
          "p",
          { class: "chart-note" },
          "Skala logaritmik: selisih kecil di angka besar tetap terlihat.",
        )
      : null;
  return h(
    "div",
    null,
    h(
      "div",
      { class: "chart", role: "img", "aria-label": "Total menit telat per hari kerja" },
      ...days.map((minutes, index) => {
        const height = scale.heightOf(minutes);
        return h(
          "div",
          {
            class: `bar-col${minutes === 0 ? " empty" : ""}`,
            title: `${weekdayName(index)}: ${formatMinutes(minutes)}`,
          },
          h("span", { class: "bar-value" }, String(minutes)),
          h("div", {
            class: "bar",
            style: { height: `${Math.max(3, height * 100)}%` },
          }),
          h("span", { class: "bar-label" }, weekdayShort(index)),
        );
      }),
    ),
    note,
  );
}

export async function render(main, ctx) {
  const boot = ctx.bootstrap;
  const readOnly = boot.read_only === true;
  const month = boot.today.slice(0, 7);
  const previousMonth = previousMonthValue(month);
  const [employeesBody, recapRows, previousRows, syncBody, lastLogs] = await Promise.all([
    ctx.cached("employees", () => getJson("/api/v1/employees")),
    ctx.cached(`recap:${month}`, () => loadMonth(month)),
    ctx.cached(`recap:${previousMonth}`, () => loadMonth(previousMonth)),
    ctx.cached("sync-status", () => getJson("/api/v1/sync/status")),
    ctx.cached("last-logs", () => loadLastLogs(boot.today)),
  ]);

  const employees = employeesBody.data ?? [];
  const sync = syncBody.data?.last_sync ?? null;
  const monthMap = boot.schedule.month;
  const todaySchedule = monthMap[boot.today];
  const today = todayMetrics(recapRows, employees, boot.today, todaySchedule !== null);
  const metrics = monthMetrics(recapRows, employees, monthMap, month, boot.today);
  const stable = stableRanking(recapRows, employees, month);
  const previousCutoff =
    workdayCutoff(boot.schedule.calendar, previousMonth, metrics.workdaysElapsed) ??
    monthRange(previousMonth).to;
  const previousLate = lateRanking(
    previousRows.filter((row) => row.date <= previousCutoff),
    employees,
    previousMonth,
    null,
  );
  const late = withRankMovement(lateRanking(recapRows, employees, month), previousLate);
  const streaks = lateStreakRanking(recapRows, employees, monthMap, month, boot.today);

  const syncButton = h(
    "button",
    {
      class: "button primary",
      type: "button",
      onclick: async () => {
        if (!window.confirm("Jalankan sync dari device sekarang?")) return;
        busy(syncButton, true, "Sync…");
        try {
          await postJson("/api/v1/sync", {});
          ctx.invalidate();
          toast("Sync selesai.");
          ctx.refresh();
        } catch (error) {
          toast(ctx.errorText(error), "error");
          busy(syncButton, false);
        }
      },
    },
    "Sync sekarang",
  );

  const refreshButton = h(
    "button",
    {
      class: "button",
      type: "button",
      onclick: () => {
        ctx.invalidate();
        ctx.refresh();
      },
    },
    "Muat ulang",
  );

  main.append(
    h(
      "div",
      { class: "page-head" },
      h(
        "div",
        null,
        h("h1", null, "Beranda"),
        h(
          "p",
          { class: "muted" },
          `${weekdayName(weekdayForDate(boot.today))}, ${formatDate(boot.today)} · ${monthLabel(month)}`,
        ),
      ),
      h(
        "div",
        { class: "inline" },
        readOnly ? h("span", { class: "badge" }, "viewer") : null,
        refreshButton,
        readOnly ? null : syncButton,
      ),
    ),
  );

  if (sync === null) {
    main.append(
      h(
        "p",
        { class: "banner warn" },
        readOnly
          ? "Collector belum pernah sync. Data viewer masih kosong."
          : "Belum ada sync. Data di bawah mungkin kosong. Jalankan sync saat perangkat terjangkau.",
      ),
    );
  } else {
    const lastDate = String(sync.finished_at ?? "").slice(0, 10);
    if (!sync.ok || lastDate !== boot.today) {
      main.append(
        h(
          "p",
          { class: "banner warn" },
          !sync.ok
            ? `Sync terakhir gagal: ${sync.error ?? "tanpa pesan"}. Menampilkan data terakhir yang tersimpan.`
            : `Sync terakhir ${formatDate(lastDate)}. Data hari ini belum tentu lengkap.`,
        ),
      );
    }
  }

  if (boot.schedule.source === "env") {
    main.append(
      h(
        "p",
        { class: "banner" },
        "Jadwal memakai fallback env. Tambahkan schedule.json agar hari libur dan override berlaku.",
      ),
    );
  }
  if (boot.schedule.error) {
    main.append(
      h(
        "p",
        { class: "banner error" },
        `Schedule file bermasalah: ${boot.schedule.error}. Server masih memakai jadwal valid terakhir.`,
      ),
    );
  }

  const todayTitle = todaySchedule === null ? "Hari ini libur" : "Hari ini";
  const todayNote =
    todaySchedule === null
      ? "Tidak ada jadwal kerja menurut calendar."
      : `Jadwal ${todaySchedule.in}–${todaySchedule.out}`;

  const dashboard = h("div", { class: "dashboard" });

  dashboard.append(
    h(
      "section",
      { class: "card" },
      h("h2", null, todayTitle),
      h("p", { class: "card-sub" }, todayNote),
      h(
        "div",
        { class: "grid stats" },
        stat("Karyawan aktif", String(today.active), "profil active=1"),
        stat(
          "Hadir",
          todaySchedule === null ? "—" : String(today.hadir),
          today.active === 0
            ? "belum ada karyawan aktif"
            : `${formatPercent(today.active === 0 ? 0 : today.hadir / today.active)} dari aktif`,
        ),
        stat("Belum pulang", String(today.belumPulang), `${today.sudahPulang} sudah pulang`),
        stat("Belum absen", String(today.belumAbsen), `${today.late} telat hari ini`),
        stat(
          "Tepat waktu",
          formatPercent(today.punctualityPresent),
          `dari yang hadir · ${formatPercent(today.punctualityActive)} dari aktif`,
        ),
      ),
    ),
  );

  dashboard.append(
    h(
      "div",
      { class: "grid two-col" },
      card(
        "Kesehatan bulan ini",
        `${monthLabel(month)} · ${metrics.workdaysElapsed} dari ${metrics.workdaysTotal} hari kerja berjalan`,
        h(
          "div",
          { class: "grid stats" },
          stat("Rata-rata telat", formatMinutes(metrics.avgLatePerLateDay), "per kejadian telat"),
          stat(
            "Karyawan pernah telat",
            String(metrics.uniqueLate),
            `${formatPercent(metrics.active === 0 ? null : metrics.uniqueLate / metrics.active)} dari ${metrics.active} aktif`,
          ),
          stat("Kejadian telat", String(metrics.lateEmployeeDays), `${metrics.lateMinutes} menit`),
          stat(
            "Kehadiran",
            formatPercent(metrics.attendanceRate),
            `${metrics.presentEmployeeDays} dari ${metrics.expectedEmployeeDays} hari-orang`,
          ),
        ),
        h(
          "p",
          { class: "small muted" },
          metrics.worstDay === null
            ? "Belum ada keterlambatan bulan ini."
            : `Hari terburuk: ${weekdayName(weekdayForDate(metrics.worstDay.date))}, ${formatDate(metrics.worstDay.date)} · ${formatMinutes(metrics.worstDay.minutes)} dari ${metrics.worstDay.lateDays} karyawan.`,
        ),
      ),
      card(
        "Progres bulan",
        "Dihitung dari calendar, bukan asumsi Senin–Sabtu.",
        h(
          "div",
          null,
          h(
            "p",
            { class: "small muted" },
            `Hari kerja: ${metrics.workdaysElapsed}/${metrics.workdaysTotal} · sisa ${metrics.workdaysRemaining}`,
          ),
          h(
            "div",
            {
              class: "progress",
              role: "progressbar",
              "aria-valuemin": "0",
              "aria-valuemax": "100",
              "aria-valuenow":
                metrics.workdaysTotal === 0
                  ? "0"
                  : String(Math.round((metrics.workdaysElapsed / metrics.workdaysTotal) * 100)),
            },
            h("span", {
              style: {
                width: `${metrics.workdaysTotal === 0 ? 0 : (metrics.workdaysElapsed / metrics.workdaysTotal) * 100}%`,
              },
            }),
          ),
          h(
            "p",
            { class: "small muted" },
            `Kalender: ${metrics.daysElapsed}/${metrics.daysTotal} hari · ${metrics.uniquePresent} karyawan pernah hadir`,
          ),
          h(
            "p",
            { class: "small muted" },
            `Jam WIB: ${new Intl.DateTimeFormat("id-ID", { timeZone: "Asia/Jakarta", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date())}`,
          ),
        ),
      ),
    ),
  );

  dashboard.append(
    h(
      "div",
      { class: "grid two-col" },
      card(
        "Menit telat per hari",
        "Total menit telat bulan ini, dikelompokkan per hari.",
        metrics.lateMinutes === 0
          ? h("p", { class: "empty" }, "Belum ada telat bulan ini.")
          : chart(metrics.byWeekday),
      ),
      card(
        "Paling stabil",
        "0 telat, 0 pulang cepat, minimal 1 hari hadir.",
        rankingList(
          stable,
          (item) => `${item.days} hari · rata-rata masuk ${formatSeconds(item.avgInSeconds)}`,
          "Belum ada karyawan dengan hari sempurna.",
        ),
      ),
    ),
  );

  dashboard.append(
    h(
      "div",
      { class: "grid two-col" },
      card(
        "Paling sering telat",
        "Jumlah hari telat, lalu total menit. ↑↓ = peringkat vs bulan lalu.",
        rankingList(
          late,
          (item) => `${item.lateDays} hari · ${formatMinutes(item.minutes)}`,
          "Belum ada keterlambatan bulan ini.",
          (item) => movementBadge(item.movement),
        ),
      ),
      card(
        "Telat berturut-turut",
        "Streak terpanjang bulan ini. Libur calendar dilewati; tidak masuk memutus streak.",
        rankingList(
          streaks,
          (item) =>
            `${item.days} hari · ${
              item.from === item.to
                ? formatDateShort(item.from)
                : `${formatDateShort(item.from)}–${formatDateShort(item.to)}`
            }`,
          "Belum ada streak telat bulan ini.",
        ),
      ),
    ),
  );

  const logCard = card(
    "Log terakhir",
    `${lastLogs.length} punch mentah terbaru`,
    lastLogs.length === 0
      ? h("p", { class: "empty" }, "Belum ada data absensi.")
      : h(
          "div",
          { class: "table-wrap" },
          h(
            "table",
            null,
            h(
              "thead",
              null,
              h(
                "tr",
                null,
                h("th", null, "Waktu"),
                h("th", null, "ID"),
                h("th", null, "Nama"),
                h("th", null, "Punch"),
                h("th", null, "Verify"),
                h("th", null, "Status"),
              ),
            ),
            h(
              "tbody",
              null,
              ...lastLogs.map((row) =>
                h(
                  "tr",
                  null,
                  h(
                    "td",
                    { class: "mono" },
                    `${formatDateShort(row.date)} ${formatTime(row.time)}`,
                  ),
                  h("td", { class: "mono" }, row.id_number),
                  h("td", null, row.name),
                  h("td", { class: "num" }, row.raw_punch),
                  h("td", { class: "num" }, row.verify),
                  h(
                    "td",
                    null,
                    h("span", { class: `badge ${row.status === "IN" ? "ok" : ""}` }, row.status),
                  ),
                ),
              ),
            ),
          ),
        ),
    h(
      "p",
      { class: "small" },
      h("a", { href: "/log", "data-link": "" }, "Lihat semua log absensi →"),
    ),
  );
  logCard.classList.add("card-scroll");
  dashboard.append(logCard);

  dashboard.append(
    h(
      "p",
      { class: "small muted" },
      "IN/OUT dihitung dari waktu: punch paling awal sebelum 10:00 adalah IN, paling akhir >= 10:00 adalah OUT. Kolom punch/verify tetap ditampilkan sebagai data mentah.",
    ),
  );

  main.append(dashboard);
}
