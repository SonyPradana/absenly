// Small DOM builder. Text always goes through textContent, never innerHTML.

export function h(tag, attrs, ...children) {
  const element = document.createElement(tag);
  let rest = children;

  if (
    attrs === null ||
    typeof attrs !== "object" ||
    attrs instanceof Node ||
    Array.isArray(attrs)
  ) {
    rest = [attrs, ...children];
  } else {
    for (const [key, value] of Object.entries(attrs)) {
      if (value === undefined || value === null || value === false) continue;
      if (key === "class") {
        element.className = value;
      } else if (key === "dataset") {
        for (const [dataKey, dataValue] of Object.entries(value)) {
          if (dataValue !== undefined && dataValue !== null) {
            element.dataset[dataKey] = String(dataValue);
          }
        }
      } else if (key === "style" && typeof value === "object") {
        for (const [styleKey, styleValue] of Object.entries(value)) {
          element.style.setProperty(styleKey, String(styleValue));
        }
      } else if (key.startsWith("on") && typeof value === "function") {
        element.addEventListener(key.slice(2).toLowerCase(), value);
      } else if (key === "value") {
        element.value = value;
      } else if (key === "checked") {
        element.checked = Boolean(value);
      } else if (key === "disabled") {
        element.disabled = Boolean(value);
      } else {
        element.setAttribute(key, String(value));
      }
    }
  }

  append(element, rest);
  return element;
}

function append(parent, children) {
  for (const child of children.flat(Infinity)) {
    if (child === undefined || child === null || child === false) continue;
    parent.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

let toastWrap = null;

export function toast(message, kind = "ok") {
  if (toastWrap === null) {
    toastWrap = h("div", { class: "toast-wrap", role: "status", "aria-live": "polite" });
    document.body.append(toastWrap);
  }
  const item = h("div", { class: `toast ${kind}` }, message);
  toastWrap.append(item);
  setTimeout(() => item.remove(), 4200);
}

export function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

export function showError(node, error) {
  clear(node);
  node.append(
    h("p", { class: "banner error", role: "alert" }, `Gagal memuat: ${errorText(error)}`),
    h("button", { class: "button", type: "button", onclick: () => location.reload() }, "Coba lagi"),
  );
}

export function confirmAction(message) {
  return window.confirm(message);
}

export function busy(button, on, label = "Memproses…") {
  if (on) {
    button.dataset.label = button.textContent ?? "";
    button.textContent = label;
    button.disabled = true;
  } else {
    button.textContent = button.dataset.label ?? button.textContent;
    button.disabled = false;
  }
}
