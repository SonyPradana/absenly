// FakeDevice for offline tests. Its shape follows docs/API.md:
//   connect, readSnapshot, disconnect
// The individual getters remain for fixture-level assertions.
// No network and no imports from src/zk.ts.

import { DeviceError } from "../../src/device.ts";

export interface DeviceCounts {
  users: number;
  records: number;
  usersCap: number;
  recordsCap: number;
  fingers: number;
}

export interface DeviceUser {
  uid: number;
  idNumber: string;
  name: string;
  privilege: number;
  card: number;
  groupId: string;
}

export interface DeviceAttendance {
  uid: number;
  idNumber: string;
  name: string;
  date: string;
  time: string;
  punch: number;
  verify: number;
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

export interface FakeDeviceOptions {
  users: DeviceUser[];
  attendance: DeviceAttendance[];
  attendanceSequence?: DeviceAttendance[][];
  countsSequence?: DeviceCounts[];
  failConnect?: Error;
  failUsers?: Error;
  failAttendanceSequence?: Array<Error | undefined>;
  validateCounts?: boolean;
}

export class FakeDevice implements DeviceGateway {
  readonly calls: string[] = [];
  connected = false;
  private countsCalls = 0;
  private usersCalls = 0;
  private attendanceCalls = 0;
  private snapshotCalls = 0;
  private lastCounts: DeviceCounts | null = null;
  private readonly users: DeviceUser[];
  private readonly baseAttendance: DeviceAttendance[];
  private readonly attendanceSequence: DeviceAttendance[][];
  private readonly countsSequence: DeviceCounts[] | null;
  private readonly failAttendanceSequence: Array<Error | undefined>;

  constructor(private readonly options: FakeDeviceOptions) {
    this.users = options.users.map((u) => ({ ...u }));
    this.baseAttendance = options.attendance.map((a) => ({ ...a }));
    this.attendanceSequence = (options.attendanceSequence ?? []).map((rows) =>
      rows.map((row) => ({ ...row })),
    );
    this.countsSequence = options.countsSequence
      ? options.countsSequence.map((c) => ({ ...c }))
      : null;
    this.failAttendanceSequence = options.failAttendanceSequence ?? [];
  }

  async connect(): Promise<void> {
    this.calls.push("connect");
    if (this.options.failConnect) throw this.options.failConnect;
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    this.calls.push("disconnect");
    this.connected = false;
  }

  async getCounts(): Promise<DeviceCounts> {
    this.calls.push("getCounts");
    const index = this.countsCalls++;
    const counts =
      this.countsSequence?.[Math.min(index, this.countsSequence.length - 1)] ??
      this.defaultCounts(this.attendanceForCall(this.attendanceCalls));
    this.lastCounts = { ...counts };
    return { ...counts };
  }

  async readSnapshot(): Promise<DeviceSnapshot> {
    this.calls.push("readSnapshot");
    const index = this.snapshotCalls++;
    const counts =
      this.countsSequence?.[Math.min(index, this.countsSequence.length - 1)] ??
      this.defaultCounts(this.attendanceForCall(index));
    const failure =
      this.failAttendanceSequence[Math.min(index, this.failAttendanceSequence.length - 1)];
    if (failure) throw failure;
    if (this.options.failUsers) throw this.options.failUsers;

    const users = this.users.map((u) => ({ ...u }));
    const attendance = this.attendanceForCall(index).map((row) => ({
      ...row,
      name: row.name || this.users.find((u) => u.idNumber === row.idNumber)?.name || row.idNumber,
    }));

    if (
      this.options.validateCounts &&
      (users.length !== counts.users || attendance.length !== counts.records)
    ) {
      throw new DeviceError(
        "ZK_COUNT_MISMATCH",
        `snapshot parsed ${users.length}/${attendance.length}, device ${counts.users}/${counts.records}`,
        true,
      );
    }

    return { counts: { ...counts }, users, attendance };
  }

  async getUsers(): Promise<DeviceUser[]> {
    this.calls.push("getUsers");
    const index = this.usersCalls++;
    void index;
    if (this.options.failUsers) throw this.options.failUsers;
    if (
      this.options.validateCounts &&
      this.lastCounts &&
      this.users.length !== this.lastCounts.users
    ) {
      throw new Error(
        `ZK_PARSE: user parsed ${this.users.length}, device ${this.lastCounts.users}`,
      );
    }
    return this.users.map((u) => ({ ...u }));
  }

  async getAttendance(): Promise<DeviceAttendance[]> {
    this.calls.push("getAttendance");
    const index = this.attendanceCalls++;
    const failure =
      this.failAttendanceSequence[Math.min(index, this.failAttendanceSequence.length - 1)];
    if (failure) throw failure;
    const rows = this.attendanceForCall(index);
    if (this.options.validateCounts && this.lastCounts && rows.length !== this.lastCounts.records) {
      throw new Error(
        `ZK_COUNT_MISMATCH: attendance parsed ${rows.length}, device ${this.lastCounts.records}`,
      );
    }
    return rows.map((row) => ({
      ...row,
      name: row.name || this.users.find((u) => u.idNumber === row.idNumber)?.name || row.idNumber,
    }));
  }

  resetCalls(): void {
    this.calls.length = 0;
    this.countsCalls = 0;
    this.usersCalls = 0;
    this.attendanceCalls = 0;
    this.snapshotCalls = 0;
    this.lastCounts = null;
  }

  private attendanceForCall(index: number): DeviceAttendance[] {
    if (this.attendanceSequence.length === 0) return this.baseAttendance;
    return this.attendanceSequence[Math.min(index, this.attendanceSequence.length - 1)]!;
  }

  private defaultCounts(attendance: DeviceAttendance[]): DeviceCounts {
    return {
      users: this.users.length,
      records: attendance.length,
      usersCap: 2000,
      recordsCap: 100000,
      fingers: 0,
    };
  }
}

export function makeCounts(users: number, records: number): DeviceCounts {
  return { users, records, usersCap: 2000, recordsCap: 100000, fingers: 0 };
}
