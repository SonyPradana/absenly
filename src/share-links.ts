// Share links are bearer capabilities: one employee, one month, 24 hours.
// The UUID is the secret; the public page has no other authorization.

import { randomUUID } from "node:crypto";
import type { ShareLinkInput, ShareLinkRow } from "./db.ts";
import { stamp } from "./time.ts";

export const SHARE_TTL_MS = 24 * 60 * 60 * 1000;
export const SHARE_TOKEN_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function newShareLink(input: {
  idNumber: string;
  month: string;
  now: Date;
}): ShareLinkInput {
  return {
    token: randomUUID(),
    idNumber: input.idNumber,
    month: input.month,
    createdAt: stamp(input.now),
    expiresAt: input.now.getTime() + SHARE_TTL_MS,
  };
}

export function isShareLinkActive(link: ShareLinkRow, nowMs: number): boolean {
  return link.expiresAt > nowMs;
}
