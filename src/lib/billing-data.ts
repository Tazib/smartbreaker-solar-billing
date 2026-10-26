// Loads tariffs and usage from the database and turns them into bills.
// No "server-only" so the poller can finalise bills too.
import { and, asc, between, desc, eq, inArray, lte, sql, type SQL } from "drizzle-orm";
import { db, schema } from "@/db";
import { addDays, solarSaving, computeBill, cycleFor, daysBetween, daysLeft, marginalCost, type Bill, type Cycle, type MeterCharges, type Tariff } from "@/lib/billing";
import { dhakaDay } from "@/lib/energy";

export type Meter = typeof schema.meters.$inferSelect;
export type TariffVersion = typeof schema.tariffVersions.$inferSelect;

/** The tariff version in force on `day` (falls back to the earliest one). */
export async function tariffFor(planId: string, day: string): Promise<{ version: TariffVersion; tariff: Tariff } | null> {
  const [version] = await db
    .select()
    .from(schema.tariffVersions)
    .where(and(eq(schema.tariffVersions.planId, planId), lte(schema.tariffVersions.effectiveFrom, day)))
    .orderBy(desc(schema.tariffVersions.effectiveFrom))
    .limit(1);
  const chosen =
    version ??
    (
      await db
        .select()
        .from(schema.tariffVersions)
        .where(eq(schema.tariffVersions.planId, planId))
        .orderBy(asc(schema.tariffVersions.effectiveFrom))
        .limit(1)
    )[0];
  if (!chosen) return null;

  const slabs = await db
    .select()
    .from(schema.tariffSlabs)
    .where(eq(schema.tariffSlabs.versionId, chosen.id))
    .orderBy(asc(schema.tariffSlabs.fromKwh));

  return { version: chosen, tariff: toTariff(chosen, slabs) };
}

export function toTariff(v: TariffVersion, slabs: (typeof schema.tariffSlabs.$inferSelect)[]): Tariff {
  return {
    lifelineMaxKwh: v.lifelineMaxKwh === null ? null : Number(v.lifelineMaxKwh),
    lifelineRate: v.lifelineRate === null ? null : Number(v.lifelineRate),
    demandChargePerKw: Number(v.demandChargePerKw),
    vatPercent: Number(v.vatPercent),
    slabs: slabs
      .map((s) => ({ fromKwh: Number(s.fromKwh), toKwh: s.toKwh === null ? null : Number(s.toKwh), rate: Number(s.rate) }))
      .sort((a, b) => a.fromKwh - b.fromKwh),
  };
}

export function meterCharges(m: Meter): MeterCharges {
  return {
    sanctionedLoadKw: Number(m.sanctionedLoadKw),
    meterRent: Number(m.meterRent),
    rebatePercent: Number(m.rebatePercent),
  };
}

/** kWh per device between two days (inclusive). */
export async function deviceKwh(deviceIds: string[], start: string, end: string): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (deviceIds.length === 0) return out;
  const rows = await db
    .select({ deviceId: schema.dailyEnergy.deviceId, kwh: sql<string>`sum(${schema.dailyEnergy.kwh})` })
    .from(schema.dailyEnergy)
    .where(and(inArray(schema.dailyEnergy.deviceId, deviceIds), between(schema.dailyEnergy.day, start, end)))
    .groupBy(schema.dailyEnergy.deviceId);
  for (const r of rows) out.set(r.deviceId, Number(r.kwh));
  return out;
}

/** kWh breakers saw that an inverter fed through an ATS, between two days (inclusive). */
async function atsKwh(where: SQL, start: string, end: string) {
  const [row] = await db
    .select({ kwh: sql<string>`coalesce(sum(${schema.dailyEnergy.inverterKwh}), 0)` })
    .from(schema.dailyEnergy)
    .innerJoin(schema.devices, eq(schema.devices.id, schema.dailyEnergy.deviceId))
    .where(and(where, between(schema.dailyEnergy.day, start, end)));
  return Number(row?.kwh ?? 0);
}

