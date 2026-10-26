import { describe, expect, it } from "vitest";
import {
  addDays,
  allocateCost,
  computeBill,
  cycleFor,
  daysBetween,
  daysLeft,
  fixedCharges,
  marginalCost,
  nextPriceStep,
  previousCycle,
  solarSaving,
  type Tariff,
} from "@/lib/billing";

// BERC LT-A residential, June 2026.
const tariff: Tariff = {
  lifelineMaxKwh: 50,
  lifelineRate: 4.63,
  demandChargePerKw: 42,
  vatPercent: 5,
  slabs: [
    { fromKwh: 0, toKwh: 75, rate: 5.26 },
    { fromKwh: 75, toKwh: 200, rate: 8.5 },
    { fromKwh: 200, toKwh: 300, rate: 9.1 },
    { fromKwh: 300, toKwh: 400, rate: 9.62 },
    { fromKwh: 400, toKwh: 600, rate: 15.01 },
    { fromKwh: 600, toKwh: null, rate: 17.35 },
  ],
};
const meter = { sanctionedLoadKw: 2, meterRent: 40, rebatePercent: 0.5 };
const plain = { sanctionedLoadKw: 0, meterRent: 0, rebatePercent: 0 };

describe("computeBill", () => {
  it("bills each slab at its own rate (telescopic)", () => {
    const b = computeBill(250, tariff, meter);
    expect(b.lines.map((l) => [l.kwh, l.amount])).toEqual([
      [75, 394.5],
      [125, 1062.5],
      [50, 455],
    ]);
    expect(b.energyCharge).toBe(1912);
    expect(b.demandCharge).toBe(84);
    expect(b.rebate).toBe(9.98); // 0.5% of 1996
    expect(b.vat).toBe(99.3); // 5% of 1986.02
    expect(b.total).toBe(2125.32);
  });

  it("uses the lifeline rate for every unit at or under the limit", () => {
    const b = computeBill(50, tariff, plain);
    expect(b.lifeline).toBe(true);
    expect(b.energyCharge).toBe(231.5);
  });

  it("re-prices every unit on the slabs once over the lifeline limit", () => {
    const b = computeBill(51, tariff, plain);
    expect(b.lifeline).toBe(false);
    expect(b.energyCharge).toBe(268.26);
  });

  it("charges fixed costs even with no usage and never goes negative", () => {
    expect(computeBill(0, tariff, meter).total).toBe(127.76); // 84 × 0.995 × 1.05 + 40
    expect(computeBill(-5, tariff, plain).total).toBe(0);
  });

  it("handles the open-ended top slab", () => {
    const b = computeBill(700, tariff, plain);
    expect(b.lines.at(-1)).toMatchObject({ fromKwh: 600, toKwh: null, kwh: 100, rate: 17.35 });
  });
});

describe("nextPriceStep", () => {
  it("counts down to the end of the lifeline band", () => {
    expect(nextPriceStep(40, tariff)).toEqual({ unitsLeft: 10, nextRate: 5.26, currentRate: 4.63 });
  });
  it("counts down to the next slab", () => {
    expect(nextPriceStep(250, tariff)).toEqual({ unitsLeft: 50, nextRate: 9.62, currentRate: 9.1 });
  });
  it("returns null on the top slab", () => {
    expect(nextPriceStep(700, tariff)).toBeNull();
  });
});

describe("billing cycles", () => {
  it("uses the calendar month when the cycle starts on day 1", () => {
    expect(cycleFor("2026-10-07", 1)).toEqual({ start: "2026-10-01", end: "2026-10-31" });
    expect(cycleFor("2026-02-15", 1)).toEqual({ start: "2026-02-01", end: "2026-02-28" });
  });
  it("runs from the cycle day to the day before it next month", () => {
    expect(cycleFor("2026-10-07", 15)).toEqual({ start: "2026-09-15", end: "2026-10-14" });
    expect(cycleFor("2026-10-15", 15)).toEqual({ start: "2026-10-15", end: "2026-11-14" });
  });
  it("crosses the year boundary", () => {
    expect(previousCycle(cycleFor("2026-01-07", 1), 1)).toEqual({ start: "2025-12-01", end: "2025-12-31" });
  });
  it("counts days inclusively", () => {
    expect(daysBetween("2026-10-01", "2026-10-31")).toBe(31);
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
  });
});

describe("prepaid balance maths", () => {
  it("marginal cost ignores fixed charges", () => {
    // 60 → 80 kWh: crosses into 8.50 slab; fixed parts cancel.
    const diff = computeBill(80, tariff, meter).total - computeBill(60, tariff, meter).total;
    expect(marginalCost(60, 80, tariff, meter)).toBeCloseTo(diff, 2);
    expect(marginalCost(60, 60, tariff, meter)).toBe(0);
  });

  it("fixed charges are demand (after rebate, with VAT) plus rent", () => {
    const b = computeBill(100, tariff, meter);
    expect(fixedCharges(b, tariff, meter)).toBe(127.76);
  });

  it("days left divides balance by daily spend, clamping negatives", () => {
    expect(daysLeft(300, 50)).toBe(6);
    expect(daysLeft(-20, 50)).toBe(0);
    expect(daysLeft(300, 0)).toBeNull();
  });
});

