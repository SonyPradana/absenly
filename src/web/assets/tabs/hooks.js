// Hooks: outbound webhook targets plus the recent event log.
// The server only announces changes; a receiver fetches details from /api/v1.

import { deleteJson, getJson, postJson } from "../lib/api.js";
import { busy, h, toast } from "../lib/dom.js";
import { formatDateTime } from "../lib/format.js";

const EVENT_LABELS = [
  ["attendance.changed", "Absensi berubah"],
  ["sync.done", "Sync selesai"],
  ["sync.failed", "Sync gagal"],
];

function statusBadge(row) {
  if (row.last_attempt_at === null) return h("span", { class: "badge" }, "Belum pernah");
  if (row.last_error === null) {
    return h("span", { class: "badge ok" }, `Terakhir ${row.last_status ?? "?"}`);
  }
  return h("span", { class: "badge warn" }, "Gagal");
}

export function render(main, ctx) {
  const host = h("div", null, h("p", { class: "small muted" }, "Memuat webhook…"));
  const eventsHost = h("div", null, h("p", { class: "small muted" }, "Memuat event…"));

  main.append(
    h(
      "div",
      { class: "page-head" },
      h(
        "div",
        null,
        h("h1", null, "Hooks"),
        h(
          "p",
          { class: "muted" },
          "Event tipis dikirim ke penerima; detail diambil sendiri lewat /api/v1.",
        ),
      ),
    ),
    h("section", { class: "card" }, h("h2", null, "Webhook"), host),
    h(
      "section",
      { class: "card" },
      h("h2", null, "Event terakhir"),
      h(
        "p",
        { class: "small muted" },
        "Payload tidak memuat nama atau PIN. Ambil detail dengan GET /api/v1/events?since=<id>.",
      ),
      eventsHost,
    ),
  );

  renderWebhooks(host, ctx);
  renderEvents(eventsHost, ctx);
}