/** Deye totals per station between two days (inclusive). */
export async function stationKwh(stationIds: string[], start: string, end: string) {
  const out = new Map<string, { generation: number; consumption: number; purchase: number; export: number }>();
  if (stationIds.length === 0) return out;
  const d = schema.solarDaily;
  const rows = await db
    .select({
      stationId: d.stationId,
      generation: sql<string>`sum(${d.generationKwh})`,
      consumption: sql<string>`sum(${d.consumptionKwh})`,
      purchase: sql<string>`sum(${d.purchaseKwh})`,
      export: sql<string>`sum(${d.exportKwh})`,
    })
    .from(d)
    .where(and(inArray(d.stationId, stationIds), between(d.day, start, end)))
    .groupBy(d.stationId);
  for (const r of rows)
    out.set(r.stationId, { generation: Number(r.generation), consumption: Number(r.consumption), purchase: Number(r.purchase), export: Number(r.export) });
  return out;
}

/** What unmetered Deye inverters on a meter bought from the grid: their share of the meter's usage. */
async function inverterGridDraw(meterId: string, start: string, end: string) {
  const stations = await db
    .select()
    .from(schema.solarStations)
    .where(and(eq(schema.solarStations.meterId, meterId), eq(schema.solarStations.gridDrawMetered, false)));
  const usage = await stationKwh(stations.map((s) => s.id), start, end);
  return stations.map((s) => ({ stationId: s.id, name: s.name, kwh: usage.get(s.id)?.purchase ?? 0 }));
}

export type SolarResult = { outputKwh: number; inputKwh: number; billWithoutSolar: Bill; saving: number };

export type MeterBill = {
  cycle: Cycle;
  kwh: number;
  bill: Bill;
  tariffVersionId: string;
  solar: SolarResult | null;
  /** First day any of this meter's devices was tracked; set only when that is after the cycle start. */
  partialFrom: string | null;
  /** When the meter's first device started being tracked. */
  trackedSince: Date | null;
  /** Units entered from the utility meter for this cycle (usage the breakers didn't see), or null. */
  adjustmentKwh: number | null;
  /** kWh recorded by the grid breakers alone. */
  trackedKwh: number;
  /** Grid power bought by Deye inverters that no breaker measures (already inside `kwh`). */
  inverterGrid: { stationId: string; name: string; kwh: number }[];
};

/** What a stored bill's breakdown JSON holds. */
export type StoredBreakdown = Bill & { partialFrom?: string | null; adjustmentKwh?: number | null };

/** Units entered for a meter's cycle, or null when none were entered. */
export async function adjustmentFor(meterId: string, cycleStart: string): Promise<number | null> {
  const [row] = await db
    .select({ kwh: schema.meterAdjustments.kwh })
    .from(schema.meterAdjustments)
    .where(and(eq(schema.meterAdjustments.meterId, meterId), eq(schema.meterAdjustments.cycleStart, cycleStart)));
  return row ? Number(row.kwh) : null;
}

/**
 * Bill for one meter over a cycle.
 * Meter kWh = sum of its grid devices (+ entered units, + grid bought by unmetered Deye inverters).
 * Solar saving = bill(meter kWh − inverter input + inverter output) − bill(meter kWh),
 * i.e. what the inverter's loads would have cost straight from the grid. Inverter input/output come
 * from solar breakers, or from Deye ("bought from grid" / "consumption") for linked stations.
 */
