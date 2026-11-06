// ZK fixture encoder/decoder. Test-only: do not use in production.
// Layout follows pyzk and the hardware-verified src/zk.ts:
//   user 72: <HB8s24sIx7sx24s>
//   user 28: <HB5s8sIxBhI>
//   attendance 40: <H24sB4sB8s>
//   attendance 16: <I4sBB2sI>
//   attendance 8:  <HB4sB>
// Every buffer starts with a u32 total_size.

export interface FixtureUser {
  uid: number;
  idNumber: string;
  name: string;
  privilege: number;
  card: number;
  groupId: string;
}

export interface FixtureAttendance {
  uid: number;
  idNumber: string;
  name?: string;
  date: string;
  time: string;
  punch: number;
  verify: number;
}

export interface ParsedAttendance extends FixtureAttendance {
  name: string;
}

export type UserPacketSize = 28 | 72;
export type AttendancePacketSize = 8 | 16 | 40;

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

function cstr(b: Buffer): string {
  const i = b.indexOf(0);
  return (i === -1 ? b : b.subarray(0, i)).toString("utf8").trim();
}

function writeFixed(
  buf: Buffer,
  offset: number,
  length: number,
  value: string,
  label: string,
): void {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length > length) {
    throw new Error(`${label} ${JSON.stringify(value)} = ${bytes.length} byte, maksimum ${length}`);
  }
  bytes.copy(buf, offset);
  if (bytes.length < length) buf.fill(0, offset + bytes.length, offset + length);
}

function withTotal(payload: Buffer): Buffer {
  // total_size is the record payload length, excluding the 4-byte prefix.
  return Buffer.concat([u32(payload.length), payload]);
}

export function encodeZkTime(date: string, time: string): Buffer {
  const dateParts = date.split("-");
  const timeParts = time.split(":");
  const year = Number(dateParts[0]);
  const month = Number(dateParts[1]);
  const day = Number(dateParts[2]);
  const hour = Number(timeParts[0]);
  const minute = Number(timeParts[1]);
  const second = Number(timeParts[2]);
  if (
    !Number.isInteger(year) ||
    !Number.isInteger(month) ||
    !Number.isInteger(day) ||
    !Number.isInteger(hour) ||
    !Number.isInteger(minute) ||
    !Number.isInteger(second) ||
    year < 2000 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31 ||
    hour < 0 ||
    hour > 23 ||
    minute < 0 ||
    minute > 59 ||
    second < 0 ||
    second > 59
  ) {
    throw new Error(`tanggal/jam tidak valid: ${date} ${time}`);
  }
  let t = (year - 2000) * 12 + (month - 1);
  t = t * 31 + (day - 1);
  t = t * 24 + hour;
  t = t * 60 + minute;
  t = t * 60 + second;
  return u32(t);
}

export function decodeZkTime(buf: Buffer): { date: string; time: string } {
  let t = buf.readUInt32LE(0);
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
  return {
    date: `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
    time: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:${String(second).padStart(2, "0")}`,
  };
}

export function encodeUsers(users: FixtureUser[], size: UserPacketSize = 72): Buffer {
  const payload = Buffer.alloc(users.length * size);
  users.forEach((user, index) => {
    const off = index * size;
    payload.writeUInt16LE(user.uid & 0xffff, off);
    payload[off + 2] = user.privilege & 0xff;
    if (size === 72) {
      // 8 password bytes are intentionally zero; never bring a real password into a fixture.
      writeFixed(payload, off + 11, 24, user.name, "nama");
      payload.writeUInt32LE(user.card >>> 0, off + 35);
      payload[off + 39] = 1; // enabled byte on this device; the parser does not use it
      writeFixed(payload, off + 40, 7, user.groupId, "groupId");
      payload[off + 47] = 0;
      writeFixed(payload, off + 48, 24, user.idNumber, "idNumber");
    } else {
      writeFixed(payload, off + 8, 8, user.name, "nama 28-byte");
      payload.writeUInt32LE(user.card >>> 0, off + 16);
      payload[off + 20] = 0;
      payload[off + 21] = Number.parseInt(user.groupId || "0", 10) & 0xff;
      payload.writeInt16LE(0, off + 22);
      payload.writeUInt32LE(Number(user.idNumber), off + 24);
    }
  });
  return withTotal(payload);
}

