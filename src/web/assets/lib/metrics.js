// Pure attendance metrics used by the dashboard. Inputs are API DTOs, not DOM.

import { monthRange, parseTimeSeconds, weekdayIndex } from "./format.js";

const DAY_KEYS = ["SUNDAY", "MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY"];

export function activeIds(employees) {
  return new Set(
    employees.filter((employee) => employee.active).map((employee) => employee.id_number),
  );
}

export function activeCount(employees) {
  return employees.reduce((count, employee) => count + (employee.active ? 1 : 0), 0);
}

function uniqueBy(rows, key) {
  const seen = new Set();
  const result = [];
  for (const row of rows) {
    const value = key(row);
    if (seen.has(value)) continue;
    seen.add(value);
    result.push(row);
  }
  return result;
}

export function todayMetrics(rows, employees, day, isWorkday = true) {
  const active = activeIds(employees);
  const presentRows = rows.filter(
    (row) => row.date === day && row.in_time !== null && active.has(row.id_number),
  );
  const lateRows = presentRows.filter((row) => (row.late_minutes ?? 0) > 0);
  const onTimeRows = presentRows.filter((row) => (row.late_minutes ?? 0) === 0);
  const goneRows = presentRows.filter((row) => row.out_time !== null);
  const notBackRows = presentRows.filter((row) => row.out_time === null);
  const hadir = uniqueBy(presentRows, (row) => row.id_number).length;
  const totalActive = active.size;
  return {
    holiday: !isWorkday,
    active: totalActive,
    hadir,
    belumPulang: notBackRows.length,
    sudahPulang: goneRows.length,
    belumAbsen: Math.max(0, totalActive - hadir),
    late: lateRows.length,
    onTime: onTimeRows.length,
    punctualityPresent:
      presentRows.length === 0 ? null : (presentRows.length - lateRows.length) / presentRows.length,
    punctualityActive:
      totalActive === 0 ? null : (presentRows.length - lateRows.length) / totalActive,
  };
}

export function monthMetrics(rows, employees, monthMap, month, day) {
  const dates = Object.keys(monthMap).sort();
  const workdays = dates.filter((date) => monthMap[date] !== null);
  const elapsedWorkdays = workdays.filter((date) => date <= day);
  const totalActive = activeCount(employees);
  const active = activeIds(employees);
  const presentRows = rows.filter(
    (row) => row.in_time !== null && row.date.startsWith(month) && active.has(row.id_number),
  );
  const lateRows = presentRows.filter((row) => (row.late_minutes ?? 0) > 0);
  const earlyRows = presentRows.filter((row) => (row.early_minutes ?? 0) > 0);
  const lateMinutes = lateRows.reduce((sum, row) => sum + (row.late_minutes ?? 0), 0);
  const uniquePresent = uniqueBy(presentRows, (row) => row.id_number).length;
  const uniqueLate = uniqueBy(lateRows, (row) => row.id_number).length;
  const expected = elapsedWorkdays.length * totalActive;

  const byDate = new Map();
  for (const row of lateRows) {
    const current = byDate.get(row.date) ?? { date: row.date, minutes: 0, lateDays: 0 };
    current.minutes += row.late_minutes ?? 0;
    current.lateDays += 1;
    byDate.set(row.date, current);
  }
  const worstDay =
    [...byDate.values()].sort((a, b) => b.minutes - a.minutes || (a.date < b.date ? -1 : 1))[0] ??
    null;

  const byWeekday = Array.from({ length: 7 }, () => 0);
  for (const row of lateRows) {
    byWeekday[weekdayIndex(row.date)] += row.late_minutes ?? 0;
  }

  return {
    workdaysTotal: workdays.length,
    workdaysElapsed: elapsedWorkdays.length,
    workdaysRemaining: workdays.length - elapsedWorkdays.length,
    daysTotal: dates.length,
    daysElapsed: dates.filter((date) => date <= day).length,
    active: totalActive,
    presentEmployeeDays: presentRows.length,
    uniquePresent,
    uniqueLate,
    lateEmployeeDays: lateRows.length,
    earlyEmployeeDays: earlyRows.length,
    lateMinutes,
    avgLatePerLateDay: lateRows.length === 0 ? null : lateMinutes / lateRows.length,
    punctuality:
      presentRows.length === 0 ? null : (presentRows.length - lateRows.length) / presentRows.length,
    attendanceRate: expected === 0 ? null : presentRows.length / expected,
    expectedEmployeeDays: expected,
    worstDay,
    byWeekday,
    lateRows,
  };
}

