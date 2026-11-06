// Tiny HTML escaping helpers for server-rendered pages.

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function esc(value: unknown): string {
  return String(value).replace(/[&<>"']/g, (char) => HTML_ESCAPES[char] ?? char);
}

export function escAttr(value: unknown): string {
  return esc(value);
}

// JSON inside an HTML attribute: escape the quote and < so it cannot break out.
export function jsonAttr(value: unknown): string {
  return escAttr(JSON.stringify(value).replace(/</g, "\\u003c"));
}
