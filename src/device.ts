// Device port. sync.ts depends on this, never on the ZK TCP adapter.

export interface DeviceCounts {
  users: number;
  fingers: number;
  records: number;
  usersCap: number;
  recordsCap: number;
}

export interface DeviceUser {
  uid: number; // audit only; never join by UID
  idNumber: string; // PIN, the join key
  name: string;
  privilege: number;
  card: number;
  groupId: string;
}

export interface DeviceAttendance {
  idNumber: string;
  name: string;
  date: string; // YYYY-MM-DD, WIB
  time: string; // HH:MM:SS, WIB
  punch: 0 | 1; // raw device value; can be wrong
  verify: number; // 15 = FACE
}

export interface DeviceSnapshot {
  counts: DeviceCounts;
  users: DeviceUser[];
  attendance: DeviceAttendance[];
}

export interface DeviceGateway {
  connect(): Promise<void>;
  readSnapshot(): Promise<DeviceSnapshot>;
  disconnect(): Promise<void>;
}

export type DeviceErrorCode =
  | "ZK_NETWORK"
  | "ZK_AUTH"
  | "ZK_PROTOCOL"
  | "ZK_PARSE"
  | "ZK_COUNT_MISMATCH"
  | "ZK_TIMEOUT";

export class DeviceError extends Error {
  constructor(
    readonly code: DeviceErrorCode,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "DeviceError";
  }
}
