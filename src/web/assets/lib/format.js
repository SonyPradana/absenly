// Display formatting. Dates are WIB/YMD strings and are never reparsed as UTC.

const MONTHS = [
  "Januari",
  "Februari",
  "Maret",
  "April",
  "Mei",
  "Juni",
  "Juli",
  "Agustus",
  "September",
  "Oktober",
  "November",
  "Desember",
];

const MONTHS_SHORT = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "Mei",
  "Jun",
  "Jul",
  "Agu",
  "Sep",
  "Okt",
  "Nov",
  "Des",
];

const WEEKDAYS = ["Senin", "Selasa", "Rabu", "Kamis", "Jumat", "Sabtu", "Minggu"];
const WEEKDAYS_SHORT = ["Sen", "Sel", "Rab", "Kam", "Jum", "Sab", "Min"];

export function pad(value) {
  return String(value).padStart(2, "0");
}

export function formatDate(value) {
  if (!value) return "—";
  const [year, month, day] = value.split("-");
  if (!year || !month || !day) return value;
  return `${day}/${month}/${year}`;
}

export function formatDateShort(value) {
  if (!value) return "—";
  const [, month, day] = value.split("-");
  return `${Number(day)} ${MONTHS_SHORT[Number(month) - 1] ?? month}`;
}

export function formatTime(value) {
  return value ?? "—";
}

export function formatDateTime(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("id-ID", {
    timeZone: "Asia/Jakarta",
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

export function formatWibTime(date = new Date()) {
  return new Intl.DateTimeFormat("id-ID", {
    timeZone: "Asia/Jakarta",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date);
}

export function formatPercent(value) {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  return `${Math.round(value * 100)}%`;
}

export function formatMinutes(value) {
  if (value === null || value === undefined) return "—";
  const total = Math.max(0, Math.round(value));
  if (total < 60) return `${total} mnt`;
  const hours = Math.floor(total / 60);
  const minutes = total % 60;
  return minutes === 0 ? `${hours} jam` : `${hours} jam ${minutes} mnt`;
}

export function formatSeconds(seconds) {
  if (seconds === null || seconds === undefined || Number.isNaN(seconds)) return "—";
  const total = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  return `${pad(minutes)}:${pad(rest)}`;
}

export function parseTimeSeconds(value) {
  if (!value) return null;
  const [hour, minute, second = "0"] = value.split(":");
  const h = Number(hour);
  const m = Number(minute);
  const s = Number(second);
  if (![h, m, s].every(Number.isFinite)) return null;
  return h * 3600 + m * 60 + s;
}

export function monthLabel(month) {
  if (!month) return "—";
  const [year, index] = month.split("-");
  return `${MONTHS[Number(index) - 1] ?? month} ${year}`;
}

export function monthShort(month) {
  if (!month) return "—";
  const [year, index] = month.split("-");
  return `${MONTHS_SHORT[Number(index) - 1] ?? month} ${year}`;
}

export function daysInMonth(month) {
  const [year, index] = month.split("-").map(Number);
  return new Date(Date.UTC(year, index, 0)).getUTCDate();
}

export function weekdayIndex(date) {
  const [year, month, day] = date.split("-").map(Number);
  const utc = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return (utc + 6) % 7;
}

export function weekdayName(index) {
  return WEEKDAYS[index] ?? "—";
}

export function weekdayShort(index) {
  return WEEKDAYS_SHORT[index] ?? "—";
}

export function weekdayForDate(date) {
  return weekdayIndex(date);
}

export function todayWib() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jakarta",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const get = (type) => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

export function addDays(date, days) {
  const [year, month, day] = date.split("-").map(Number);
  const next = new Date(Date.UTC(year, month - 1, day + days));
  return next.toISOString().slice(0, 10);
}

export function monthRange(month) {
  return { from: `${month}-01`, to: `${month}-${pad(daysInMonth(month))}` };
}
