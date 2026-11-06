// Settings: read-only runtime info, backup, logout-all, and password change.

import { getJson, postJson } from "../lib/api.js";
import { busy, h, toast } from "../lib/dom.js";
import { formatDateTime } from "../lib/format.js";

const DAY_LABELS = [
  ["SUNDAY", "Min"],
  ["MONDAY", "Sen"],
  ["TUESDAY", "Sel"],
  ["WEDNESDAY", "Rab"],
  ["THURSDAY", "Kam"],
  ["FRIDAY", "Jum"],
  ["SATURDAY", "Sab"],
];

function daysLabel(days) {
  if (days === "*") return "Setiap hari";
  const names = days.split(",").map((day) => {
    const found = DAY_LABELS.find(([key]) => key === day);
    return found === undefined ? day : found[1];
  });
  return names.join(", ");
}

function kv(rows) {
  return h(
    "dl",
    { class: "kv" },
    ...rows.flatMap(([key, value]) => [h("dt", null, key), h("dd", null, value)]),
  );
}

export function render(main, ctx) {
  const boot = ctx.bootstrap;
  const syncPromise = ctx.cached("sync-status", () => getJson("/api/v1/sync/status"));
  const syncHost = h("p", { class: "small muted" }, "Memuat status sync…");
  const syncScheduleHost = h("div", null, h("p", { class: "small muted" }, "Memuat jadwal…"));
  const passwordError = h("p", { class: "banner error", hidden: "" });
  const oldInput = h("input", { type: "password", autocomplete: "current-password", required: "" });
  const newInput = h("input", {
    type: "password",
    autocomplete: "new-password",
    minlength: "8",
    required: "",
  });
  const confirmInput = h("input", {
    type: "password",
    autocomplete: "new-password",
    minlength: "8",
    required: "",
  });
  const savePassword = h("button", { class: "button primary", type: "submit" }, "Ganti password");

  const passwordForm = h(
    "form",
    {
      class: "stack",
      onsubmit: async (event) => {
        event.preventDefault();
        passwordError.hidden = true;
        if (newInput.value.length < 8) {
          passwordError.textContent = "Password baru minimal 8 karakter.";
          passwordError.hidden = false;
          return;
        }
        if (newInput.value !== confirmInput.value) {
          passwordError.textContent = "Konfirmasi password tidak sama.";
          passwordError.hidden = false;
          return;
        }
        busy(savePassword, true, "Menyimpan…");
        try {
          await postJson("/settings/password", {
            old_password: oldInput.value,
            new_password: newInput.value,
            confirm_password: confirmInput.value,
          });
          window.location.assign("/login?changed=1");
        } catch (error) {
          passwordError.textContent = ctx.errorText(error);
          passwordError.hidden = false;
          busy(savePassword, false);
        }
      },
    },
    passwordError,
    h(
      "div",
      { class: "grid three-col" },
      h("label", null, "Password lama", oldInput),
      h("label", null, "Password baru (min. 8)", newInput),
      h("label", null, "Ulangi password baru", confirmInput),
    ),
    h(
      "p",
      { class: "small muted" },
      "Argon2id via Bun.password. Semua sesi dicabut setelah password berubah.",
    ),
    h("div", { class: "inline" }, savePassword),
  );

  const logoutAll = h(
    "button",
    {
      class: "button danger",
      type: "button",
      onclick: async () => {
        if (!window.confirm("Cabut semua sesi login? Kamu akan keluar dari perangkat ini juga."))
          return;
        busy(logoutAll, true, "Mencabut…");
        try {
          await postJson("/settings/logout-all", {});
          window.location.assign("/login");
        } catch (error) {
          toast(ctx.errorText(error), "error");
          busy(logoutAll, false);
        }
      },
    },
    "Logout dari semua perangkat",
  );

  main.append(
    h(
      "div",
      { class: "page-head" },
      h(
        "div",
        null,
        h("h1", null, "Settings"),
        h("p", { class: "muted" }, "Info runtime, backup, dan keamanan akun admin."),
      ),
    ),
  );

  main.append(
    h(
      "div",
      { class: "grid two-col" },
      h(
        "section",
        { class: "card" },
        h("h2", null, "Akses & sesi"),
        kv([
          ["Username admin", boot.web.username],
          ["Alamat", `${boot.web.hostname}:${boot.web.port}`],
          ["Masa sesi", `${boot.session_ttl_hours} jam`],
          ["Sumber password", boot.password_source === "db" ? "Database" : "Env (bootstrap)"],
        ]),
        h("hr"),
        h(
          "p",
          { class: "small muted" },
          boot.password_source === "db"
            ? "Password env tidak lagi berlaku untuk login. Reset lewat CLI lokal bila perlu."
            : "Masih memakai password bootstrap dari env. Ganti dari form di bawah agar hash tersimpan di DB.",
        ),
        logoutAll,
      ),
      h(
        "section",
        { class: "card" },
        h("h2", null, "Penyimpanan"),
        kv([
          ["DB", h("code", null, boot.storage.db_path)],
          ["Mode", boot.storage.mode],
          ["Karyawan", String(boot.counts.employees)],
          ["Profil", `${boot.counts.profiles} (${boot.counts.active} aktif)`],
          ["Punch tersimpan", String(boot.counts.attendance)],
        ]),
        h("hr"),
        h("h3", null, "Backup"),
        h(
          "p",
          { class: "small muted" },
          "Snapshot SQLite konsisten memakai VACUUM INTO. File berisi hash password admin; simpan di tempat aman.",
        ),
        h(
          "p",
          null,
          h("a", { class: "button", href: "/settings/backup" }, "Download backup .sqlite"),
        ),
      ),
    ),
  );

  main.append(
    h(
      "section",
      { class: "card" },
      h("h2", null, "Sync otomatis"),
      h(
        "p",
        { class: "card-sub" },
        "Jadwal disimpan di database. Setiap jadwal = hari + rentang jam + interval. Sync hanya jalan selama app serve hidup.",
      ),
      h(
        "p",
        { class: "small muted" },
        boot.auto_sync.next_at === null
          ? "Belum ada jadwal aktif."
          : `Jadwal berikutnya: ${formatDateTime(boot.auto_sync.next_at)}`,
      ),
      syncScheduleHost,
    ),
  );

  main.append(
    h(
      "div",
      { class: "grid two-col" },
      h(
        "section",
        { class: "card" },
        h("h2", null, "Device & jadwal"),
        kv([
          ["Device", `${boot.device.host}:${boot.device.port}`],
          ["Timeout", `${boot.device.timeout_ms} ms`],
          ["Sumber jadwal", boot.schedule.source === "file" ? "schedule.json" : "env fallback"],
          ["File jadwal", boot.schedule.file_path ?? "—"],
          ["Error jadwal", boot.schedule.error ?? "tidak ada"],
        ]),
        h("hr"),
        h(
          "p",
          { class: "small muted" },
          "Jadwal sync otomatis ada di kartu Sync otomatis di atas. Sync manual tetap tersedia di Beranda.",
        ),
      ),
      h(
        "section",
        { class: "card" },
        h("h2", null, "Relay kolektor"),
        h(
          "p",
          { class: "card-sub" },
          "Relay adalah listener GET-only untuk PC viewer. Dikonfigurasi lewat .env, bukan dari halaman ini.",
        ),
        kv([
          ["Aktif", "ABSEN_RELAY_ENABLED=true"],
          ["Alamat", "ABSEN_RELAY_HOST (alamat ZeroTier, bukan 0.0.0.0)"],
          ["Port", "ABSEN_RELAY_PORT (default 3100)"],
          ["Token", "ABSEN_RELAY_TOKEN (dipakai viewer)"],
          ["Dilarang", "ABSEN_RELAY_URL di kolektor (CONFIG_RELAY_CHAIN)"],
        ]),
        h("hr"),
        h("h3", null, "Status sync terakhir"),
        syncHost,
      ),
    ),
  );

  main.append(
    h(
      "section",
      { class: "card" },
      h("h2", null, "Ganti password admin"),
      h("p", { class: "card-sub" }, "Butuh password lama. Minimal 8 karakter, isi dua kali."),
      passwordForm,
    ),
  );

  void syncPromise
    .then((body) => {
      const sync = body.data?.last_sync;
      if (!sync) {
        syncHost.textContent = "Belum ada sync.";
        return;
      }
      syncHost.replaceChildren(
        h("p", null, `${sync.ok ? "Sukses" : "Gagal"} · ${formatDateTime(sync.finished_at)}`),
        h(
          "p",
          { class: "small muted" },
          `${sync.users} user, ${sync.records} record, ${sync.duration_ms} ms`,
        ),
        sync.error ? h("p", { class: "banner error" }, sync.error) : null,
      );
    })
    .catch((error) => {
      syncHost.textContent = `Gagal membaca status sync: ${ctx.errorText(error)}`;
    });

  renderSyncSchedules(syncScheduleHost, ctx);
}

