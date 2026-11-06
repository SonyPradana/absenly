// Log Absensi: raw punches, date range, employee filter, 100 rows per page.

import { getJson } from "../lib/api.js";
import { h } from "../lib/dom.js";
import { formatDate, formatTime } from "../lib/format.js";

function rowTable(rows) {
  if (rows.length === 0) return h("p", { class: "empty" }, "Tidak ada punch pada filter ini.");
  return h(
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
          h("th", null, "Tanggal"),
          h("th", null, "Jam"),
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
        ...rows.map((row) =>
          h(
            "tr",
            null,
            h("td", { class: "mono" }, formatDate(row.date)),
            h("td", { class: "mono" }, formatTime(row.time)),
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
  );
}

export async function render(main, ctx) {
  const boot = ctx.bootstrap;
  const employeeBody = await ctx.cached("employees", () => getJson("/api/v1/employees"));
  const employees = employeeBody.data ?? [];

  let page = 1;
  let result = { rows: [], meta: { total: 0, total_pages: 0, page: 1, per_page: 100 } };

  main.append(
    h(
      "div",
      { class: "page-head" },
      h(
        "div",
        null,
        h("h1", null, "Log Absensi"),
        h("p", { class: "muted" }, "Punch mentah dari device. IN/OUT adalah turunan waktu."),
      ),
    ),
  );

  const fromInput = h("input", { type: "date", value: boot.today, required: "" });
  const toInput = h("input", { type: "date", value: boot.today, required: "" });
  const employeeSelect = h(
    "select",
    null,
    h("option", { value: "" }, "Semua karyawan"),
    ...employees.map((employee) =>
      h("option", { value: employee.id_number }, `${employee.name} (${employee.id_number})`),
    ),
  );
  const tableHost = h("div", null, h("p", { class: "loading" }, "Memuat…"));
  const pageInfo = h("span", { class: "small muted" });
  const prevButton = h("button", { class: "button", type: "button" }, "← Sebelumnya");
  const nextButton = h("button", { class: "button", type: "button" }, "Berikutnya →");
  const totalInfo = h("span", { class: "small muted" });

  async function load(nextPage = 1) {
    page = nextPage;
    tableHost.replaceChildren(h("p", { class: "loading" }, "Memuat…"));
    const params = new URLSearchParams({
      from: fromInput.value,
      to: toInput.value,
      page: String(page),
      per_page: "100",
    });
    if (employeeSelect.value !== "") params.set("employee_id", employeeSelect.value);
    try {
      const body = await getJson(`/api/v1/attendance?${params}`);
      result = {
        rows: body.data ?? [],
        meta: {
          total: body.meta?.total ?? 0,
          total_pages: body.meta?.total_pages ?? 0,
          page: body.meta?.page ?? page,
          per_page: body.meta?.per_page ?? 100,
        },
      };
      tableHost.replaceChildren(rowTable(result.rows));
      const pages = Math.max(1, result.meta.total_pages);
      pageInfo.textContent = `Halaman ${result.meta.page} dari ${pages}`;
      totalInfo.textContent = `${result.meta.total} punch`;
      prevButton.disabled = result.meta.page <= 1;
      nextButton.disabled = result.meta.page >= pages;
    } catch (error) {
      tableHost.replaceChildren(h("p", { class: "banner error" }, ctx.errorText(error)));
      prevButton.disabled = true;
      nextButton.disabled = true;
    }
  }

  const todayRadio = h("input", {
    type: "radio",
    name: "log-mode",
    value: "today",
    checked: true,
    onchange: () => {
      fromInput.value = boot.today;
      toInput.value = boot.today;
      fromInput.disabled = true;
      toInput.disabled = true;
      void load(1);
    },
  });
  const rangeRadio = h("input", {
    type: "radio",
    name: "log-mode",
    value: "range",
    onchange: () => {
      fromInput.disabled = false;
      toInput.disabled = false;
    },
  });
  fromInput.disabled = true;
  toInput.disabled = true;

  const filterButton = h(
    "button",
    {
      class: "button primary",
      type: "button",
      onclick: () => {
        if (!fromInput.value || !toInput.value) {
          ctx.toast("Isi tanggal.", "error");
          return;
        }
        if (fromInput.value > toInput.value) {
          ctx.toast("Tanggal awal tidak boleh setelah tanggal akhir.", "error");
          return;
        }
        void load(1);
      },
    },
    "Terapkan",
  );

  prevButton.addEventListener("click", () => {
    if (page > 1) void load(page - 1);
  });
  nextButton.addEventListener("click", () => {
    if (page < Math.max(1, result.meta.total_pages)) void load(page + 1);
  });

  main.append(
    h(
      "section",
      { class: "card" },
      h(
        "div",
        { class: "toolbar" },
        h("label", { class: "inline" }, todayRadio, "Hari ini"),
        h("label", { class: "inline" }, rangeRadio, "Rentang"),
        h("label", null, "Dari", fromInput),
        h("label", null, "Sampai", toInput),
        h("label", null, "Karyawan", employeeSelect),
        filterButton,
      ),
      h("p", { class: "small muted" }, "Maksimal 100 baris per halaman, urut tanggal lalu jam."),
    ),
  );

  main.append(
    h(
      "section",
      { class: "card" },
      tableHost,
      h(
        "div",
        { class: "pagination" },
        h("span", { class: "small muted" }, totalInfo),
        h("span", { class: "inline" }, prevButton, pageInfo, nextButton),
      ),
    ),
  );

  void load(1);
}
