// ZKTeco X606-S TCP 4370 adapter. Read-only by design.
// Self-contained: no DB, web, or API imports. Hardware-verified against the X606-S.

import net from "node:net";
import {
  DeviceError,
  type DeviceAttendance,
  type DeviceCounts,
  type DeviceGateway,
  type DeviceSnapshot,
  type DeviceUser,
} from "./device.ts";

const MAGIC1 = 0x5050;
const MAGIC2 = 0x7d82;

const CMD = {
  CONNECT: 1000,
  EXIT: 1001,
  USERTEMP_RRQ: 9,
  ATTLOG_RRQ: 13,
  GET_FREE_SIZES: 50,
  AUTH: 1102,
  PREPARE_DATA: 1500,
  DATA: 1501,
  FREE_DATA: 1502,
  READ_BUFFER: 1503,
  GET_BUFFER: 1504,
  ACK_OK: 2000,
  ACK_UNAUTH: 2005,
} as const;

const FCT_USER = 5;
const MAX_CHUNK = 0xffc0;

type Frame = { cmd: number; session: number; reply: number; data: Buffer };

function u16(n: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n & 0xffff);
  return b;
}

function u32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n >>> 0);
  return b;
}

// zkemsdk.c: sum 16-bit LE words, complement, modulo 0xFFFF.
function checksum(buf: Buffer): number {
  let cs = 0;
  let i = 0;
  let l = buf.length;
  while (l > 1) {
    cs += buf.readUInt16LE(i);
    i += 2;
    l -= 2;
    if (cs > 0xffff) cs -= 0xffff;
  }
  if (l) cs += buf.readUInt8(buf.length - 1);
  while (cs > 0xffff) cs -= 0xffff;
  cs = ~cs;
  while (cs < 0) cs += 0xffff;
  return cs & 0xffff;
}

// pyzk computes the checksum with the old reply, then sends reply+1.
function buildPacket(cmd: number, data: Buffer, session: number, replyId: number): Buffer {
  const base = Buffer.concat([u16(cmd), u16(0), u16(session), u16(replyId), data]);
  const cs = checksum(base);
  let sentReply = replyId + 1;
  if (sentReply >= 0xffff) sentReply -= 0xffff;
  const payload = Buffer.concat([u16(cmd), u16(cs), u16(session), u16(sentReply), data]);
  return Buffer.concat([u16(MAGIC1), u16(MAGIC2), u32(payload.length), payload]);
}

function makeCommKey(key: number, sessionId: number, ticks = 50): Buffer {
  let k = 0n;
  for (let i = 0; i < 32; i++) {
    k = (key & (1 << i)) !== 0 ? (k << 1n) | 1n : k << 1n;
  }
  k = (k + BigInt(sessionId)) & 0xffffffffn;
  const b = Buffer.alloc(4);
  b.writeUInt32LE(Number(k));
  let x = Buffer.from([
    b.readUInt8(0) ^ 0x5a,
    b.readUInt8(1) ^ 0x4b,
    b.readUInt8(2) ^ 0x53,
    b.readUInt8(3) ^ 0x4f,
  ]);
  const h0 = x.readUInt16LE(0);
  const h1 = x.readUInt16LE(2);
  x = Buffer.alloc(4);
  x.writeUInt16LE(h1, 0);
  x.writeUInt16LE(h0, 2);
  const B = ticks & 0xff;
  return Buffer.from([x.readUInt8(0) ^ B, x.readUInt8(1) ^ B, B, x.readUInt8(3) ^ B]);
}

function cstr(b: Buffer): string {
  const i = b.indexOf(0);
  return (i === -1 ? b : b.subarray(0, i)).toString("utf8").trim();
}

