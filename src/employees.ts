// Employee display mapping. Pure: no DB, no HTTP, no device.

import type { EmployeeProfileRow } from "./db.ts";

export interface EmployeeView {
  idNumber: string;
  name: string;
  active: boolean;
}

export type EmployeeErrorCode = "INVALID_ARGS" | "NOT_FOUND" | "ACCOUNT_EXISTS";

export class EmployeeError extends Error {
  constructor(
    readonly code: EmployeeErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "EmployeeError";
  }
}

// prefix + (display name or device name) + suffix.
// A suffix that starts with "." or "," attaches without a space ("Budi, S.Kom").
export function composeDisplayName(profile: EmployeeProfileRow): string {
  const base = profile.displayName?.trim() || profile.deviceName;
  const prefix = profile.prefixTitle.trim();
  const suffix = profile.suffixTitle.trim();
  const head = prefix === "" ? base : `${prefix} ${base}`;
  if (suffix === "") return head;
  return /^[.,]/.test(suffix) ? `${head}${suffix}` : `${head} ${suffix}`;
}

export function toEmployeeViews(profiles: EmployeeProfileRow[]): EmployeeView[] {
  return profiles.map((profile) => ({
    idNumber: profile.idNumber,
    name: composeDisplayName(profile),
    active: profile.active,
  }));
}
