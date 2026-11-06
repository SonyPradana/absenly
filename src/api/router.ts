// /api/v1 entrypoint: path prefix, dispatch, and error envelope.

import { RelayClientError } from "../relay/client.ts";
import { ApiError, errorResponse, route, type ApiContext } from "./handlers.ts";

export async function handleApi(
  request: Request,
  url: URL,
  ctx: ApiContext,
): Promise<Response | null> {
  if (url.pathname !== "/api/v1" && !url.pathname.startsWith("/api/v1/")) {
    return null;
  }

  try {
    return await route(request, url, ctx);
  } catch (error) {
    if (error instanceof ApiError) return errorResponse(error);
    if (error instanceof RelayClientError) {
      return errorResponse(new ApiError(error.status, error.code, error.message));
    }
    console.error("api error:", error instanceof Error ? error.message : error);
    return errorResponse(new ApiError(500, "INTERNAL_ERROR", "Internal server error"));
  }
}