export async function meterBill(meter: Meter, cycle: Cycle, endOverride?: string): Promise<MeterBill | null> {
  const t = await tariffFor(meter.tariffPlanId, cycle.start);
  if (!t) return null;
  const end = endOverride ?? cycle.end;

  const meterDevices = await db.select().from(schema.devices).where(eq(schema.devices.meterId, meter.id));
  const stations = await db.select().from(schema.solarStations).where(eq(schema.solarStations.meterId, meter.id));
  const grid = meterDevices.filter((d) => d.source === "grid");
  // A Deye inverter reports both sides itself, so solar breakers on the same meter are ignored.
  const solar = stations.length ? [] : meterDevices.filter((d) => d.source === "solar");
  const inputIds = solar.map((d) => d.inverterInputDeviceId).filter((id): id is string => !!id);

  const usage = await deviceKwh([...grid.map((d) => d.id), ...solar.map((d) => d.id), ...inputIds], cycle.start, end);
  const sum = (ids: string[]) => ids.reduce((s, id) => s + (usage.get(id) ?? 0), 0);

  const deye = await stationKwh(stations.map((s) => s.id), cycle.start, end);
  const inverterGrid = stations
    .filter((s) => !s.gridDrawMetered)
    .map((s) => ({ stationId: s.id, name: s.name, kwh: deye.get(s.id)?.purchase ?? 0 }));

  const trackedKwh = sum(grid.map((d) => d.id));
  const adjustmentKwh = await adjustmentFor(meter.id, cycle.start);
  const kwh = Math.max(trackedKwh + (adjustmentKwh ?? 0) + inverterGrid.reduce((s, x) => s + x.kwh, 0), 0);
  const charges = meterCharges(meter);
  const bill = computeBill(kwh, t.tariff, charges);

  // ATS: load on this meter's breakers that an inverter fed (it would have come through this meter),
  // and load this meter's inverters fed to breakers elsewhere (it would not have come through here).
  const atsIn = await atsKwh(eq(schema.devices.meterId, meter.id), cycle.start, end);
  const atsOut = stations.length ? await atsKwh(inArray(schema.devices.atsStationId, stations.map((s) => s.id)), cycle.start, end) : 0;

  let solarResult: SolarResult | null = null;
  if (solar.length || stations.length || atsIn > 0) {
    const deyeTotal = (key: "consumption" | "purchase") => stations.reduce((s, st) => s + (deye.get(st.id)?.[key] ?? 0), 0);
    // Each meter is valued on its own tariff for the load it would have carried without the inverter.
    const outputKwh = Math.max(sum(solar.map((d) => d.id)) + deyeTotal("consumption") - atsOut + atsIn, 0);
    const inputKwh = sum(inputIds) + deyeTotal("purchase");
    solarResult = { outputKwh, inputKwh, ...solarSaving(kwh, inputKwh, outputKwh, t.tariff, charges) };
  }

  const tracking = [...meterDevices, ...stations].map((x) => x.createdAt.getTime());
  const trackedSince = tracking.length ? new Date(Math.min(...tracking)) : null;
  const firstTracked = trackedSince ? dhakaDay(trackedSince) : null;
  // Entered meter units fill the gap before tracking, so the cycle is complete.
  const partialFrom = adjustmentKwh === null && firstTracked && firstTracked > cycle.start ? firstTracked : null;

  return {
    cycle: { start: cycle.start, end },
    kwh,
    bill,
    tariffVersionId: t.version.id,
    solar: solarResult,
    partialFrom,
    trackedSince,
    adjustmentKwh,
    trackedKwh,
    inverterGrid,
  };
}

export type Projection = MeterBill & {
  /** Calendar progress through the cycle (for "day 7 of 31"). */
  daysElapsed: number;
  daysInCycle: number;
  /** Days the usage figure covers: the whole cycle so far with entered meter units, else since tracking began. */
  trackedDays: number;
  projectedKwh: number;
  projected: Bill;
  /** False until there's a full day of readings; the projection is a rough guess before that. */
  projectionReliable: boolean;
};

const DAY_MS = 86_400_000;

/**
 * Current cycle so far, plus a projection to the cycle end: usage so far plus the average rate
 * since readings began (this cycle) applied to the time left.
 */
export async function currentCycleBill(meter: Meter, now = new Date()): Promise<Projection | null> {
  const today = dhakaDay(now);
  const cycle = cycleFor(today, meter.billingCycleDay);
  const soFar = await meterBill(meter, cycle, today);
  if (!soFar) return null;

  const t = (await tariffFor(meter.tariffPlanId, cycle.start))!;
  const daysInCycle = daysBetween(cycle.start, cycle.end);
  const cycleStart = Date.parse(`${cycle.start}T00:00:00+06:00`);
  const cycleEnd = Date.parse(`${cycle.end}T00:00:00+06:00`) + DAY_MS;
  const daysElapsed = Math.max((now.getTime() - cycleStart) / DAY_MS, 0);

  // With meter units entered, usage covers the whole cycle so far; otherwise only since tracking began.
  const since = soFar.adjustmentKwh !== null ? cycleStart : Math.max(cycleStart, soFar.trackedSince?.getTime() ?? cycleStart);
  const trackedDays = Math.max((now.getTime() - since) / DAY_MS, 0);
  // At least six hours of data before extrapolating, so the first minutes don't explode the estimate.
  const ratePerDay = soFar.kwh / Math.max(trackedDays, 0.25);
  const projectedKwh = soFar.kwh + ratePerDay * Math.max((cycleEnd - now.getTime()) / DAY_MS, 0);

  return {
    ...soFar,
    cycle,
    daysElapsed,
    daysInCycle,
    trackedDays,
    projectedKwh,
    projected: computeBill(projectedKwh, t.tariff, meterCharges(meter)),
    projectionReliable: trackedDays >= 1,
  };
}

