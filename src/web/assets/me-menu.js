// Burger menu for the /me topbar. Server-rendered HTML, so no inline handlers
// (the CSP is script-src 'self').

const button = document.getElementById("topbar-burger");
const menu = document.getElementById("topbar-menu");

if (button !== null && menu !== null) {
  const setOpen = (open) => {
    button.setAttribute("aria-expanded", open ? "true" : "false");
    if (open) menu.setAttribute("data-open", "");
    else menu.removeAttribute("data-open");
  };

  button.addEventListener("click", () => {
    setOpen(button.getAttribute("aria-expanded") !== "true");
  });

  document.addEventListener("click", (event) => {
    if (button.getAttribute("aria-expanded") !== "true") return;
    const target = event.target;
    if (!(target instanceof Node)) return;
    if (menu.contains(target) || button.contains(target)) return;
    setOpen(false);
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") setOpen(false);
  });
}