describe("allocateCost", () => {
  it("splits the usage part by kWh and keeps fixed charges apart", () => {
    const bill = computeBill(250, tariff, meter);
    const { fixed, shares } = allocateCost(bill, tariff, meter, [
      { key: "ac", label: "AC", kwh: 150 },
      { key: "rest", label: "Rest", kwh: 100 },
    ]);
    expect(fixed).toBe(127.76);
    const variable = bill.total - fixed;
    expect(shares[0].tk).toBeCloseTo(variable * 0.6, 1);
    expect(shares[1].tk).toBeCloseTo(variable * 0.4, 1);
    expect(fixed + shares[0].tk + shares[1].tk).toBeCloseTo(bill.total, 1);
  });

  it("gives zero shares when nothing was used", () => {
    const bill = computeBill(0, tariff, meter);
    const { shares } = allocateCost(bill, tariff, meter, [{ key: "a", label: "A", kwh: 0 }]);
    expect(shares[0].tk).toBe(0);
  });
});

describe("solarSaving", () => {
  // A month: 150 kWh of other loads + 45 kWh drawn by the inverter = 195 kWh on the meter.
  // The inverter delivered 180 kWh to its loads (solar + battery covered the difference).
  it("values the solar output at the household's marginal slab rates", () => {
    const { billWithoutSolar, saving } = solarSaving(195, 45, 180, tariff, meter);
    expect(billWithoutSolar.kwh).toBe(330); // 195 − 45 + 180
    expect(saving).toBeCloseTo(billWithoutSolar.total - computeBill(195, tariff, meter).total, 2);
    expect(saving).toBeGreaterThan(1000); // keeps the house out of the 300–400 slab
  });

  it("is zero when the inverter only passes grid power through", () => {
    expect(solarSaving(120, 30, 30, tariff, meter).saving).toBe(0);
  });

  it("can be negative when the inverter drew more than it delivered (battery charging)", () => {
    expect(solarSaving(100, 20, 5, tariff, meter).saving).toBeLessThan(0);
  });

  it("captures slab effects: keeping a month on the lifeline rate is worth more than the units alone", () => {
    // With solar: 45 kWh on the meter (lifeline). Without: 65 kWh, priced on the slabs for every unit.
    const { saving } = solarSaving(45, 0, 20, tariff, plain);
    expect(saving).toBeCloseTo(65 * 5.26 * 1.05 - 45 * 4.63 * 1.05, 1);
  });
});

describe("solarSaving with Deye figures (no breakers on the inverter)", () => {
  // Breakers saw 150 kWh of other loads. Deye says the inverter bought 40 kWh from the grid and its
  // loads used 220 kWh. With the grid draw added, the meter reads 190 kWh.
  it("is the bill for meter − bought + home use, minus the real bill", () => {
    const meterKwh = 150 + 40;
    const { billWithoutSolar, saving } = solarSaving(meterKwh, 40, 220, tariff, meter);
    expect(billWithoutSolar.kwh).toBe(370);
    expect(saving).toBeCloseTo(computeBill(370, tariff, meter).total - computeBill(190, tariff, meter).total, 2);
  });

  it("is zero on a day with no sun when everything came from the grid", () => {
    expect(solarSaving(190, 40, 40, tariff, meter).saving).toBe(0);
  });
});

describe("solar saving with an ATS moving a house onto another meter's inverter", () => {
  // Server room meter: 120 kWh, inverter bought 30 kWh and its loads used 200 kWh, of which 60 kWh was the
  // house (switched over by the ATS). House meter: 180 kWh on the grid after the 60 kWh were taken off.
  const server = { meterKwh: 120, bought: 30, inverterLoad: 200, ats: 60 };
  const house = { meterKwh: 180 };

  it("values each share on the meter it would have gone through", () => {
    const serverSaving = solarSaving(server.meterKwh, server.bought, server.inverterLoad - server.ats, tariff, meter).saving;
    const houseSaving = solarSaving(house.meterKwh, 0, server.ats, tariff, meter).saving;
    // Without the inverter: server room 120 − 30 + 140 = 230 kWh, house 180 + 60 = 240 kWh.
    const expected =
      computeBill(230, tariff, meter).total - computeBill(120, tariff, meter).total +
      (computeBill(240, tariff, meter).total - computeBill(180, tariff, meter).total);
    expect(serverSaving + houseSaving).toBeCloseTo(expected, 2);
  });
});