/**
 * Stores bills for cycles that have ended and have usage but no stored bill yet.
 * Looks back a few cycles so a poller outage doesn't skip a month.
 */
export async function finalizeBills(now = new Date()): Promise<number> {
  const today = dhakaDay(now);
  const meters = await db.select().from(schema.meters);
  let stored = 0;

  for (const meter of meters) {
    let cycle = cycleFor(today, meter.billingCycleDay);
    for (let i = 0; i < 3; i++) {
      cycle = cycleFor(addDays(cycle.start, -1), meter.billingCycleDay);
      const [existing] = await db
        .select({ id: schema.bills.id })
        .from(schema.bills)
        .where(and(eq(schema.bills.meterId, meter.id), eq(schema.bills.periodStart, cycle.start)));
      if (existing) break;

      const result = await meterBill(meter, cycle);
      if (!result || !(await hasUsage(meter.id, cycle))) continue;

      await db
        .insert(schema.bills)
        .values({
          meterId: meter.id,
          periodStart: cycle.start,
          periodEnd: cycle.end,
          tariffVersionId: result.tariffVersionId,
          kwh: result.kwh.toFixed(3),
          total: result.bill.total.toFixed(2),
          breakdown: { ...result.bill, partialFrom: result.partialFrom, adjustmentKwh: result.adjustmentKwh } satisfies StoredBreakdown,
          solarKwh: result.solar?.outputKwh.toFixed(3),
          solarSaving: result.solar?.saving.toFixed(2),
        })
        .onConflictDoNothing();
      stored++;
    }
  }
  return stored;
}

async function hasUsage(meterId: string, cycle: Cycle) {
  const [solar] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.solarDaily)
    .innerJoin(schema.solarStations, eq(schema.solarStations.id, schema.solarDaily.stationId))
    .where(and(eq(schema.solarStations.meterId, meterId), between(schema.solarDaily.day, cycle.start, cycle.end)));
  if ((solar?.n ?? 0) > 0) return true;
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.dailyEnergy)
    .innerJoin(schema.devices, eq(schema.devices.id, schema.dailyEnergy.deviceId))
    .where(and(eq(schema.devices.meterId, meterId), between(schema.dailyEnergy.day, cycle.start, cycle.end)));
  return (row?.n ?? 0) > 0;
}

// ---------------------------------------------------------------- entered meter units

/** kWh the app recorded on a meter between two days (inclusive): grid breakers plus unmetered inverters. */
async function trackedGridKwh(meterId: string, start: string, end: string) {
  const grid = await db
    .select({ id: schema.devices.id })
    .from(schema.devices)
    .where(and(eq(schema.devices.meterId, meterId), eq(schema.devices.source, "grid")));
  const usage = await deviceKwh(grid.map((d) => d.id), start, end);
  const inverters = await inverterGridDraw(meterId, start, end);
  return [...usage.values()].reduce((a, b) => a + b, 0) + inverters.reduce((a, b) => a + b.kwh, 0);
}

/** The current cycle's usage as the utility meter would show it: breakers plus entered units. */
export async function cycleUsageNow(meterId: string, cycleDay: number, now = new Date()) {
  const today = dhakaDay(now);
  const cycle = cycleFor(today, cycleDay);
  const tracked = await trackedGridKwh(meterId, cycle.start, today);
  const adjustment = await adjustmentFor(meterId, cycle.start);
  return { cycle, tracked, adjustment, total: tracked + (adjustment ?? 0) };
}

/**
 * Records "units used this cycle so far" read off the utility meter. Stores the part the breakers
 * haven't recorded, so later breaker readings add on top without double counting.
 * `null` removes the entry.
 */
