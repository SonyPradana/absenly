// Generate: one Excel file, four modes. Raw is always the full workbook.

import { getJson, postJson } from "../lib/api.js";
import { busy, h } from "../lib/dom.js";
import { formatDate, formatDateTime, monthLabel, monthRange } from "../lib/format.js";

const MODES = [
  {
    value: "raw",
    label: "Raw",
    note: "Semua punch mentah pada rentang tanggal. Tidak memakai pilihan karyawan.",
  },
  {
    value: "recap",
    label: "Recap",
    note: "Grid harian per karyawan terpilih: IN, OUT, telat, pulang cepat, status.",
  },
  {
    value: "user",
    label: "User",
    note: "Satu sheet per karyawan terpilih: satu baris per punch (IN/OUT) dengan jadwal sebagai acuan.",
  },
  {
    value: "poin",
    label: "Poin",
    note: "Satu sheet per karyawan terpilih: satu baris per hari, sama seperti rekap harian di halaman share.",
  },
  {
    value: "raw,recap,user,poin",
    label: "Semua",
    note: "Satu file berisi Raw, Recap, User, dan Poin.",
  },
];

export async function render(main, ctx) {
  const boot = ctx.bootstrap;
  const readOnly = boot.read_only === true;
  const employeeBody = await ctx.cached("employees", () => getJson("/api/v1/employees"));
  const employees = employeeBody.data ?? [];
  const active = employees.filter((employee) => employee.active);
  const month = boot.today.slice(0, 7);
  const initial = monthRange(month);
  const selected = new Set(active.map((employee) => employee.id_number));
  let mode = "raw";

  main.append(
    h(
      "div",
      { class: "page-head" },
      h(
        "div",
        null,
        h("h1", null, "Generate"),
        h("p", { class: "muted" }, "Satu file Excel per generate. File langsung diunduh."),
      ),
    ),
  );

  const fromInput = h("input", { type: "date", value: initial.from, required: "" });
  const toInput = h("input", { type: "date", value: boot.today, required: "" });
  const userPanel = h("div", { class: "stack" });
  const summary = h("p", { class: "small muted" });

  const modeRadios = MODES.map((item) =>
    h(
      "label",
      { class: "inline", style: { alignItems: "flex-start", gap: "0.55rem" } },
      h("input", {
        type: "radio",
        name: "mode",
        value: item.value,
        checked: item.value === mode,
        onchange: () => {
          mode = item.value;
          userPanel.hidden = mode === "raw";
          updateSummary();
        },
      }),
      h(
        "span",
        null,
        h("strong", null, item.label),
        h("span", { class: "small muted" }, ` — ${item.note}`),
      ),
    ),
  );

  function updateSummary() {
    const count = selected.size;
    summary.textContent =
      mode === "raw"
        ? `Raw: seluruh punch ${formatDate(fromInput.value)}–${formatDate(toInput.value)}.`
        : `${MODES.find((item) => item.value === mode)?.label}: ${count} dari ${employees.length} karyawan dipilih.`;
  }

  function renderUsers() {
    userPanel.replaceChildren();
    if (mode === "raw") {
      userPanel.hidden = true;
      return;
    }
    userPanel.hidden = false;
    userPanel.append(
      h(
        "div",
        { class: "inline" },
        h(
          "button",
          {
            class: "button",
            type: "button",
            onclick: () => {
              for (const employee of active) selected.add(employee.id_number);
              renderUsers();
            },
          },
          "Pilih semua aktif",
        ),
        h(
          "button",
          {
            class: "button",
            type: "button",
            onclick: () => {
              selected.clear();
              renderUsers();
            },
          },
          "Kosongkan",
        ),
      ),
      h(
        "div",
        { class: "check-list" },
        ...employees.map((employee) =>
          h(
            "label",
            null,
            h("input", {
              type: "checkbox",
              checked: selected.has(employee.id_number),
              onchange: (event) => {
                if (event.target.checked) selected.add(employee.id_number);
                else selected.delete(employee.id_number);
                updateSummary();
              },
            }),
            `${employee.name} (${employee.id_number})`,
            employee.active ? null : h("span", { class: "badge" }, "nonaktif"),
          ),
        ),
      ),
      h(
        "p",
        { class: "small muted" },
        "Karyawan nonaktif tidak dipilih otomatis, tetapi tetap bisa dipilih manual.",
      ),
    );
    updateSummary();
  }

  const generateButton = h("button", { class: "button primary", type: "button" }, "Generate Excel");
  generateButton.addEventListener("click", () => {
    if (!fromInput.value || !toInput.value) {
      ctx.toast("Isi rentang tanggal.", "error");
      return;
    }
    if (fromInput.value > toInput.value) {
      ctx.toast("Tanggal awal tidak boleh setelah tanggal akhir.", "error");
      return;
    }
    if (mode !== "raw" && selected.size === 0) {
      ctx.toast("Pilih minimal satu karyawan untuk Recap/User/Semua.", "error");
      return;
    }

    const params = new URLSearchParams({
      from: fromInput.value,
      to: toInput.value,
      mode,
    });
    if (mode !== "raw") params.set("employee_ids", [...selected].join(","));
    window.location.assign(`/api/v1/export.xlsx?${params}`);
    ctx.toast("File sedang diunduh. Cek folder unduhan.");
  });

  main.append(
    h(
      "section",
      { class: "card" },
      h("h2", null, "Mode"),
      h("div", { class: "stack" }, ...modeRadios),
      h("hr"),
      h(
        "div",
        { class: "toolbar" },
        h("label", null, "Dari", fromInput),
        h("label", null, "Sampai", toInput),
        h(
          "button",
          {
            class: "button",
            type: "button",
            onclick: () => {
              const range = monthRange(month);
              fromInput.value = range.from;
              toInput.value = boot.today;
              updateSummary();
            },
          },
          `Bulan ini (${monthLabel(month)})`,
        ),
      ),
      userPanel,
      h("hr"),
      h("div", { class: "inline" }, generateButton),
      summary,
    ),
  );

  const shareEmployee = h(
    "select",
    { disabled: active.length === 0 },
    ...(active.length === 0
      ? [h("option", { value: "" }, "Tidak ada karyawan aktif")]
      : active.map((employee) =>
          h(
            "option",
            {
              value: employee.id_number,
              selected: employee.id_number === active[0]?.id_number,
            },
            `${employee.name} (${employee.id_number})`,
          ),
        )),
  );
  const shareMonth = h("input", { type: "month", value: month, max: month, required: "" });
  const shareResult = h("div", { class: "stack", "aria-live": "polite" });
  const shareButton = h("button", { class: "button primary", type: "button" }, "Buat link");

  shareButton.addEventListener("click", async () => {
    if (!shareEmployee.value || !shareMonth.value) {
      ctx.toast("Pilih karyawan dan bulan.", "error");
      return;
    }
    busy(shareButton, true, "Membuat…");
    try {
      const body = await postJson("/generate/share", {
        id_number: shareEmployee.value,
        month: shareMonth.value,
      });
      const url = new URL(body.data.path, location.origin).href;
      const linkInput = h("input", {
        type: "text",
        class: "mono share-url",
        value: url,
        readonly: "",
      });
      const copyButton = h(
        "button",
        {
          class: "button",
          type: "button",
          onclick: async () => {
            try {
              await navigator.clipboard.writeText(url);
              ctx.toast("Link disalin.");
            } catch {
              linkInput.select();
              ctx.toast("Link dipilih. Tekan Ctrl+C untuk menyalin.", "error");
            }
          },
        },
        "Copy link",
      );
      shareResult.replaceChildren(
        h("p", { class: "banner ok" }, "Link rekap individu berhasil dibuat."),
        h(
          "div",
          { class: "inline" },
          linkInput,
          h(
            "a",
            {
              class: "button",
              href: url,
              target: "_blank",
              rel: "noopener noreferrer",
            },
            "Buka link",
          ),
          copyButton,
        ),
        h(
          "p",
          { class: "small muted" },
          `Berlaku sampai ${formatDateTime(body.data.expires_at)} WIB. Siapa pun yang memegang link dapat melihat rekap ini sampai kedaluwarsa.`,
        ),
      );
    } catch (error) {
      ctx.toast(ctx.errorText(error), "error");
    } finally {
      busy(shareButton, false);
    }
  });

  if (!readOnly) {
    main.append(
      h(
        "section",
        { class: "card" },
        h("h2", null, "Bagikan rekap individu"),
        h(
          "p",
          { class: "card-sub" },
          "Halaman web tanpa login untuk satu karyawan aktif dan satu bulan. Link berlaku 24 jam.",
        ),
        h(
          "div",
          { class: "toolbar" },
          h("label", null, "Karyawan", shareEmployee),
          h("label", null, "Bulan", shareMonth),
          shareButton,
        ),
        shareResult,
      ),
    );

    if (active.length === 0) shareButton.disabled = true;
  }

  renderUsers();
  updateSummary();
}
