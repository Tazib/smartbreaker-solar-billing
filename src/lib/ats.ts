// ATS windows: a breaker's circuit is switched onto a Deye inverter for set hours each day. The inverter
// counts that load too, so during the window the breaker's reading is inverter-fed, not grid. Pure functions.
import { formatInTimeZone } from "date-fns-tz";
import { TIMEZONE } from "@/lib/energy";

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
 * Power on the breaker that the inverter is feeding through the ATS: the breaker's whole reading, since
 * the ATS has moved its circuit onto the inverter. Never more than the inverter's total load when Deye
 * has a recent figure (it can't deliver more than it puts out); the breaker's reading alone when not.
 */
export function inverterFedW(breakerW: number, inverterLoadW: number | null) {
  const w = Math.max(breakerW, 0);
  return inverterLoadW === null ? w : Math.min(w, Math.max(inverterLoadW, 0));
}

/** Splits a breaker's kWh for one poll into grid and inverter-fed parts, in proportion to power. */
export function splitDelta(kwh: number, breakerW: number, fedW: number) {
  if (kwh <= 0 || breakerW <= 0 || fedW <= 0) return { grid: kwh, inverter: 0 };
  const inverter = Math.round(kwh * Math.min(fedW / breakerW, 1) * 1000) / 1000;
  return { grid: Math.round((kwh - inverter) * 1000) / 1000, inverter };
}
