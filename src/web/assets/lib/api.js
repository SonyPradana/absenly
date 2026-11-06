// Exported API helpers for the browser. Credentials travel in the HttpOnly cookie.

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

async function request(path, options = {}) {
  const headers = new Headers(options.headers ?? {});
  if (options.body !== undefined && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  const response = await fetch(path, {
    credentials: "same-origin",
    cache: "no-store",
    ...options,
    headers,
  });

  const type = response.headers.get("content-type") ?? "";
  const body = type.includes("json") ? await response.json().catch(() => null) : null;

  if (response.status === 401 && !String(path).startsWith("/login")) {
    const next = encodeURIComponent(location.pathname + location.search);
    location.assign(`/login?next=${next}`);
    throw new ApiError(401, "UNAUTHORIZED", "Sesi berakhir.");
  }

  if (!response.ok) {
    const error = body && body.error ? body.error : {};
    throw new ApiError(
      response.status,
      error.code ?? `HTTP_${response.status}`,
      error.message ?? `Permintaan gagal (${response.status}).`,
    );
  }

  return body;
}

export function getJson(path) {
  return request(path, { method: "GET" });
}

export function postJson(path, body) {
  return request(path, {
    method: "POST",
    body: JSON.stringify(body ?? {}),
  });
}

export function deleteJson(path) {
  return request(path, { method: "DELETE" });
}

export async function getAllPages(path, params = {}) {
  const rows = [];
  let page = 1;
  let totalPages = 1;
  do {
    const query = new URLSearchParams({ ...params, page: String(page) });
    const body = await getJson(`${path}?${query}`);
    rows.push(...(body.data ?? []));
    totalPages = body.meta?.total_pages ?? 0;
    page += 1;
  } while (page <= totalPages);
  return rows;
}