// Chart scaling for the Beranda weekday bar chart.
//
// A linear 0..max scale hides differences when every value is high and similar:
// 182, 185, 190 all render within 3% of full height. A log scale keeps small
// values visible, but it is only used when the spread is actually extreme
// (max/min > 10) so an ordinary month stays honest and easy to read. The scale
// always starts at zero; the baseline is never cut.
export const LOG_SPREAD_THRESHOLD = 10;

export function chartScale(values) {
  const positive = values.filter((value) => value > 0);
  const max = Math.max(1, ...values);
  if (positive.length < 2) {
    return {
      mode: "linear",
      max,
      min: positive.length === 0 ? 0 : positive[0],
      heightOf: (value) => (value <= 0 ? 0 : clamp01(value / max)),
    };
  }

  const min = Math.min(...positive);
  const mode = max / min > LOG_SPREAD_THRESHOLD ? "log" : "linear";
  if (mode === "linear") {
    return { mode, max, min, heightOf: (value) => (value <= 0 ? 0 : clamp01(value / max)) };
  }

  // log1p keeps 0 at 0 and compresses the top so small values stay readable.
  const logMax = Math.log1p(max);
  return {
    mode,
    max,
    min,
    heightOf: (value) => (value <= 0 ? 0 : clamp01(Math.log1p(value) / logMax)),
  };
}

