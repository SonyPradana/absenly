// Jadwal: base week + date-range overrides. Saves the whole calendar atomically.

import { postJson } from "../lib/api.js";
import { busy, h } from "../lib/dom.js";
import { formatDate, monthLabel } from "../lib/format.js";
import { expiredOverrides, resolveClient, scheduleImpact } from "../lib/metrics.js";

const DAYS = [
  { key: "MONDAY", label: "Senin" },
  { key: "TUESDAY", label: "Selasa" },
  { key: "WEDNESDAY", label: "Rabu" },
  { key: "THURSDAY", label: "Kamis" },
  { key: "FRIDAY", label: "Jumat" },
  { key: "SATURDAY", label: "Sabtu" },
  { key: "SUNDAY", label: "Minggu" },
];

const DEFAULT_SHIFT = { in: "08:00", out: "16:00" };
const TIME_RE = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeWeekly(weekly) {
  const result = {};
  for (const day of DAYS) {
    const value = weekly?.[day.key] ?? null;
    result[day.key] = value === null ? null : { in: value.in, out: value.out };
  }
  return result;
}

function normalizeCalendar(calendar) {
  return {
    version: 1,
    base: normalizeWeekly(calendar.base),
    overrides: (calendar.overrides ?? []).map((override) => ({
      id: String(override.id ?? "").trim(),
      from: override.from,
      to: override.to,
      priority: Number(override.priority ?? 0),
      ...(override.note === undefined ||
      override.note === null ||
      String(override.note).trim() === ""
        ? {}
        : { note: String(override.note).trim() }),
      schedule: override.schedule === null ? null : normalizeWeekly(override.schedule),
    })),
  };
}

function validateDay(schedule, label) {
  if (schedule === null) return null;
  if (schedule === undefined || typeof schedule !== "object") {
    return `${label}: jadwal harus {in,out} atau libur.`;
  }
  if (!TIME_RE.test(schedule.in ?? "") || !TIME_RE.test(schedule.out ?? "")) {
    return `${label}: jam harus HH:MM 24 jam.`;
  }
  if (schedule.out <= schedule.in) return `${label}: jam pulang harus setelah jam masuk.`;
  return null;
}

function validateCalendar(calendar) {
  const workdays = DAYS.filter((day) => calendar.base[day.key] !== null);
  if (workdays.length === 0) return "Base week minimal punya satu hari kerja.";
  for (const day of DAYS) {
    const error = validateDay(calendar.base[day.key], `Base ${day.label}`);
    if (error) return error;
  }

  const ids = new Set();
  for (const [index, override] of calendar.overrides.entries()) {
    const label = `Override ${override.id || `#${index + 1}`}`;
    if (override.id.trim() === "") return `${label}: id wajib diisi.`;
    if (ids.has(override.id)) return `${label}: id duplikat.`;
    ids.add(override.id);
    if (!DATE_RE.test(override.from) || !DATE_RE.test(override.to)) {
      return `${label}: tanggal harus YYYY-MM-DD.`;
    }
    if (override.from > override.to) return `${label}: tanggal awal setelah tanggal akhir.`;
    if (!Number.isInteger(override.priority) || override.priority < 0) {
      return `${label}: priority harus bilangan bulat >= 0.`;
    }
    if (override.schedule === null) continue;
    if (DAYS.every((day) => override.schedule[day.key] === null)) {
      return `${label}: pola khusus minimal punya satu hari kerja.`;
    }
    for (const day of DAYS) {
      const error = validateDay(override.schedule[day.key], `${label} ${day.label}`);
      if (error) return error;
    }
  }

  for (let i = 0; i < calendar.overrides.length; i += 1) {
    for (let j = i + 1; j < calendar.overrides.length; j += 1) {
      const a = calendar.overrides[i];
      const b = calendar.overrides[j];
      if (a.priority === b.priority && a.from <= b.to && b.from <= a.to) {
        return `Override ${a.id} dan ${b.id} overlap dengan priority yang sama.`;
      }
    }
  }
  return null;
}

