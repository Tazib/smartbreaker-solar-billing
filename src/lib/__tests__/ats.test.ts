import { describe, expect, it } from "vitest";
import { atsWindowStart, inverterFedW, isTime, splitDelta } from "@/lib/ats";

// Dhaka is UTC+6.
const dhaka = (hhmm: string, day = "2026-10-26") => new Date(`${day}T${hhmm}:20+06:00`);

describe("atsWindowStart", () => {
  it("finds the start of a daytime window", () => {
    expect(atsWindowStart(dhaka("13:45"), "10:00", "16:00")?.toISOString()).toBe(new Date("2026-10-26T10:00:00+06:00").toISOString());
  });

  it("is null outside the window, and the end time is outside", () => {
    expect(atsWindowStart(dhaka("09:59"), "10:00", "16:00")).toBeNull();
    expect(atsWindowStart(dhaka("16:00"), "10:00", "16:00")).toBeNull();
  });

  it("handles windows that run past midnight", () => {
    expect(atsWindowStart(dhaka("23:30"), "22:00", "06:00")?.toISOString()).toBe(new Date("2026-10-26T22:00:00+06:00").toISOString());
    expect(atsWindowStart(dhaka("03:10", "2026-10-27"), "22:00", "06:00")?.toISOString()).toBe(
      new Date("2026-10-26T22:00:00+06:00").toISOString(),
    );
    expect(atsWindowStart(dhaka("12:00"), "22:00", "06:00")).toBeNull();
  });

  it("ignores bad or empty windows", () => {
    expect(atsWindowStart(dhaka("12:00"), "10:00", "10:00")).toBeNull();
    expect(atsWindowStart(dhaka("12:00"), "25:00", "16:00")).toBeNull();
    expect(isTime("9:30")).toBe(false);
    expect(isTime("09:30")).toBe(true);
  });
});

describe("inverterFedW", () => {
  it("is the breaker's whole reading while the ATS has it on the inverter", () => {
    expect(inverterFedW(800, 1500)).toBe(800);
  });

  it("never exceeds the inverter's total load", () => {
    expect(inverterFedW(900, 600)).toBe(600);
  });

  it("uses the breaker's reading when Deye has nothing recent", () => {
    expect(inverterFedW(800, null)).toBe(800);
  });
});

describe("splitDelta", () => {
  it("moves the inverter-fed share out of grid kWh", () => {
    expect(splitDelta(0.02, 1200, 800)).toEqual({ grid: 0.007, inverter: 0.013 });
  });

  it("leaves everything as grid when nothing is inverter-fed", () => {
    expect(splitDelta(0.02, 1200, 0)).toEqual({ grid: 0.02, inverter: 0 });
  });

  it("can move all of it", () => {
    expect(splitDelta(0.02, 500, 500)).toEqual({ grid: 0, inverter: 0.02 });
  });
});