function clamp01(value) {
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

export function stableRanking(rows, employees, month, limit = 5) {
  const active = activeIds(employees);
  const names = new Map(employees.map((employee) => [employee.id_number, employee.name]));
  const groups = new Map();

  for (const row of rows) {
    if (!row.date.startsWith(month) || row.in_time === null || !active.has(row.id_number)) {
      continue;
    }
    const group = groups.get(row.id_number) ?? {
      id: row.id_number,
      name: names.get(row.id_number) ?? row.name,
      dates: new Set(),
      inSeconds: 0,
      inCount: 0,
      lateDays: 0,
      earlyDays: 0,
    };
    group.dates.add(row.date);
    const seconds = parseTimeSeconds(row.in_time);
    if (seconds !== null) {
      group.inSeconds += seconds;
      group.inCount += 1;
    }
    if ((row.late_minutes ?? 0) > 0) group.lateDays += 1;
    if ((row.early_minutes ?? 0) > 0) group.earlyDays += 1;
    groups.set(row.id_number, group);
  }

  return [...groups.values()]
    .filter((group) => group.lateDays === 0 && group.earlyDays === 0 && group.dates.size > 0)
    .map((group) => ({
      id: group.id,
      name: group.name,
      days: group.dates.size,
      avgInSeconds: group.inCount === 0 ? null : group.inSeconds / group.inCount,
    }))
    .sort(
      (a, b) =>
        b.days - a.days ||
        (a.avgInSeconds ?? Number.MAX_SAFE_INTEGER) - (b.avgInSeconds ?? Number.MAX_SAFE_INTEGER) ||
        a.name.localeCompare(b.name, "id"),
    )
    .slice(0, limit);
}

// Longest run of late workdays. Calendar holidays are skipped; absence/on-time breaks the run.
export function lateStreakRanking(rows, employees, monthMap, month, today, limit = 5) {
  const active = activeIds(employees);
  const names = new Map(employees.map((employee) => [employee.id_number, employee.name]));
  const workdays = Object.keys(monthMap)
    .filter((date) => date.startsWith(month) && date <= today && monthMap[date] !== null)
    .sort();
  const byEmployee = new Map();

  for (const row of rows) {
    if (!row.date.startsWith(month) || !active.has(row.id_number)) continue;
    let dates = byEmployee.get(row.id_number);
    if (dates === undefined) {
      dates = new Map();
      byEmployee.set(row.id_number, dates);
    }
    dates.set(row.date, row);
  }

  const ranking = [];
  for (const id of active) {
    const dates = byEmployee.get(id) ?? new Map();
    let run = 0;
    let runStart = null;
    let longest = null;
    for (const date of workdays) {
      const row = dates.get(date);
      if ((row?.late_minutes ?? 0) > 0) {
        if (run === 0) runStart = date;
        run += 1;
        if (longest === null || run > longest.days) {
          longest = { days: run, from: runStart, to: date };
        }
      } else {
        run = 0;
        runStart = null;
      }
    }
    if (longest !== null) {
      ranking.push({
        id,
        name: names.get(id) ?? id,
        days: longest.days,
        from: longest.from,
        to: longest.to,
      });
    }
  }

  return ranking
    .sort(
      (a, b) =>
        b.days - a.days ||
        (a.from < b.from ? -1 : a.from > b.from ? 1 : 0) ||
        a.name.localeCompare(b.name, "id"),
    )
    .slice(0, limit);
}

export function lateRanking(rows, employees, month, limit = 5) {
  const active = activeIds(employees);
  const names = new Map(employees.map((employee) => [employee.id_number, employee.name]));
  const groups = new Map();

  for (const row of rows) {
    if (!row.date.startsWith(month) || (row.late_minutes ?? 0) <= 0 || !active.has(row.id_number)) {
      continue;
    }
    const group = groups.get(row.id_number) ?? {
      id: row.id_number,
      name: names.get(row.id_number) ?? row.name,
      dates: new Set(),
      minutes: 0,
      worst: 0,
    };
    group.dates.add(row.date);
    group.minutes += row.late_minutes ?? 0;
    group.worst = Math.max(group.worst, row.late_minutes ?? 0);
    groups.set(row.id_number, group);
  }

  const ranked = [...groups.values()]
    .map((group) => ({
      id: group.id,
      name: group.name,
      lateDays: group.dates.size,
      minutes: group.minutes,
      worst: group.worst,
    }))
    .sort(
      (a, b) =>
        b.lateDays - a.lateDays || b.minutes - a.minutes || a.name.localeCompare(b.name, "id"),
    );

  return limit === null ? ranked : ranked.slice(0, limit);
}

export function workdayCutoff(calendar, month, count) {
  if (count <= 0) return null;
  const range = monthRange(month);
  const last = Number(range.to.slice(8));
  let seen = 0;
  for (let day = 1; day <= last; day += 1) {
    const date = `${month}-${String(day).padStart(2, "0")}`;
    if (resolveClient(calendar, date) === null) continue;
    seen += 1;
    if (seen >= count) return date;
  }
  return null;
}

export function withRankMovement(current, previous) {
  const previousRank = new Map(previous.map((item, index) => [item.id, index + 1]));
  return current.map((item, index) => {
    const from = previousRank.get(item.id);
    return {
      ...item,
      movement: from === undefined ? null : from - (index + 1),
    };
  });
}

export function resolveClient(calendar, date) {
  const [year, month, day] = date.split("-").map(Number);
  const key = DAY_KEYS[new Date(Date.UTC(year, month - 1, day)).getUTCDay()];
  let chosen = null;
  for (const override of calendar.overrides ?? []) {
    if (override.from <= date && date <= override.to) {
      if (chosen === null || override.priority > chosen.priority) chosen = override;
    }
  }
  if (chosen !== null) {
    return chosen.schedule === null ? null : (chosen.schedule[key] ?? null);
  }
  return calendar.base[key] ?? null;
}

function dateRange(from, to) {
  const result = [];
  let current = from;
  while (current <= to && result.length < 4000) {
    result.push(current);
    const [year, month, day] = current.split("-").map(Number);
    current = new Date(Date.UTC(year, month - 1, day + 1)).toISOString().slice(0, 10);
  }
  return result;
}

export function scheduleImpact(before, after, day) {
  const dates = [...(before.overrides ?? []), ...(after.overrides ?? [])].map((item) => item.to);
  const baseToParts = day.split("-").map(Number);
  const plusThirty = new Date(Date.UTC(baseToParts[0], baseToParts[1] - 1, baseToParts[2] + 30))
    .toISOString()
    .slice(0, 10);
  const horizon = dates.reduce((max, value) => (value > max ? value : max), plusThirty);
  const added = [];
  const removed = [];
  const changed = [];

  for (const date of dateRange(day, horizon)) {
    const previous = resolveClient(before, date);
    const next = resolveClient(after, date);
    if (previous === null && next !== null) added.push(date);
    else if (previous !== null && next === null) removed.push(date);
    else if (
      previous !== null &&
      next !== null &&
      (previous.in !== next.in || previous.out !== next.out)
    ) {
      changed.push(date);
    }
  }

  return {
    from: day,
    to: horizon,
    added: added.length,
    removed: removed.length,
    changed: changed.length,
    samples: [
      ...added.slice(0, 3).map((date) => `${date} masuk`),
      ...removed.slice(0, 3).map((date) => `${date} libur`),
      ...changed.slice(0, 3).map((date) => `${date} berubah`),
    ],
  };
}

export function expiredOverrides(calendar, day) {
  return (calendar.overrides ?? []).filter((override) => override.to < day);
}