export function decodeUsers(
  data: Buffer,
  expectedUsers: number,
  size?: UserPacketSize,
): FixtureUser[] {
  if (expectedUsers === 0) return [];
  if (data.length < 4) throw new Error("buffer user terlalu pendek");
  const total = data.readUInt32LE(0);
  const packetSize = size ?? ((total / expectedUsers) as UserPacketSize);
  if (packetSize !== 28 && packetSize !== 72) {
    throw new Error(`ukuran user packet tidak dikenal (${packetSize})`);
  }
  const users: FixtureUser[] = [];
  for (let off = 4; off + packetSize <= data.length; off += packetSize) {
    const rec = data.subarray(off, off + packetSize);
    if (packetSize === 72) {
      users.push({
        uid: rec.readUInt16LE(0),
        privilege: rec.readUInt8(2),
        name: cstr(rec.subarray(11, 35)),
        card: rec.readUInt32LE(35),
        groupId: cstr(rec.subarray(40, 47)),
        idNumber: cstr(rec.subarray(48, 72)),
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
    throw new Error(`user parsed ${users.length}, expected ${expectedUsers}`);
  }
  return users;
}

export function encodeAttendance(
  records: FixtureAttendance[],
  size: AttendancePacketSize = 40,
): Buffer {
  const payload = Buffer.alloc(records.length * size);
  records.forEach((row, index) => {
    const off = index * size;
    const ts = encodeZkTime(row.date, row.time);
    if (size === 40) {
      payload.writeUInt16LE(row.uid & 0xffff, off);
      writeFixed(payload, off + 2, 24, row.idNumber, "idNumber");
      payload[off + 26] = row.verify & 0xff;
      ts.copy(payload, off + 27);
      payload[off + 31] = row.punch & 0xff;
      // 8 reserved bytes are zero
    } else if (size === 16) {
      payload.writeUInt32LE(Number(row.idNumber), off);
      ts.copy(payload, off + 4);
      payload[off + 8] = row.verify & 0xff;
      payload[off + 9] = row.punch & 0xff;
      // reserved 2 + workcode 4 = zero
    } else {
      payload.writeUInt16LE(row.uid & 0xffff, off);
      payload[off + 2] = row.verify & 0xff;
      ts.copy(payload, off + 3);
      payload[off + 7] = row.punch & 0xff;
    }
  });
  return withTotal(payload);
}

export function decodeAttendance(
  data: Buffer,
  expectedRecords: number,
  users: FixtureUser[],
  size?: AttendancePacketSize,
): ParsedAttendance[] {
  if (expectedRecords === 0) return [];
  if (data.length < 4) throw new Error("buffer attendance terlalu pendek");
  const byId = new Map(users.map((u) => [u.idNumber, u.name]));
  const byUid = new Map(users.map((u) => [String(u.uid), u.idNumber]));
  const total = data.readUInt32LE(0);
  const packetSize = size ?? ((total / expectedRecords) as AttendancePacketSize);
  if (![8, 16, 40].includes(packetSize)) {
    throw new Error(`ukuran attendance packet tidak dikenal (${packetSize})`);
  }
  const rows: ParsedAttendance[] = [];
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
      ts = decodeZkTime(rec.subarray(27, 31));
      punch = rec.readUInt8(31);
    } else if (packetSize === 16) {
      idNumber = String(rec.readUInt32LE(0));
      ts = decodeZkTime(rec.subarray(4, 8));
      verify = rec.readUInt8(8);
      punch = rec.readUInt8(9);
    } else {
      uid = rec.readUInt16LE(0);
      verify = rec.readUInt8(2);
      ts = decodeZkTime(rec.subarray(3, 7));
      punch = rec.readUInt8(7);
      idNumber = byUid.get(String(uid)) ?? String(uid);
    }
    const resolvedId = idNumber || String(uid);
    rows.push({
      uid,
      idNumber: resolvedId,
      name: byId.get(resolvedId) ?? resolvedId,
      date: ts.date,
      time: ts.time,
      punch,
      verify,
    });
  }
  if (rows.length !== expectedRecords) {
    throw new Error(`attendance parsed ${rows.length}, expected ${expectedRecords}`);
  }
  return rows;
}

export function userRecordBytes(user: FixtureUser, size: UserPacketSize = 72): Buffer {
  return encodeUsers([user], size).subarray(4);
}

export function attendanceRecordBytes(
  row: FixtureAttendance,
  size: AttendancePacketSize = 40,
): Buffer {
  return encodeAttendance([row], size).subarray(4);
}

export { u16, u32 };