export async function setCycleUsage(meterId: string, cycleDay: number, enteredKwh: number | null, now = new Date()) {
  const { cycle, tracked } = await cycleUsageNow(meterId, cycleDay, now);
  if (enteredKwh === null) {
    await db
      .delete(schema.meterAdjustments)
      .where(and(eq(schema.meterAdjustments.meterId, meterId), eq(schema.meterAdjustments.cycleStart, cycle.start)));
    return;
  }
  const missing = enteredKwh - tracked;
  if (missing < -0.05) {
    throw new Error(
      `The breakers have already recorded ${tracked.toFixed(2)} kWh this cycle. Enter the meter's figure, which should be at least that.`,
    );
  }
  const kwh = Math.max(missing, 0).toFixed(3);
  await db
    .insert(schema.meterAdjustments)
    .values({ meterId, cycleStart: cycle.start, kwh })
    .onConflictDoUpdate({
      target: [schema.meterAdjustments.meterId, schema.meterAdjustments.cycleStart],
      set: { kwh, updatedAt: new Date() },
    });
}

// ---------------------------------------------------------------- prepaid balance

export type PrepaidBalance = {
  balanceTk: number;
  anchorTk: number;
  anchorAt: Date;
  rechargedTk: number;
  spentTk: number;
  /** Average spend per day at this cycle's projected pace (fixed charges included). */
  dailySpendTk: number;
  daysLeft: number | null;
  lastRecharge: { at: Date; amountTk: number } | null;
};

/**
 * Estimated balance on a prepaid meter right now:
 * balance read off the meter + recharges since − cost of the units used since.
 * Within the anchor's cycle only the extra units cost money; each later cycle costs its whole bill.
 */
export async function prepaidBalance(meter: Meter, now = new Date()): Promise<PrepaidBalance | null> {
  const [anchor] = await db.select().from(schema.meterBalances).where(eq(schema.meterBalances.meterId, meter.id));
  if (!anchor) return null;

  const recharges = await db
    .select()
    .from(schema.meterRecharges)
    .where(eq(schema.meterRecharges.meterId, meter.id))
    .orderBy(desc(schema.meterRecharges.at));
  const rechargedTk = recharges.filter((r) => r.at > anchor.at).reduce((s, r) => s + Number(r.amountTk), 0);

  const today = dhakaDay(now);
  const current = cycleFor(today, meter.billingCycleDay);
  const charges = meterCharges(meter);
  const anchorKwh = Number(anchor.cycleKwh);
  let spentTk = 0;

  let cycle = cycleFor(anchor.cycleStart, meter.billingCycleDay);
  for (let i = 0; i < 24 && cycle.start <= current.start; i++) {
    const isCurrent = cycle.start === current.start;
    const result = await meterBill(meter, cycle, isCurrent ? today : undefined);
    if (result) {
      if (i === 0) {
        const t = await tariffFor(meter.tariffPlanId, cycle.start);
        if (t) spentTk += marginalCost(anchorKwh, Math.max(result.kwh, anchorKwh), t.tariff, charges);
      } else {
        spentTk += result.bill.total;
      }
    }
    cycle = cycleFor(addDays(cycle.end, 1), meter.billingCycleDay);
  }

  const projection = await currentCycleBill(meter, now);
  const dailySpendTk = projection ? projection.projected.total / projection.daysInCycle : 0;
  const balanceTk = Math.round((Number(anchor.balanceTk) + rechargedTk - spentTk) * 100) / 100;
  const last = recharges[0];

  return {
    balanceTk,
    anchorTk: Number(anchor.balanceTk),
    anchorAt: anchor.at,
    rechargedTk,
    spentTk: Math.round(spentTk * 100) / 100,
    dailySpendTk,
    daysLeft: daysLeft(balanceTk, dailySpendTk),
    lastRecharge: last ? { at: last.at, amountTk: Number(last.amountTk) } : null,
  };
}

/** Records the balance shown on the meter now; recharges before this moment are treated as included. */
export async function setPrepaidBalance(meter: Meter, balanceTk: number, now = new Date()) {
  const { cycle, total } = await cycleUsageNow(meter.id, meter.billingCycleDay, now);
  const row = { balanceTk: balanceTk.toFixed(2), at: now, cycleStart: cycle.start, cycleKwh: total.toFixed(3) };
  await db
    .insert(schema.meterBalances)
    .values({ meterId: meter.id, ...row })
    .onConflictDoUpdate({ target: schema.meterBalances.meterId, set: row });
}
