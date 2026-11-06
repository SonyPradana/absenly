// About: version, runtime facts, and an on-demand read-only device probe.

import { getJson, postJson } from "../lib/api.js";
import { busy, h } from "../lib/dom.js";
import { formatDateTime } from "../lib/format.js";

function kv(rows) {
  return h(
    "dl",
    { class: "kv" },
    ...rows.flatMap(([key, value]) => [h("dt", null, key), h("dd", null, value)]),
  );
}

export function render(main, ctx) {
  const boot = ctx.bootstrap;
  const readOnly = boot.read_only === true;
  const syncHost = h("p", { class: "small muted" }, "Memuat…");
  const probeHost = h("div", { class: "stack" });
  const probeButton = h(
    "button",
    {
      class: "button primary",
      type: "button",
      onclick: async () => {
        busy(probeButton, true, "Menghubungi device…");
        probeHost.replaceChildren(h("p", { class: "small muted" }, "Membaca count read-only…"));
        try {
          const body = await postJson("/about/probe", {});
          const data = body.data;
          probeHost.replaceChildren(
            h("p", { class: "banner ok" }, "Probe berhasil. Tidak ada data yang diubah."),
            kv([
              ["Host", `${data.host}:${data.port}`],
              ["Users", `${data.users} / ${data.users_cap}`],
              ["Records", `${data.records} / ${data.records_cap}`],
            ]),
          );
        } catch (error) {
          probeHost.replaceChildren(
            h("p", { class: "banner error" }, `Probe gagal: ${ctx.errorText(error)}`),
          );
        } finally {
          busy(probeButton, false);
        }
      },
    },
    "Probe device (read-only)",
  );

  main.append(
    h(
      "div",
      { class: "page-head" },
      h(
        "div",
        null,
        h("h1", null, "About"),
        h("p", { class: "muted" }, "Versi, sumber data, dan status runtime."),
      ),
      h("span", { class: "badge" }, `v${boot.version}`),
    ),
  );

  main.append(
    h(
      "div",
      { class: "grid two-col" },
      h(
        "section",
        { class: "card" },
        h("h2", null, "Aplikasi"),
        kv([
          ["Nama", "absenly"],
          ["Versi", boot.version],
          ["Runtime", `Bun ${typeof Bun !== "undefined" ? Bun.version : ""}`],
          ["DB", h("code", null, boot.storage.db_path)],
          ["Mode", boot.storage.mode],
          ["Hari ini (WIB)", boot.today],
        ]),
        h("hr"),
        h(
          "p",
          { class: "small muted" },
          readOnly
            ? "Viewer read-only: data dibaca langsung dari collector, tanpa DB lokal dan tanpa akses device."
            : "Satu proses: CLI, API, dan web memakai service dan DB yang sama. Device hanya dibaca.",
        ),
      ),
      h(
        "section",
        { class: "card" },
        h("h2", null, "Data"),
        kv([
          ["Karyawan", String(boot.counts.employees)],
          ["Profil", `${boot.counts.profiles} (${boot.counts.active} aktif)`],
          ["Punch", String(boot.counts.attendance)],
          ["Sumber jadwal", boot.schedule.source],
          ["File jadwal", boot.schedule.file_path ?? "—"],
        ]),
        h("hr"),
        h("h3", null, "Sync terakhir"),
        syncHost,
      ),
    ),
  );

  if (readOnly || boot.device === null) {
    main.append(
      h(
        "section",
        { class: "card" },
        h("h2", null, "Viewer"),
        h(
          "p",
          { class: "card-sub" },
          "Mode ini hanya membaca data collector. Sync dan probe device hanya tersedia di collector.",
        ),
      ),
    );
  } else {
    main.append(
      h(
        "section",
        { class: "card" },
        h("h2", null, "Device"),
        h(
          "p",
          { class: "card-sub" },
          `${boot.device.host}:${boot.device.port} · timeout ${boot.device.timeout_ms} ms. Comm key tidak pernah dikirim ke browser.`,
        ),
        h("div", { class: "inline" }, probeButton),
        probeHost,
      ),
    );

    main.append(
      h(
        "p",
        { class: "small muted" },
        "Probe hanya connect, baca count, lalu disconnect. Tidak ada clear data, set time, atau write option.",
      ),
    );
  }

  void ctx
    .cached("sync-status", () => getJson("/api/v1/sync/status"))
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
          `${sync.users} user · ${sync.records} record · ${sync.duration_ms} ms`,
        ),
        sync.error ? h("p", { class: "banner error" }, sync.error) : null,
      );
    })
    .catch((error) => {
      syncHost.textContent = `Gagal membaca status sync: ${ctx.errorText(error)}`;
    });
}