function renderWebhooks(host, ctx) {
  const formError = h("p", { class: "banner error", hidden: "" });
  const urlInput = h("input", {
    type: "url",
    placeholder: "https://bot.example.com/rekap-hook",
    required: "",
  });
  const boxes = EVENT_LABELS.map(([name, label]) => {
    const box = h("input", { type: "checkbox", value: name, checked: name === "sync.done" });
    return { box, node: h("label", { class: "check" }, box, label) };
  });

  async function reload() {
    const body = await getJson("/api/v1/webhooks");
    const hooks = body.data ?? [];
    host.replaceChildren();
    if (hooks.length === 0) {
      host.append(h("p", { class: "empty" }, "Belum ada webhook. Tambahkan di bawah."));
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
                h("th", null, "URL"),
                h("th", null, "Event"),
                h("th", null, "Status"),
                h("th", null, "Aksi"),
              ),
            ),
            h("tbody", null, ...hooks.map((row) => hookRow(row, reload, formError, ctx))),
          ),
        ),
      );
    }
    host.append(h("hr"), h("h3", null, "Tambah webhook"), formError, addForm());
  }

  function hookRow(row, reload, formError, ctx) {
    const toggle = h(
      "button",
      {
        class: "button",
        type: "button",
        onclick: async () => {
          busy(toggle, true, "…");
          try {
            await postJson(`/api/v1/webhooks/${row.id}`, { enabled: !row.enabled });
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

    const test = h(
      "button",
      {
        class: "button",
        type: "button",
        onclick: async () => {
          busy(test, true, "…");
          try {
            const result = await postJson(`/api/v1/webhooks/${row.id}/test`, {});
            toast(
              result.data?.ok === true
                ? `Penerima menjawab ${result.data.status}.`
                : `Gagal: ${result.data?.error ?? "tanpa jawaban"}`,
              result.data?.ok === true ? "ok" : "error",
            );
            await reload();
          } catch (error) {
            formError.textContent = ctx.errorText(error);
            formError.hidden = false;
            busy(test, false);
          }
        },
      },
      "Kirim tes",
    );

    const remove = h(
      "button",
      {
        class: "button danger",
        type: "button",
        onclick: async () => {
          if (!window.confirm(`Hapus webhook ${row.url}?`)) return;
          busy(remove, true, "…");
          try {
            await deleteJson(`/api/v1/webhooks/${row.id}`);
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
      h("td", { class: "mono" }, row.url),
      h("td", null, row.events.map((name) => eventLabel(name)).join(", ")),
      h(
        "td",
        null,
        h(
          "div",
          { class: "stack tight" },
          statusBadge(row),
          h(
            "span",
            { class: "small muted" },
            row.last_attempt_at === null ? "" : formatDateTime(row.last_attempt_at),
          ),
          row.last_error === null
            ? null
            : h("span", { class: "small muted" }, truncate(row.last_error, 80)),
        ),
      ),
      h("td", null, h("div", { class: "inline" }, test, toggle, remove)),
    );
  }

  function addForm() {
    const submit = h("button", { class: "button primary", type: "submit" }, "Tambah webhook");
    return h(
      "form",
      {
        class: "stack",
        onsubmit: async (event) => {
          event.preventDefault();
          formError.hidden = true;
          const events = boxes.filter((entry) => entry.box.checked).map((entry) => entry.box.value);
          if (events.length === 0) {
            formError.textContent = "Pilih minimal satu event.";
            formError.hidden = false;
            return;
          }
          busy(submit, true, "Menyimpan…");
          try {
            const result = await postJson("/api/v1/webhooks", {
              url: urlInput.value,
              events,
              enabled: true,
            });
            const secret = result.data?.secret;
            urlInput.value = "";
            await reload();
            if (secret) {
              toast("Webhook ditambahkan. Secret ditampilkan sekali di bawah.");
              host.append(
                h(
                  "p",
                  { class: "banner warn" },
                  `Secret (simpan sekarang, tidak ditampilkan lagi): ${secret}`,
                ),
              );
            }
          } catch (error) {
            formError.textContent = ctx.errorText(error);
            formError.hidden = false;
            busy(submit, false);
          }
        },
      },
      h("label", null, "URL penerima", urlInput),
      h("div", { class: "inline" }, ...boxes.map((entry) => entry.node)),
      h("div", { class: "inline" }, submit),
      h(
        "p",
        { class: "small muted" },
        "Kirim dengan header X-Rekap-Signature: sha256=<hmac(body, secret)>. Alamat loopback ditolak.",
      ),
    );
  }

  void reload().catch((error) => {
    host.replaceChildren(
      h("p", { class: "banner error" }, `Gagal memuat webhook: ${ctx.errorText(error)}`),
    );
  });
}

function renderEvents(host, ctx) {
  void getJson("/api/v1/events?limit=20")
    .then((body) => {
      const events = body.data ?? [];
      host.replaceChildren();
      if (events.length === 0) {
        host.append(h("p", { class: "empty" }, "Belum ada event. Jalankan sync untuk mengisi."));
        return;
      }
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
                h("th", null, "ID"),
                h("th", null, "Event"),
                h("th", null, "Waktu"),
                h("th", null, "Status"),
              ),
            ),
            h(
              "tbody",
              null,
              ...events.map((event) =>
                h(
                  "tr",
                  null,
                  h("td", null, String(event.id)),
                  h("td", null, eventLabel(event.event)),
                  h("td", null, formatDateTime(event.at)),
                  h(
                    "td",
                    null,
                    event.delivered_at !== null
                      ? h("span", { class: "badge ok" }, "Terkirim")
                      : h("span", { class: "badge warn" }, event.last_error ?? "Menunggu penerima"),
                  ),
                ),
              ),
            ),
          ),
        ),
      );
    })
    .catch((error) => {
      host.replaceChildren(
        h("p", { class: "banner error" }, `Gagal memuat event: ${ctx.errorText(error)}`),
      );
    });
}

function eventLabel(name) {
  const found = EVENT_LABELS.find(([key]) => key === name);
  return found === undefined ? name : found[1];
}

function truncate(text, max) {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
