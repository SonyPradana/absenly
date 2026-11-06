// Karyawan: employee table + modal profile editor. Device fields are read-only.

import { getJson, postJson } from "../lib/api.js";
import { busy, confirmAction, h, toast } from "../lib/dom.js";

// Same constant as DEFAULT_EMPLOYEE_PASSWORD on the server. It is not a secret;
// the admin reads it here and tells the employee.
const DEFAULT_PASSWORD = "satutekad";

function compose(deviceName, displayName, prefix, suffix) {
  const base = (displayName ?? "").trim() || deviceName;
  const head = prefix.trim() === "" ? base : `${prefix.trim()} ${base}`;
  const tail = suffix.trim();
  if (tail === "") return head;
  return /^[.,]/.test(tail) ? `${head}${tail}` : `${head} ${tail}`;
}

export async function render(main, ctx) {
  const readOnly = ctx.bootstrap.read_only === true;
  const body = await ctx.cached("employees", () => getJson("/api/v1/employees"));
  const employees = body.data ?? [];
  const accounts = new Map();
  if (!readOnly) {
    const users = await ctx.cached("users", () => getJson("/api/v1/users"));
    for (const user of users.data ?? []) {
      if (user.employee_id_number) accounts.set(user.employee_id_number, user);
    }
  }

  const tableHost = h("div", { class: "card" });
  const dialog = h("dialog", { class: "modal", "aria-labelledby": "employee-modal-title" });

  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) dialog.close();
  });
  dialog.addEventListener("close", () => dialog.replaceChildren());

  main.append(
    h(
      "div",
      { class: "page-head" },
      h(
        "div",
        null,
        h("h1", null, "Karyawan"),
        h(
          "p",
          { class: "muted" },
          readOnly
            ? `${employees.length} karyawan. Data profil dibaca dari collector; viewer tidak bisa mengubahnya.`
            : `${employees.length} karyawan · ${employees.filter((item) => item.active).length} aktif. Nama perangkat dan ID tidak diubah dari web. Akun login memakai ID karyawan.`,
        ),
      ),
    ),
    tableHost,
    dialog,
  );

  function renderAccountCell(employee) {
    const account = accounts.get(employee.id_number) ?? null;
    return h(
      "td",
      null,
      account === null
        ? h("span", { class: "badge warn" }, "belum")
        : h("span", { class: "badge ok" }, "ada"),
    );
  }

  async function mutateAccount(employee, action, button, error) {
    const suffix = action === "delete" ? "/delete" : "";
    if (error !== undefined) error.hidden = true;
    busy(button, true);
    try {
      const result = await postJson(
        `/employees/${encodeURIComponent(employee.id_number)}/account${suffix}`,
        {},
      );
      if (action === "delete") {
        accounts.delete(employee.id_number);
        toast(`Akun ${result.data.username} dihapus.`);
      } else {
        accounts.set(employee.id_number, {
          username: result.data.username,
          employee_id_number: employee.id_number,
        });
        toast(
          action === "reset"
            ? `Password ${result.data.username} direset ke ${DEFAULT_PASSWORD}.`
            : `Akun ${result.data.username} dibuat dengan password ${DEFAULT_PASSWORD}.`,
        );
      }
      ctx.invalidate("users");
      // The account buttons live inside the editor modal, so close it and let
      // the table show the new badge state.
      dialog.close();
      renderTable();
    } catch (err) {
      toast(ctx.errorText(err), "error");
      busy(button, false);
      // Stay in the modal: the admin may retry without reopening the row.
      if (error !== undefined) {
        error.textContent = ctx.errorText(err);
        error.hidden = false;
      }
    }
  }

  function createAccount(employee, button, error) {
    void mutateAccount(employee, "create", button, error);
  }

  function resetAccount(employee, button, error) {
    if (
      !confirmAction(
        `Reset password ${employee.name} ke ${DEFAULT_PASSWORD}? Sesi login aktifnya akan diputus.`,
      )
    ) {
      return;
    }
    void mutateAccount(employee, "reset", button, error);
  }

  function deleteAccount(employee, button, error) {
    if (!confirmAction(`Hapus akun ${employee.name}? Data absensi tidak ikut terhapus.`)) return;
    void mutateAccount(employee, "delete", button, error);
  }

  function renderTable() {
    tableHost.replaceChildren();
    if (employees.length === 0) {
      tableHost.append(
        h("p", { class: "empty" }, "Belum ada karyawan. Jalankan sync terlebih dahulu."),
      );
      return;
    }
    tableHost.append(
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
              h("th", null, "Nama laporan"),
              h("th", null, "Nama perangkat"),
              h("th", null, "Status"),
              readOnly ? null : h("th", null, "Akun"),
              readOnly ? null : h("th", null, "Aksi"),
            ),
          ),
          h(
            "tbody",
            null,
            ...employees.map((employee) =>
              h(
                "tr",
                null,
                h("td", { class: "mono" }, employee.id_number),
                h("td", null, employee.name),
                h("td", { class: "muted" }, employee.device_name),
                h(
                  "td",
                  null,
                  h(
                    "span",
                    { class: `badge ${employee.active ? "ok" : "warn"}` },
                    employee.active ? "aktif" : "nonaktif",
                  ),
                ),
                readOnly ? null : renderAccountCell(employee),
                readOnly
                  ? null
                  : h(
                      "td",
                      null,
                      h(
                        "button",
                        {
                          class: "button",
                          type: "button",
                          onclick: () => openEditor(employee),
                        },
                        "Edit",
                      ),
                    ),
              ),
            ),
          ),
        ),
      ),
    );
  }

  // Account management lives in the editor modal: the table only reports
  // whether a login exists, and the default password is never printed there.
  function accountSection(employee, error) {
    const account = accounts.get(employee.id_number) ?? null;
    const badge =
      account === null
        ? h("span", { class: "badge warn" }, "belum")
        : h("span", { class: "badge ok" }, "ada");
    const detail =
      account === null
        ? `Belum ada akun. Username memakai ID karyawan (${employee.id_number}).`
        : `Username ${account.username}.`;

    // These are plain buttons, never submit: they must not save the profile form.
    const actions = h("div", { class: "inline" });
    if (account === null) {
      const create = h("button", { class: "button", type: "button" }, "Buat akun");
      create.addEventListener("click", () => createAccount(employee, create, error));
      actions.append(create);
    } else {
      const reset = h("button", { class: "button", type: "button" }, "Reset password");
      reset.addEventListener("click", () => resetAccount(employee, reset, error));
      const remove = h("button", { class: "button danger", type: "button" }, "Hapus akun");
      remove.addEventListener("click", () => deleteAccount(employee, remove, error));
      actions.append(reset, remove);
    }

    return h(
      "section",
      { class: "stack tight" },
      h("h3", null, "Akun login"),
      h("div", { class: "inline" }, badge, h("span", { class: "small muted" }, detail)),
      actions,
      h(
        "p",
        { class: "small muted" },
        `Password baru selalu ${DEFAULT_PASSWORD}. Mengubah akun memutus sesi login karyawan ini.`,
      ),
    );
  }

  function openEditor(employee) {
    const displayInput = h("input", {
      type: "text",
      value: employee.display_name ?? "",
      maxlength: "100",
      placeholder: employee.device_name,
    });
    const prefixInput = h("input", {
      type: "text",
      value: employee.prefix_title ?? "",
      maxlength: "50",
      placeholder: "mis. H.",
    });
    const suffixInput = h("input", {
      type: "text",
      value: employee.suffix_title ?? "",
      maxlength: "50",
      placeholder: "mis. , S.Kom",
    });
    const activeInput = h("input", { type: "checkbox", checked: employee.active });
    const preview = h("strong");
    const error = h("p", { class: "banner error", hidden: "" });

    const updatePreview = () => {
      preview.textContent = compose(
        employee.device_name,
        displayInput.value,
        prefixInput.value,
        suffixInput.value,
      );
    };
    for (const input of [displayInput, prefixInput, suffixInput]) {
      input.addEventListener("input", updatePreview);
    }
    updatePreview();

    const saveButton = h("button", { class: "button primary", type: "submit" }, "Simpan profil");

    const form = h(
      "form",
      {
        class: "stack",
        onsubmit: async (event) => {
          event.preventDefault();
          error.hidden = true;
          busy(saveButton, true, "Menyimpan…");
          try {
            const saved = await postJson(
              `/employees/${encodeURIComponent(employee.id_number)}/profile`,
              {
                display_name: displayInput.value.trim() === "" ? null : displayInput.value,
                prefix_title: prefixInput.value,
                suffix_title: suffixInput.value,
                active: activeInput.checked,
              },
            );
            const updated = saved.data;
            const index = employees.findIndex((item) => item.id_number === employee.id_number);
            if (index >= 0) {
              employees[index] = { ...employees[index], ...updated };
            }
            ctx.invalidate("employees");
            ctx.invalidate("recap:");
            ctx.invalidate("last-logs");
            toast(`Profil ${updated.name} disimpan.`);
            dialog.close();
            renderTable();
          } catch (err) {
            error.textContent = ctx.errorText(err);
            error.hidden = false;
            busy(saveButton, false);
          }
        },
      },
      h(
        "div",
        { class: "modal-head" },
        h(
          "div",
          null,
          h("h2", { id: "employee-modal-title" }, `Edit ${employee.name}`),
          h("p", { class: "muted small" }, `ID ${employee.id_number} · ${employee.device_name}`),
        ),
        h(
          "button",
          {
            class: "button ghost",
            type: "button",
            "aria-label": "Tutup",
            onclick: () => dialog.close(),
          },
          "Tutup",
        ),
      ),
      error,
      h(
        "div",
        { class: "grid three-col" },
        h(
          "label",
          null,
          "ID (tidak dapat diubah)",
          h("input", { type: "text", value: employee.id_number, disabled: "" }),
        ),
        h(
          "label",
          null,
          "Nama perangkat (tidak dapat diubah)",
          h("input", { type: "text", value: employee.device_name, disabled: "" }),
        ),
        h(
          "label",
          null,
          "Status",
          h("span", { class: "inline" }, activeInput, "Aktif di rekap dan export"),
        ),
      ),
      h(
        "div",
        { class: "grid three-col" },
        h("label", null, "Nama tampilan", displayInput),
        h("label", null, "Gelar depan", prefixInput),
        h("label", null, "Gelar belakang", suffixInput),
      ),
      h(
        "p",
        { class: "small muted" },
        "Pratinjau: ",
        preview,
        " · Nama tampilan kosong berarti memakai nama perangkat.",
      ),
      h("hr"),
      accountSection(employee, error),
      h(
        "div",
        { class: "inline modal-actions" },
        saveButton,
        h("button", { class: "button", type: "button", onclick: () => dialog.close() }, "Batal"),
      ),
    );

    dialog.replaceChildren(form);
    dialog.showModal();
    displayInput.focus();
  }

  renderTable();
}