function weekEditor(weekly, readonly) {
  const grid = h("div", { class: "week-grid" });
  grid.append(
    h("div", { class: "header" }, "Hari"),
    h("div", { class: "header" }, "Masuk"),
    h("div", { class: "header" }, "Pulang"),
    h("div", { class: "header" }, "Libur"),
  );

  for (const day of DAYS) {
    const schedule = weekly[day.key];
    const inInput = h("input", {
      type: "time",
      value: schedule?.in ?? DEFAULT_SHIFT.in,
      disabled: readonly || schedule === null,
      "aria-label": `${day.label} masuk`,
    });
    const outInput = h("input", {
      type: "time",
      value: schedule?.out ?? DEFAULT_SHIFT.out,
      disabled: readonly || schedule === null,
      "aria-label": `${day.label} pulang`,
    });
    const off = h("input", {
      type: "checkbox",
      checked: schedule === null,
      disabled: readonly,
      "aria-label": `${day.label} libur`,
    });

    const apply = () => {
      if (off.checked) {
        weekly[day.key] = null;
        inInput.disabled = true;
        outInput.disabled = true;
      } else {
        weekly[day.key] = {
          in: inInput.value || DEFAULT_SHIFT.in,
          out: outInput.value || DEFAULT_SHIFT.out,
        };
        inInput.value = weekly[day.key].in;
        outInput.value = weekly[day.key].out;
        inInput.disabled = readonly;
        outInput.disabled = readonly;
      }
    };
    off.addEventListener("change", apply);
    inInput.addEventListener("change", () => {
      if (!off.checked) weekly[day.key] = { in: inInput.value, out: outInput.value };
    });
    outInput.addEventListener("change", () => {
      if (!off.checked) weekly[day.key] = { in: inInput.value, out: outInput.value };
    });

    grid.append(
      h("div", null, day.label),
      inInput,
      outInput,
      h("label", { class: "inline" }, off, "Libur"),
    );
  }
  return grid;
}