// 4-byte ZK timestamp -> local device time (not Unix epoch).
export function decodeTime(b: Buffer): { date: string; time: string } {
  if (b.length < 4) throw new DeviceError("ZK_PARSE", "timestamp buffer is too short");
  let t = b.readUInt32LE(0);
  const second = t % 60;
  t = Math.floor(t / 60);
  const minute = t % 60;
  t = Math.floor(t / 60);
  const hour = t % 24;
  t = Math.floor(t / 24);
  const day = (t % 31) + 1;
  t = Math.floor(t / 31);
  const month = (t % 12) + 1;
  const year = Math.floor(t / 12) + 2000;

  if (year < 2000 || year > 2100) {
    throw new DeviceError("ZK_PARSE", `timestamp year ${year} is outside 2000-2100`);
  }

  // ZK stores day 1-31 for every month, so 2026-02-31 is representable.
  // Date.UTC rolls invalid dates forward; compare the parts to reject them.
  const calendar = new Date(Date.UTC(year, month - 1, day));
  if (
    calendar.getUTCFullYear() !== year ||
    calendar.getUTCMonth() !== month - 1 ||
    calendar.getUTCDate() !== day
  ) {
    throw new DeviceError(
      "ZK_PARSE",
      `timestamp has an invalid calendar date (${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")})`,
    );
  }

  return {
    date: `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
    time: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:${String(second).padStart(2, "0")}`,
  };
}

export function parseUsers(data: Buffer, expectedUsers: number): DeviceUser[] {
  if (expectedUsers === 0) return [];
  if (data.length < 4) throw new DeviceError("ZK_PARSE", "user buffer is too short");

  const total = data.readUInt32LE(0);
  const packetSize = total / expectedUsers;
  if (!Number.isInteger(packetSize) || (packetSize !== 28 && packetSize !== 72)) {
    throw new DeviceError("ZK_PARSE", `unknown user packet size (${packetSize})`);
  }

  const users: DeviceUser[] = [];
  for (let off = 4; off + packetSize <= data.length; off += packetSize) {
    const rec = data.subarray(off, off + packetSize);
    if (packetSize === 72) {
      const uid = rec.readUInt16LE(0);
      users.push({
        uid,
        privilege: rec.readUInt8(2),
        name: cstr(rec.subarray(11, 35)),
        card: rec.readUInt32LE(35),
        groupId: cstr(rec.subarray(40, 47)),
        idNumber: cstr(rec.subarray(48, 72)) || String(uid),
      });
    } else {
      users.push({
        uid: rec.readUInt16LE(0),
        privilege: rec.readUInt8(2),
        name: cstr(rec.subarray(8, 16)),
        card: rec.readUInt32LE(16),
        groupId: String(rec.readUInt8(21)),
        idNumber: String(rec.readUInt32LE(24)),
      });
    }
  }

  if (users.length !== expectedUsers) {
    throw new DeviceError(
      "ZK_COUNT_MISMATCH",
      `users parsed ${users.length}, device ${expectedUsers}`,
      true,
    );
  }
  return users;
}

export function parseAttendance(
  data: Buffer,
  expectedRecords: number,
  users: DeviceUser[],
): DeviceAttendance[] {
  if (expectedRecords === 0) return [];
  if (data.length < 4) throw new DeviceError("ZK_PARSE", "attendance buffer is too short");

  const byId = new Map(users.map((user) => [user.idNumber, user.name]));
  const byUid = new Map(users.map((user) => [String(user.uid), user.idNumber]));

  const total = data.readUInt32LE(0);
  const packetSize = total / expectedRecords;
  if (!Number.isInteger(packetSize) || ![8, 16, 40].includes(packetSize)) {
    throw new DeviceError("ZK_PARSE", `unknown attendance packet size (${packetSize})`);
  }

  const rows: DeviceAttendance[] = [];
  for (let off = 4; off + packetSize <= data.length; off += packetSize) {
    const rec = data.subarray(off, off + packetSize);
    let uid = 0;
    let idNumber = "";
    let verify = 0;
    let punch = 0;
    let ts: { date: string; time: string };

    if (packetSize === 40) {
      uid = rec.readUInt16LE(0);
      idNumber = cstr(rec.subarray(2, 26));
      verify = rec.readUInt8(26);
      ts = decodeTime(rec.subarray(27, 31));
      punch = rec.readUInt8(31);
    } else if (packetSize === 16) {
      idNumber = String(rec.readUInt32LE(0));
      ts = decodeTime(rec.subarray(4, 8));
      verify = rec.readUInt8(8);
      punch = rec.readUInt8(9);
    } else {
      uid = rec.readUInt16LE(0);
      verify = rec.readUInt8(2);
      ts = decodeTime(rec.subarray(3, 7));
      punch = rec.readUInt8(7);
      idNumber = byUid.get(String(uid)) ?? String(uid);
    }

    const resolvedId = idNumber || String(uid);
    rows.push({
      idNumber: resolvedId,
      name: byId.get(resolvedId) ?? resolvedId,
      date: ts.date,
      time: ts.time,
      punch: punch as 0 | 1,
      verify,
    });
  }

  if (rows.length !== expectedRecords) {
    throw new DeviceError(
      "ZK_COUNT_MISMATCH",
      `attendance parsed ${rows.length}, device ${expectedRecords}`,
      true,
    );
  }
  return rows;
}

