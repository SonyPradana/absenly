// Relay service principal: a separate Bearer token, never an admin session.

import { createHash, timingSafeEqual } from "node:crypto";

export function digestRelayToken(token: string): Buffer {
  return createHash("sha256").update(token).digest();
}

export function isRelayAuthorized(authorization: string | null, expectedDigest: Buffer): boolean {
  if (authorization === null) return false;
  const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
  if (match === null) return false;
  const provided = match[1]!.trim();
  if (provided === "") return false;
  return timingSafeEqual(digestRelayToken(provided), expectedDigest);
}