// Auto-sync schedules: list + inline add form. Every mutation re-reads the
// list so the table always reflects the collector's DB.
function renderSyncSchedules(host, ctx) {
  const dayInputs = DAY_LABELS.map(([key, label]) => {
    const box = h("input", { type: "checkbox", value: key });
    return { box, node: h("label", { class: "check" }, box, label) };
  });
  const startInput = h("input", { type: "time", value: "07:00", required: "" });
  const endInput = h("input", { type: "time", value: "08:00", required: "" });
  const everyInput = h("input", {
    type: "number",
    min: "1",
    max: "1440",
    value: "5",
    required: "",
  });
  const formError = h("p", { class: "banner error", hidden: "" });

  async function reload() {
    const body = await getJson("/api/v1/sync-schedules");
    const schedules = body.data ?? [];
    host.replaceChildren();
    if (schedules.length === 0) {
      host.append(h("p", { class: "empty" }, "Belum ada jadwal. Tambahkan di bawah."));
    } else {
      host.append(
        h(
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
                h("th", null, "Hari"),
                h("th", null, "Jam"),
                h("th", null, "Interval"),
                h("th", null, "Status"),
                h("th", null, "Aksi"),
              ),
            ),
            h("tbody", null, ...schedules.map((row) => scheduleRow(row, ctx, reload, formError))),
          ),
        ),
      );
    }
    if (body.meta?.next_at) {
      host.append(
        h("p", { class: "small muted" }, `Berikutnya: ${formatDateTime(body.meta.next_at)}`),
      );
    }
    host.append(h("hr"), h("h3", null, "Tambah jadwal"), formError, scheduleForm());
  }

  function scheduleRow(row, ctx, reload, formError) {
    const toggle = h(
      "button",
      {
        class: "button",
        type: "button",
        onclick: async () => {
          busy(toggle, true, "…");
          try {
            await postJson("/settings/sync-schedules/update", {
              id: row.id,
              enabled: !row.enabled,
            });
            await reload();
          } catch (error) {
            formError.textContent = ctx.errorText(error);
            formError.hidden = false;
            busy(toggle, false);
          }
        },
      },
      row.enabled ? "Nonaktifkan" : "Aktifkan",
    );

    const remove = h(
      "button",
      {
        class: "button danger",
        type: "button",
        onclick: async () => {
          if (
            !window.confirm(
              `Hapus jadwal ${daysLabel(row.days)} ${row.start_time}-${row.end_time}?`,
            )
          )
            return;
          busy(remove, true, "…");
          try {
            await postJson("/settings/sync-schedules/delete", { id: row.id });
            await reload();
          } catch (error) {
            formError.textContent = ctx.errorText(error);
            formError.hidden = false;
            busy(remove, false);
          }
        },
      },
      "Hapus",
    );

    return h(
      "tr",
      null,
      h("td", null, daysLabel(row.days)),
      h("td", null, `${row.start_time}–${row.end_time}`),
      h("td", null, `${row.every_minutes} menit`),
      h(
        "td",
        null,
        h(
          "span",
          { class: row.enabled ? "badge ok" : "badge warn" },
          row.enabled ? "Aktif" : "Mati",
        ),
      ),
      h("td", null, h("div", { class: "inline" }, toggle, remove)),
    );
  }

  function scheduleForm() {
    const selected = () => dayInputs.filter((entry) => entry.box.checked);
    const submit = h("button", { class: "button primary", type: "submit" }, "Tambah jadwal");
    return h(
      "form",
      {
        class: "stack",
        onsubmit: async (event) => {
          event.preventDefault();
          formError.hidden = true;
          const days =
            selected().length === 0
              ? "*"
              : selected()
                  .map((entry) => entry.box.value)
                  .join(",");
          busy(submit, true, "Menyimpan…");
          try {
            await postJson("/settings/sync-schedules", {
              days,
              start_time: startInput.value,
              end_time: endInput.value,
              every_minutes: Number(everyInput.value),
              enabled: true,
            });
            await reload();
            busy(submit, false);
          } catch (error) {
            formError.textContent = ctx.errorText(error);
            formError.hidden = false;
            busy(submit, false);
          }
        },
      },
      h("div", { class: "inline" }, ...dayInputs.map((entry) => entry.node)),
      h(
        "p",
        { class: "small muted" },
        "Tidak ada hari tercentang = setiap hari. Jam Indonesia (WIB).",
      ),
      h(
        "div",
        { class: "grid three-col" },
        h("label", null, "Mulai", startInput),
        h("label", null, "Selesai", endInput),
        h("label", null, "Tiap (menit)", everyInput),
      ),
      h("div", { class: "inline" }, submit),
    );
  }

  void reload().catch((error) => {
    host.replaceChildren(
      h("p", { class: "banner error" }, `Gagal memuat jadwal: ${ctx.errorText(error)}`),
    );
  });
}