export class ZkClient implements DeviceGateway {
  private sock: net.Socket | null = null;
  private buf = Buffer.alloc(0);
  private waiters: Array<() => void> = [];
  private closed = false;
  private session = 0;
  private reply = 0xffff - 1;
  private lastError: Error | null = null;

  constructor(
    private readonly host: string,
    private readonly port = 4370,
    private readonly commKey = 0,
    private readonly timeoutMs = 10_000,
  ) {}

  async connect(): Promise<void> {
    this.resetState();
    const sock = net.createConnection({ host: this.host, port: this.port });
    this.sock = sock;

    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new DeviceError("ZK_TIMEOUT", "connect timeout", true));
        }, this.timeoutMs);
        sock.once("connect", () => {
          clearTimeout(timer);
          resolve();
        });
        sock.once("error", (error) => {
          clearTimeout(timer);
          reject(new DeviceError("ZK_NETWORK", error.message, true));
        });
      });
    } catch (error) {
      sock.destroy();
      this.sock = null;
      throw error;
    }

    sock.on("data", (data: Buffer) => {
      this.buf = Buffer.concat([this.buf, data]);
      this.wake();
    });
    sock.on("close", () => {
      this.closed = true;
      this.wake();
    });
    sock.on("error", (error) => {
      this.lastError = error;
      this.closed = true;
      this.wake();
    });

    try {
      let frame = await this.send(CMD.CONNECT);
      if (frame.cmd === CMD.ACK_UNAUTH) {
        frame = await this.send(CMD.AUTH, makeCommKey(this.commKey, this.session));
      }
      if (frame.cmd !== CMD.ACK_OK) {
        throw new DeviceError("ZK_AUTH", `command ${frame.cmd}`, false);
      }
    } catch (error) {
      sock.destroy();
      this.sock = null;
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    const sock = this.sock;
    if (sock === null) return;

    try {
      await this.send(CMD.EXIT);
    } catch {
      // The connection may already be gone.
    }
    this.closed = true;
    sock.end();
    this.sock = null;
  }

  async getCounts(): Promise<DeviceCounts> {
    const frame = await this.send(CMD.GET_FREE_SIZES);
    const data = frame.data;
    if (data.length < 68) {
      throw new DeviceError("ZK_PROTOCOL", "GET_FREE_SIZES payload is too short");
    }

    const fields: number[] = [];
    for (let i = 0; i < 20 && (i + 1) * 4 <= data.length; i++) {
      fields.push(data.readInt32LE(i * 4));
    }
    return {
      users: fields[4] ?? 0,
      fingers: fields[6] ?? 0,
      records: fields[8] ?? 0,
      usersCap: fields[15] ?? 0,
      recordsCap: fields[16] ?? 0,
    };
  }

  async readSnapshot(): Promise<DeviceSnapshot> {
    const counts = await this.getCounts();
    const usersRaw = counts.users === 0 ? null : await this.getUsersRaw();
    const attendanceRaw = counts.records === 0 ? null : await this.getAttendanceRaw();
    const after = await this.getCounts();

    // A live punch or user change during the buffered reads makes the snapshot stale.
    if (counts.users !== after.users || counts.records !== after.records) {
      throw new DeviceError(
        "ZK_COUNT_MISMATCH",
        `device changed during read (users ${counts.users}->${after.users}, records ${counts.records}->${after.records})`,
        true,
      );
    }

    const users = usersRaw === null ? [] : parseUsers(usersRaw, counts.users);
    const attendance =
      attendanceRaw === null ? [] : parseAttendance(attendanceRaw, counts.records, users);

    return { counts, users, attendance };
  }

  private resetState(): void {
    this.buf = Buffer.alloc(0);
    this.waiters = [];
    this.closed = false;
    this.session = 0;
    this.reply = 0xffff - 1;
    this.lastError = null;
  }

  private wake(): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const wake of waiters) wake();
  }

  private async need(n: number): Promise<void> {
    while (this.buf.length < n) {
      if (this.closed) {
        throw new DeviceError("ZK_NETWORK", this.lastError?.message ?? "socket closed", true);
      }
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(
            new DeviceError(
              "ZK_TIMEOUT",
              `timeout waiting for ${n} bytes, have ${this.buf.length}`,
              true,
            ),
          );
        }, this.timeoutMs);
        this.waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }

  private async readFrame(): Promise<Frame> {
    await this.need(8);
    if (this.buf.readUInt16LE(0) !== MAGIC1 || this.buf.readUInt16LE(2) !== MAGIC2) {
      throw new DeviceError("ZK_PROTOCOL", "invalid TCP magic");
    }
    const len = this.buf.readUInt32LE(4);
    if (len < 8 || len > 5 * 1024 * 1024) {
      throw new DeviceError("ZK_PROTOCOL", `unreasonable frame length (${len})`);
    }
    await this.need(8 + len);
    const raw = this.buf.subarray(0, 8 + len);
    this.buf = this.buf.subarray(8 + len);
    const payload = raw.subarray(8);
    return {
      cmd: payload.readUInt16LE(0),
      session: payload.readUInt16LE(4),
      reply: payload.readUInt16LE(6),
      data: payload.subarray(8),
    };
  }

  private async send(cmd: number, data: Buffer = Buffer.alloc(0)): Promise<Frame> {
    if (this.sock === null || this.closed) {
      throw new DeviceError("ZK_NETWORK", "not connected", true);
    }
    this.sock.write(buildPacket(cmd, data, this.session, this.reply));
    const frame = await this.readFrame();
    this.session = frame.session;
    this.reply = frame.reply;
    return frame;
  }

  private async getUsersRaw(): Promise<Buffer> {
    return this.readBuffer(CMD.USERTEMP_RRQ, FCT_USER);
  }

  private async getAttendanceRaw(): Promise<Buffer> {
    return this.readBuffer(CMD.ATTLOG_RRQ);
  }

  // pyzk read_with_buffer: command 1503, chunks 1504, then free 1502.
  private async readBuffer(command: number, fct = 0, ext = 0): Promise<Buffer> {
    const request = Buffer.concat([Buffer.from([1]), u16(command), u32(fct), u32(ext)]);
    const frame = await this.send(CMD.READ_BUFFER, request);
    if (frame.cmd === CMD.DATA) return frame.data;
    if (frame.cmd !== CMD.PREPARE_DATA && frame.cmd !== CMD.ACK_OK) {
      throw new DeviceError("ZK_PROTOCOL", `prepare buffer failed (${frame.cmd})`);
    }

    const size = frame.data.length >= 5 ? frame.data.readUInt32LE(1) : 0;
    if (!size) throw new DeviceError("ZK_PROTOCOL", "empty buffer size");

    try {
      const chunks: Buffer[] = [];
      let start = 0;
      while (start < size) {
        const len = Math.min(MAX_CHUNK, size - start);
        const response = await this.send(CMD.GET_BUFFER, Buffer.concat([u32(start), u32(len)]));

        let chunk: Buffer;
        if (response.cmd === CMD.PREPARE_DATA) {
          const expected = response.data.readUInt32LE(0);
          const dataFrame = await this.readFrame();
          if (dataFrame.cmd !== CMD.DATA) {
            throw new DeviceError("ZK_PROTOCOL", `data chunk failed (${dataFrame.cmd})`);
          }
          chunk = dataFrame.data;
          if (expected && chunk.length !== expected) {
            throw new DeviceError("ZK_PROTOCOL", `chunk ${chunk.length} != ${expected}`);
          }
        } else if (response.cmd === CMD.DATA) {
          chunk = response.data;
        } else {
          throw new DeviceError("ZK_PROTOCOL", `chunk failed (${response.cmd})`);
        }

        chunks.push(chunk);
        const ack = await this.readFrame();
        if (ack.cmd !== CMD.ACK_OK) {
          throw new DeviceError("ZK_PROTOCOL", `chunk ack failed (${ack.cmd})`);
        }
        start += len;
      }
      return Buffer.concat(chunks);
    } finally {
      try {
        await this.send(CMD.FREE_DATA);
      } catch {
        // The device clears the buffer when the connection closes.
      }
    }
  }
}