export function render(main, ctx) {
  const boot = ctx.bootstrap;
  const readonly = boot.schedule.source !== "file" || boot.schedule.file_path === null;
  let calendar = normalizeCalendar(clone(boot.schedule.calendar));
  const original = normalizeCalendar(clone(boot.schedule.calendar));
  let editing = null;
  let errorMessage = null;
  let notice = null;

  function renderOverrideForm() {
    if (editing === null) return null;
    const current = editing;
    const fromInput = h("input", { type: "date", value: current.from, required: "" });
    const toInput = h("input", { type: "date", value: current.to, required: "" });
    const priorityInput = h("input", {
      type: "number",
      min: "0",
      step: "1",
      value: String(current.priority),
    });
    const noteInput = h("input", { type: "text", value: current.note ?? "", maxlength: "200" });
    const typeSelect = h(
      "select",
      null,
      h("option", { value: "holiday", selected: current.schedule === null }, "Libur total"),
      h("option", { value: "custom", selected: current.schedule !== null }, "Pola khusus"),
    );
    const customHost = h("div");

    const renderCustom = () => {
      customHost.replaceChildren();
      if (current.schedule === null) {
        customHost.append(
          h("p", { class: "small muted" }, "Seluruh tanggal pada rentang ini libur."),
        );
        return;
      }
      customHost.append(
        h("p", { class: "small muted" }, "Pola mingguan untuk rentang ini:"),
        weekEditor(current.schedule, false),
      );
    };

    typeSelect.addEventListener("change", () => {
      current.schedule = typeSelect.value === "holiday" ? null : clone(calendar.base);
      renderCustom();
    });

    const form = h(
      "section",
      { class: "card" },
      h(
        "div",
        { class: "page-head" },
        h(
          "div",
          null,
          h("h2", null, current.isNew ? "Tambah override" : `Edit ${current.id}`),
          h(
            "p",
            { class: "muted small" },
            "Override dengan priority lebih tinggi menang. Priority sama tidak boleh overlap.",
          ),
        ),
      ),
      h(
        "div",
        { class: "grid three-col" },
        h("label", null, "ID", h("input", { type: "text", value: current.id, disabled: "" })),
        h("label", null, "Dari", fromInput),
        h("label", null, "Sampai", toInput),
        h("label", null, "Priority", priorityInput),
        h("label", null, "Catatan", noteInput),
        h("label", null, "Tipe", typeSelect),
      ),
      customHost,
      h(
        "div",
        { class: "inline" },
        h(
          "button",
          {
            class: "button primary",
            type: "button",
            onclick: () => {
              current.from = fromInput.value;
              current.to = toInput.value;
              current.priority = Number(priorityInput.value);
              current.note = noteInput.value;
              const error = validateCalendar({
                ...calendar,
                overrides: [
                  ...calendar.overrides.filter((item) => item.id !== current.id),
                  current,
                ],
              });
              if (error) {
                errorMessage = error;
                build();
                return;
              }
              calendar.overrides = calendar.overrides.filter((item) => item.id !== current.id);
              calendar.overrides.push(clone(current));
              calendar.overrides.sort((a, b) => a.from.localeCompare(b.from));
              editing = null;
              errorMessage = null;
              notice = "Perubahan lokal diterapkan. Klik Simpan jadwal untuk menulis file.";
              build();
            },
          },
          "Terapkan",
        ),
        h(
          "button",
          {
            class: "button",
            type: "button",
            onclick: () => {
              editing = null;
              errorMessage = null;
              build();
            },
          },
          "Batal",
        ),
      ),
    );

    renderCustom();
    return form;
  }

  function overrideCard(override) {
    return h(
      "div",
      { class: "override" },
      h(
        "div",
        { class: "override-head" },
        h(
          "div",
          null,
          h("strong", null, override.note || override.id),
          h(
            "div",
            { class: "small muted" },
            `${formatDate(override.from)} – ${formatDate(override.to)} · priority ${override.priority} · ${
              override.schedule === null ? "libur total" : "pola khusus"
            }`,
          ),
        ),
        h(
          "div",
          { class: "inline" },
          readonly
            ? null
            : h(
                "button",
                {
                  class: "button",
                  type: "button",
                  onclick: () => {
                    editing = { ...clone(override), isNew: false };
                    errorMessage = null;
                    build();
                  },
                },
                "Edit",
              ),
          readonly
            ? null
            : h(
                "button",
                {
                  class: "button danger",
                  type: "button",
                  onclick: () => {
                    if (!window.confirm(`Hapus override ${override.id}?`)) return;
                    calendar.overrides = calendar.overrides.filter(
                      (item) => item.id !== override.id,
                    );
                    notice =
                      "Override dihapus secara lokal. Klik Simpan jadwal untuk menulis file.";
                    build();
                  },
                },
                "Hapus",
              ),
        ),
      ),
    );
  }

  async function save() {
    errorMessage = validateCalendar(calendar);
    if (errorMessage) {
      build();
      return;
    }
    calendar = normalizeCalendar(calendar);
    const impact = scheduleImpact(original, calendar, boot.today);
    const message =
      `Simpan jadwal ke ${boot.schedule.file_path}?\n\n` +
      `${impact.added} hari menjadi kerja, ${impact.removed} hari menjadi libur, ` +
      `${impact.changed} hari berubah jam.\n` +
      `Dampak dicek ${impact.from} sampai ${impact.to}.`;
    if (!window.confirm(message)) return;

    try {
      await postJson("/schedule", { calendar });
      notice = "Jadwal tersimpan. Server memuat ulang tanpa restart.";
      window.location.reload();
    } catch (error) {
      errorMessage = ctx.errorText(error);
      build();
    }
  }

  function build() {
    main.replaceChildren();
    const saveButton = h(
      "button",
      {
        class: "button primary",
        type: "button",
        disabled: readonly,
        onclick: async () => {
          busy(saveButton, true, "Menyimpan…");
          try {
            await save();
          } finally {
            busy(saveButton, false);
          }
        },
      },
      "Simpan jadwal",
    );

    main.append(
      h(
        "div",
        { class: "page-head" },
        h(
          "div",
          null,
          h("h1", null, "Jadwal"),
          h(
            "p",
            { class: "muted" },
            `${monthLabel(boot.today.slice(0, 7))} · ${
              boot.schedule.source === "file"
                ? "dari file"
                : boot.schedule.source === "relay"
                  ? "dari collector"
                  : "fallback env"
            }`,
          ),
        ),
        h(
          "div",
          { class: "inline" },
          h(
            "button",
            { class: "button", type: "button", onclick: () => window.location.reload() },
            "Muat ulang",
          ),
          readonly ? null : saveButton,
        ),
      ),
    );

    if (readonly) {
      main.append(
        h(
          "p",
          { class: "banner warn" },
          boot.schedule.source === "relay"
            ? "Jadwal dibaca dari collector dan hanya bisa diubah di collector."
            : "Jadwal berasal dari env dan read-only dari web. Buat schedule.json untuk mengedit hari libur, shift, dan override.",
        ),
      );
    } else {
      main.append(
        h(
          "p",
          { class: "small muted" },
          `File: ${boot.schedule.file_path}. Disimpan atomik, lalu dibaca ulang oleh app serve tanpa restart.`,
        ),
      );
    }
    if (notice) main.append(h("p", { class: "banner ok" }, notice));
    if (errorMessage) main.append(h("p", { class: "banner error" }, errorMessage));
    if (boot.schedule.error) {
      main.append(
        h(
          "p",
          { class: "banner error" },
          `Server memakai jadwal valid terakhir: ${boot.schedule.error}`,
        ),
      );
    }

    const todaySchedule = resolveClient(calendar, boot.today);
    main.append(
      h(
        "section",
        { class: "card" },
        h("h2", null, "Hari ini"),
        todaySchedule === null
          ? h("p", null, "Libur menurut jadwal.")
          : h("p", null, `Masuk ${todaySchedule.in} · Pulang ${todaySchedule.out}`),
      ),
    );

    main.append(
      h(
        "section",
        { class: "card" },
        h("h2", null, "Base week"),
        h("p", { class: "card-sub" }, "Berlaku saat tidak ada override. Minimal satu hari kerja."),
        weekEditor(calendar.base, readonly),
      ),
    );

    main.append(
      h(
        "section",
        { class: "card" },
        h(
          "div",
          { class: "page-head" },
          h(
            "div",
            null,
            h("h2", null, "Override"),
            h(
              "p",
              { class: "muted small" },
              `${calendar.overrides.length} rentang · urut tanggal awal`,
            ),
          ),
          readonly
            ? null
            : h(
                "button",
                {
                  class: "button",
                  type: "button",
                  onclick: () => {
                    editing = {
                      id: `ov-${Date.now().toString(36)}`,
                      from: boot.today,
                      to: boot.today,
                      priority: 0,
                      note: "",
                      schedule: null,
                      isNew: true,
                    };
                    errorMessage = null;
                    build();
                  },
                },
                "Tambah override",
              ),
        ),
        calendar.overrides.length === 0
          ? h("p", { class: "empty" }, "Belum ada override.")
          : h("div", null, ...calendar.overrides.map(overrideCard)),
        renderOverrideForm(),
      ),
    );

    const expired = expiredOverrides(calendar, boot.today);
    if (expired.length > 0) {
      main.append(
        h(
          "section",
          { class: "card" },
          h("h2", null, "Override kedaluwarsa"),
          h(
            "p",
            { class: "card-sub" },
            "Sudah lewat hari ini. Bisa dihapus agar file tetap rapi; tidak lagi memengaruhi jadwal.",
          ),
          ...expired.map((override) =>
            h(
              "div",
              { class: "override" },
              h(
                "div",
                { class: "override-head" },
                h(
                  "div",
                  null,
                  h("strong", null, override.note || override.id),
                  h(
                    "div",
                    { class: "small muted" },
                    `${formatDate(override.from)} – ${formatDate(override.to)} · priority ${override.priority}`,
                  ),
                ),
                readonly
                  ? null
                  : h(
                      "button",
                      {
                        class: "button danger",
                        type: "button",
                        onclick: () => {
                          if (!window.confirm(`Hapus override kedaluwarsa ${override.id}?`)) return;
                          calendar.overrides = calendar.overrides.filter(
                            (item) => item.id !== override.id,
                          );
                          notice =
                            "Override dihapus secara lokal. Klik Simpan jadwal untuk menulis file.";
                          build();
                        },
                      },
                      "Hapus",
                    ),
              ),
            ),
          ),
        ),
      );
    }

    main.append(
      h(
        "p",
        { class: "small muted" },
        "Ringkasan dampak dihitung saat menyimpan. Status recap lama tidak dihitung ulang; recap dibaca ulang dengan jadwal baru.",
      ),
    );
  }

  build();
}
