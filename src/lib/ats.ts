// ATS windows: part of a breaker's load is switched onto a Deye inverter for set hours each day.
// The inverter counts that load too, so it is taken out of the breaker's grid usage. Pure functions.
import { formatInTimeZone } from "date-fns-tz";
import { TIMEZONE } from "@/lib/energy";

/** How far back from the window start the inverter's usual load is averaged. */
export const BASELINE_MINUTES = 30;

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function isTime(v: string) {
  return HHMM.test(v);
}

const minutesOf = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/** Dhaka time of day of `now`, in minutes since midnight. */
function dhakaMinutes(now: Date) {
  return minutesOf(formatInTimeZone(now, TIMEZONE, "HH:mm"));
}

/**
 * The start of the window `now` falls in, or null when it's outside the window.
 * A window whose end is earlier than its start runs past midnight (e.g. 22:00 → 06:00).
 */
export function atsWindowStart(now: Date, start: string, end: string): Date | null {
  if (!isTime(start) || !isTime(end) || start === end) return null;
  const s = minutesOf(start);
  const e = minutesOf(end);
  const m = dhakaMinutes(now);
  const inside = s < e ? m >= s && m < e : m >= s || m < e;
  if (!inside) return null;
  // Minutes since the window opened (wrapping past midnight), counted back from now.
  const since = (m - s + 1440) % 1440;
  return new Date(Math.floor((now.getTime() - since * 60_000) / 60_000) * 60_000);
}

/**
 * Power on the breaker that the inverter is feeding through the ATS: how much the inverter's load rose
 * over its usual (pre-window) level, never more than the breaker itself reads.
 */
export function inverterFedW(breakerW: number, inverterLoadW: number, baselineW: number) {
  return Math.min(Math.max(breakerW, 0), Math.max(inverterLoadW - baselineW, 0));
}

/** Splits a breaker's kWh for one poll into grid and inverter-fed parts, in proportion to power. */
export function splitDelta(kwh: number, breakerW: number, fedW: number) {
  if (kwh <= 0 || breakerW <= 0 || fedW <= 0) return { grid: kwh, inverter: 0 };
  const inverter = Math.round(kwh * Math.min(fedW / breakerW, 1) * 1000) / 1000;
  return { grid: Math.round((kwh - inverter) * 1000) / 1000, inverter };
}
