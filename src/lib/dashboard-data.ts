import "server-only";
import { and, between, desc, eq, gte, inArray, sql, type AnyColumn } from "drizzle-orm";
import { db, schema } from "@/db";
import { addDays, allocateCost, nextPriceStep, type CostShare, type Tariff } from "@/lib/billing";
import {
  currentCycleBill,
  deviceKwh,
  meterCharges,
  prepaidBalance,
  stationKwh,
  tariffFor,
  type PrepaidBalance,
  type Projection,
} from "@/lib/billing-data";
import { dhakaDay } from "@/lib/energy";
import { inverterOwnSupply } from "@/lib/deye/decode";

type Device = typeof schema.devices.$inferSelect;
type Meter = typeof schema.meters.$inferSelect;
type Reading = typeof schema.readings.$inferSelect;

// A reading older than this is not "live".
const LIVE_WINDOW_MS = 5 * 60_000;
// Deye loggers upload every ~5 minutes and the poller asks every 5, so allow more slack.
const SOLAR_LIVE_WINDOW_MS = 15 * 60_000;
const BUCKET_SECONDS = 300;

export type DayPoint = { day: string; grid: number; solar: number };
export type PowerPoint = { ts: number; grid: number | null; solar: number | null };

export type MeterDashboard = {
  meter: Meter;
  devices: (Device & { live: Reading | null; todayKwh: number })[];
  liveGridW: number | null;
  liveSolarW: number | null;
  lastSolarAt: number | null;
  hasSolar: boolean;
  todayGridKwh: number;
  todaySolarKwh: number;
  cycle: Projection | null;
  tariff: Tariff | null;
  nextStep: ReturnType<typeof nextPriceStep>;
  balance: PrepaidBalance | null;
  /** This cycle's bill split by breaker (plus entered units); fixed charges separately. */
  costs: { fixed: number; shares: CostShare[] } | null;
  daily: DayPoint[];
  monthly: { month: string; grid: number; solar: number }[];
  power: PowerPoint[];
};

export async function profileDashboard(profileId: string, now = new Date()): Promise<MeterDashboard[]> {
  const meters = await db.select().from(schema.meters).where(eq(schema.meters.profileId, profileId)).orderBy(schema.meters.meterNo);
  if (meters.length === 0) return [];
  const devices = await db
    .select()
    .from(schema.devices)
    .where(inArray(schema.devices.meterId, meters.map((m) => m.id)))
    .orderBy(schema.devices.name);
  const ids = devices.map((d) => d.id);
  const stations = await db
    .select()
    .from(schema.solarStations)
    .where(inArray(schema.solarStations.meterId, meters.map((m) => m.id)));
  const stationIds = stations.map((s) => s.id);

  const today = dhakaDay(now);
  const dayStart = new Date(`${today}T00:00:00+06:00`);
  const from30 = addDays(today, -29);
  const from12m = `${addDays(`${today.slice(0, 7)}-01`, -320).slice(0, 7)}-01`;

  const [latest, daily, monthly, power] = ids.length
    ? await Promise.all([
        db
          .selectDistinctOn([schema.readings.deviceId])
          .from(schema.readings)
          .where(and(inArray(schema.readings.deviceId, ids), gte(schema.readings.ts, new Date(now.getTime() - 86_400_000))))
          .orderBy(schema.readings.deviceId, desc(schema.readings.ts)),
        db
          .select({ deviceId: schema.dailyEnergy.deviceId, day: schema.dailyEnergy.day, kwh: schema.dailyEnergy.kwh })
          .from(schema.dailyEnergy)
          .where(and(inArray(schema.dailyEnergy.deviceId, ids), between(schema.dailyEnergy.day, from30, today))),
        db
          .select({
            deviceId: schema.dailyEnergy.deviceId,
            month: sql<string>`to_char(${schema.dailyEnergy.day}, 'YYYY-MM')`,
            kwh: sql<string>`sum(${schema.dailyEnergy.kwh})`,
          })
          .from(schema.dailyEnergy)
          .where(and(inArray(schema.dailyEnergy.deviceId, ids), gte(schema.dailyEnergy.day, from12m)))
          .groupBy(schema.dailyEnergy.deviceId, sql`2`),
        db
          .select({
            deviceId: schema.readings.deviceId,
            bucket: sql<number>`(floor(extract(epoch from ${schema.readings.ts}) / ${sql.raw(String(BUCKET_SECONDS))}) * ${sql.raw(String(BUCKET_SECONDS))})::bigint`,
            // Grid only: minus any part an inverter feeds through an ATS.
            powerW: sql<number | null>`avg(${schema.readings.powerW} - coalesce(${schema.readings.inverterW}, 0))`,
          })
          .from(schema.readings)
          .where(and(inArray(schema.readings.deviceId, ids), gte(schema.readings.ts, dayStart)))
          .groupBy(schema.readings.deviceId, sql`2`),
      ])
    : [[], [], [], []];

  const solar = stationIds.length ? await solarSeries(stationIds, now) : null;

  return Promise.all(
    meters.map(async (meter) => {
      const own = devices.filter((d) => d.meterId === meter.id);
      const ownStations = stations.filter((s) => s.meterId === meter.id);
      const isGrid = new Set(own.filter((d) => d.source === "grid").map((d) => d.id));
      // With a Deye inverter on the meter, its figures replace any solar breaker (same as the bill).
      const isSolar = new Set(ownStations.length ? [] : own.filter((d) => d.source === "solar").map((d) => d.id));
      const ownIds = new Set(own.map((d) => d.id));

      const withLive = own.map((d) => {
        const r = latest.find((x) => x.deviceId === d.id) ?? null;
        const live = r && now.getTime() - r.ts.getTime() < LIVE_WINDOW_MS ? r : null;
        const todayKwh = daily.filter((x) => x.deviceId === d.id && x.day === today).reduce((s, x) => s + Number(x.kwh), 0);
        return { ...d, live, todayKwh };
      });

      const livePower = (set: Set<string>) => {
        const rows = withLive.filter((d) => set.has(d.id) && d.live?.powerW != null);
        // Grid breakers: leave out what an inverter feeds through an ATS (it is counted on the inverter).
        return rows.length ? rows.reduce((s, d) => s + d.live!.powerW! - (isGrid.has(d.id) ? (d.live!.inverterW ?? 0) : 0), 0) : null;
      };

      // Deye inverters: solar = panel output; grid = what an unmetered inverter buys (no breaker sees it).
      const isStation = new Set(ownStations.map((s) => s.id));
      const unmetered = new Set(ownStations.filter((s) => !s.gridDrawMetered).map((s) => s.id));
      const stationLive = (solar?.latest ?? []).filter((r) => isStation.has(r.stationId) && now.getTime() - r.ts.getTime() < SOLAR_LIVE_WINDOW_MS);
      // Solar breakers: output minus what the inverter drew from the grid = what solar/battery supplied.
      const breakerOwnSupply = () => {
        const out = livePower(isSolar);
        if (out === null) return null;
        const inputs = new Set(own.filter((d) => isSolar.has(d.id) && d.inverterInputDeviceId).map((d) => d.inverterInputDeviceId!));
        return Math.max(out - (livePower(inputs) ?? 0), 0);
      };
      const deyeDay = (day: string, set: Set<string>, key: "generation" | "purchase") =>
        (solar?.daily ?? []).filter((x) => x.day === day && set.has(x.stationId)).reduce((s, x) => s + x[key], 0);
      const deyeMonth = (month: string, set: Set<string>, key: "generation" | "purchase") =>
        (solar?.monthly ?? []).filter((x) => x.month === month && set.has(x.stationId)).reduce((s, x) => s + x[key], 0);

      // Daily series, every day present even when zero.
      const dailyPoints: DayPoint[] = [];
      for (let day = from30; day <= today; day = addDays(day, 1)) {
        const rows = daily.filter((x) => x.day === day && ownIds.has(x.deviceId));
        dailyPoints.push({
          day,
          grid: round(rows.filter((x) => isGrid.has(x.deviceId)).reduce((s, x) => s + Number(x.kwh), 0) + deyeDay(day, unmetered, "purchase")),
          solar: round(rows.filter((x) => isSolar.has(x.deviceId)).reduce((s, x) => s + Number(x.kwh), 0) + deyeDay(day, isStation, "generation")),
        });
      }

      const months: { month: string; grid: number; solar: number }[] = [];
      for (let m = from12m.slice(0, 7); m <= today.slice(0, 7); m = addDays(`${m}-28`, 7).slice(0, 7)) {
        const rows = monthly.filter((x) => x.month === m && ownIds.has(x.deviceId));
        months.push({
          month: m,
          grid: round(rows.filter((x) => isGrid.has(x.deviceId)).reduce((s, x) => s + Number(x.kwh), 0) + deyeMonth(m, unmetered, "purchase")),
          solar: round(rows.filter((x) => isSolar.has(x.deviceId)).reduce((s, x) => s + Number(x.kwh), 0) + deyeMonth(m, isStation, "generation")),
        });
      }

      // Power curve: average per device per bucket, summed across devices.
      const buckets = new Map<number, { grid: number | null; solar: number | null }>();
      for (const r of power) {
        if (!ownIds.has(r.deviceId) || r.powerW === null) continue;
        const key = Number(r.bucket) * 1000;
        const b = buckets.get(key) ?? { grid: null, solar: null };
        if (isGrid.has(r.deviceId)) b.grid = (b.grid ?? 0) + Number(r.powerW);
        if (isSolar.has(r.deviceId)) b.solar = (b.solar ?? 0) + Number(r.powerW);
        buckets.set(key, b);
      }
      for (const r of solar?.power ?? []) {
        if (!isStation.has(r.stationId)) continue;
        const b = buckets.get(r.ts) ?? { grid: null, solar: null };
        const supply = inverterOwnSupply(r);
        if (supply !== null) b.solar = (b.solar ?? 0) + supply;
        if (unmetered.has(r.stationId) && r.gridW !== null) b.grid = (b.grid ?? 0) + Math.max(r.gridW, 0);
        buckets.set(r.ts, b);
      }
      const powerPoints = [...buckets.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([ts, b]) => ({ ts, grid: b.grid === null ? null : Math.round(b.grid), solar: b.solar === null ? null : Math.round(b.solar) }));

      const cycle = await currentCycleBill(meter, now);
      const t = cycle ? await tariffFor(meter.tariffPlanId, cycle.cycle.start) : null;

      let costs: MeterDashboard["costs"] = null;
      if (cycle && t) {
        const gridDevices = own.filter((d) => d.source === "grid");
        const used = await deviceKwh(gridDevices.map((d) => d.id), cycle.cycle.start, today);
        costs = allocateCost(cycle.bill, t.tariff, meterCharges(meter), [
          ...gridDevices.map((d) => ({ key: d.id, label: d.name, kwh: used.get(d.id) ?? 0 })),
          ...cycle.inverterGrid.map((x) => ({ key: `inverter-${x.stationId}`, label: `${x.name} (from grid)`, kwh: x.kwh })),
          ...(cycle.adjustmentKwh ? [{ key: `before-${meter.id}`, label: "Before tracking (entered)", kwh: cycle.adjustmentKwh }] : []),
        ]);
      }
      const balance = meter.connectionType === "prepaid" ? await prepaidBalance(meter, now) : null;

      return {
        meter,
        devices: withLive,
        liveGridW: sumNullable([
          livePower(isGrid),
          sumNullable(stationLive.filter((r) => unmetered.has(r.stationId)).map((r) => (r.gridW === null ? null : Math.max(r.gridW, 0)))),
        ]),
        liveSolarW: sumNullable([breakerOwnSupply(), sumNullable(stationLive.map(inverterOwnSupply))]),
        lastSolarAt: stationLive.reduce<number | null>((t, r) => Math.max(t ?? 0, r.ts.getTime()), null),
        hasSolar: isSolar.size > 0 || isStation.size > 0,
        todayGridKwh: round(withLive.filter((d) => isGrid.has(d.id)).reduce((s, d) => s + d.todayKwh, 0) + deyeDay(today, unmetered, "purchase")),
        todaySolarKwh: round(withLive.filter((d) => isSolar.has(d.id)).reduce((s, d) => s + d.todayKwh, 0) + deyeDay(today, isStation, "generation")),
        cycle,
        tariff: t?.tariff ?? null,
        nextStep: cycle && t ? nextPriceStep(cycle.kwh, t.tariff) : null,
        balance,
        costs,
        daily: dailyPoints,
        monthly: months,
        power: powerPoints,
      };
    }),
  );
}

function round(n: number) {
  return Math.round(n * 100) / 100;
}


// ---------------------------------------------------------------- Deye inverters

type SolarReading = typeof schema.solarReadings.$inferSelect;
type SolarBucket = { stationId: string; ts: number } & Record<"generationW" | "consumptionW" | "gridW" | "batteryW" | "batterySoc", number | null>;
type SolarDayRow = { stationId: string; day: string } & Record<"generation" | "consumption" | "purchase" | "export" | "charge" | "discharge", number>;

/** Latest snapshot, today's 5-minute power, 30 days and 12 months of Deye totals for some stations. */
async function solarSeries(stationIds: string[], now: Date) {
  const today = dhakaDay(now);
  const dayStart = new Date(`${today}T00:00:00+06:00`);
  const from30 = addDays(today, -29);
  const from12m = `${addDays(`${today.slice(0, 7)}-01`, -320).slice(0, 7)}-01`;
  const r = schema.solarReadings;
  const d = schema.solarDaily;
  const bucket = sql<number>`(floor(extract(epoch from ${r.ts}) / ${sql.raw(String(BUCKET_SECONDS))}) * ${sql.raw(String(BUCKET_SECONDS))})::bigint`;
  const sumOf = (c: AnyColumn) => sql<string>`sum(${c})`;

  const [latest, power, daily, monthly] = await Promise.all([
    db
      .selectDistinctOn([r.stationId])
      .from(r)
      .where(and(inArray(r.stationId, stationIds), gte(r.ts, new Date(now.getTime() - 86_400_000))))
      .orderBy(r.stationId, desc(r.ts)),
    db
      .select({
        stationId: r.stationId,
        bucket,
        generationW: sql<number | null>`avg(${r.generationW})`,
        consumptionW: sql<number | null>`avg(${r.consumptionW})`,
        gridW: sql<number | null>`avg(${r.gridW})`,
        batteryW: sql<number | null>`avg(${r.batteryW})`,
        batterySoc: sql<number | null>`avg(${r.batterySoc})`,
      })
      .from(r)
      .where(and(inArray(r.stationId, stationIds), gte(r.ts, dayStart)))
      .groupBy(r.stationId, sql`2`),
    db.select().from(d).where(and(inArray(d.stationId, stationIds), between(d.day, from30, today))),
    db
      .select({
        stationId: d.stationId,
        month: sql<string>`to_char(${d.day}, 'YYYY-MM')`,
        generation: sumOf(d.generationKwh),
        consumption: sumOf(d.consumptionKwh),
        purchase: sumOf(d.purchaseKwh),
        export: sumOf(d.exportKwh),
      })
      .from(d)
      .where(and(inArray(d.stationId, stationIds), gte(d.day, from12m)))
      .groupBy(d.stationId, sql`2`),
  ]);

  const n = (v: unknown) => (v === null || v === undefined ? null : Number(v));
  return {
    today,
    from30,
    from12m,
    latest: latest as SolarReading[],
    power: power.map(
      (p): SolarBucket => ({
        stationId: p.stationId,
        ts: Number(p.bucket) * 1000,
        generationW: n(p.generationW),
        consumptionW: n(p.consumptionW),
        gridW: n(p.gridW),
        batteryW: n(p.batteryW),
        batterySoc: n(p.batterySoc),
      }),
    ),
    daily: daily.map(
      (x): SolarDayRow => ({
        stationId: x.stationId,
        day: x.day,
        generation: Number(x.generationKwh),
        consumption: Number(x.consumptionKwh),
        purchase: Number(x.purchaseKwh),
        export: Number(x.exportKwh),
        charge: Number(x.chargeKwh),
        discharge: Number(x.dischargeKwh),
      }),
    ),
    monthly: monthly.map((x) => ({
      stationId: x.stationId,
      month: x.month,
      generation: Number(x.generation),
      consumption: Number(x.consumption),
      purchase: Number(x.purchase),
      export: Number(x.export),
    })),
  };
}

export type SolarTotals = { generation: number; consumption: number; purchase: number; export: number };

/** The inverter's side only: what it took from the grid vs what it supplied from panels and battery. */
export type InverterSplit = { gridKwh: number; ownKwh: number };

function inverterSplit(consumption: number, purchase: number): InverterSplit {
  return { gridKwh: round(purchase), ownKwh: round(Math.max(consumption - purchase, 0)) };
}

export type SolarView = {
  stations: { id: string; name: string; meterLabel: string; lastSeenAt: Date | null; lastError: string | null; active: boolean }[];
  /** Summed over each station's latest snapshot (last 24 h); `stale` when none is recent. */
  live: { stale: boolean; ts: number; generationW: number | null; consumptionW: number | null; gridW: number | null; batteryW: number | null; batterySoc: number | null } | null;
  today: SolarTotals & { charge: number; discharge: number; split: InverterSplit };
  cycle: (SolarTotals & {
    split: InverterSplit;
    /** Whole house: every meter's grid use (inverter's grid draw included) vs solar and battery. */
    house: InverterSplit;
    saving: number; billWithSolar: number; billWithoutSolar: number; start: string; end: string; daysElapsed: number; daysInCycle: number }) | null;
  /** Grid = bought from the grid, solar = panel output. */
  power: PowerPoint[];
  daily: DayPoint[];
  monthly: MonthPoint[];
  hasBattery: boolean;
};

/** Everything the Solar tab shows, for the stations under these meters. Null when none are linked. */
export async function solarDashboard(meters: MeterDashboard[], now = new Date()): Promise<SolarView | null> {
  if (meters.length === 0) return null;
  const stations = await db
    .select()
    .from(schema.solarStations)
    .where(inArray(schema.solarStations.meterId, meters.map((m) => m.meter.id)))
    .orderBy(schema.solarStations.name);
  if (stations.length === 0) return null;
  const ids = stations.map((s) => s.id);
  const series = await solarSeries(ids, now);

  const fresh = series.latest.filter((r) => now.getTime() - r.ts.getTime() < SOLAR_LIVE_WINDOW_MS);
  // When the logger stops reporting, keep showing the last snapshot, marked as old.
  const recent = fresh.length ? fresh : series.latest;
  const sum = (key: "generationW" | "consumptionW" | "gridW" | "batteryW") => sumNullable(recent.map((r) => r[key]));
  const socs = recent.map((r) => r.batterySoc).filter((v): v is number => v !== null);

  const dayTotals = series.daily.filter((x) => x.day === series.today);
  const total = <K extends keyof SolarDayRow>(rows: SolarDayRow[], key: K) => round(rows.reduce((s, x) => s + Number(x[key]), 0));

  // The cycle comes from each reference meter; savings are already worked out in its bill.
  const withStations = meters.filter((m) => stations.some((s) => s.meterId === m.meter.id) && m.cycle);
  // Every meter in the homes that have an inverter, for the whole-house split.
  const houseMeters = meters.filter((m) => stations.some((s) => s.profileId === m.meter.profileId));
  let cycle: SolarView["cycle"] = null;
  if (withStations.length) {
    const totals = await Promise.all(
      withStations.map((m) =>
        stationKwh(stations.filter((s) => s.meterId === m.meter.id).map((s) => s.id), m.cycle!.cycle.start, series.today),
      ),
    );
    const add = (key: keyof SolarTotals) => round(totals.reduce((s, t) => s + [...t.values()].reduce((a, v) => a + v[key], 0), 0));
    const first = withStations[0].cycle!;
    const consumption = add("consumption");
    const purchase = add("purchase");
    const split = inverterSplit(consumption, purchase);
    cycle = {
      split,
      house: { gridKwh: round(houseMeters.reduce((s, m) => s + (m.cycle?.kwh ?? 0), 0)), ownKwh: split.ownKwh },
      generation: add("generation"),
      consumption: add("consumption"),
      purchase: add("purchase"),
      export: add("export"),
      saving: round(withStations.reduce((s, m) => s + (m.cycle!.solar?.saving ?? 0), 0)),
      billWithSolar: round(withStations.reduce((s, m) => s + m.cycle!.bill.total, 0)),
      billWithoutSolar: round(withStations.reduce((s, m) => s + (m.cycle!.solar?.billWithoutSolar.total ?? m.cycle!.bill.total), 0)),
      start: first.cycle.start,
      end: first.cycle.end,
      daysElapsed: first.daysElapsed,
      daysInCycle: first.daysInCycle,
    };
  }

  const power = new Map<number, PowerPoint>();
  for (const p of series.power) {
    const b = power.get(p.ts) ?? { ts: p.ts, grid: null, solar: null };
    if (p.generationW !== null) b.solar = Math.round((b.solar ?? 0) + p.generationW);
    if (p.gridW !== null) b.grid = Math.round((b.grid ?? 0) + Math.max(p.gridW, 0));
    power.set(p.ts, b);
  }

  const daily: DayPoint[] = [];
  for (let day = series.from30; day <= series.today; day = addDays(day, 1)) {
    const rows = series.daily.filter((x) => x.day === day);
    daily.push({ day, grid: total(rows, "purchase"), solar: total(rows, "generation") });
  }
  const monthly: MonthPoint[] = [];
  for (let m = series.from12m.slice(0, 7); m <= series.today.slice(0, 7); m = addDays(`${m}-28`, 7).slice(0, 7)) {
    const rows = series.monthly.filter((x) => x.month === m);
    monthly.push({ month: m, grid: round(rows.reduce((s, x) => s + x.purchase, 0)), solar: round(rows.reduce((s, x) => s + x.generation, 0)) });
  }

  return {
    stations: stations.map((s) => {
      const m = meters.find((x) => x.meter.id === s.meterId)!;
      return { id: s.id, name: s.name, meterLabel: meterLabel(m.meter), lastSeenAt: s.lastSeenAt, lastError: s.lastError, active: s.active };
    }),
    live: recent.length
      ? {
          stale: fresh.length === 0,
          ts: Math.max(...recent.map((r) => r.ts.getTime())),
          generationW: sum("generationW"),
          consumptionW: sum("consumptionW"),
          gridW: sum("gridW"),
          batteryW: sum("batteryW"),
          batterySoc: socs.length ? socs.reduce((a, b) => a + b, 0) / socs.length : null,
        }
      : null,
    today: {
      split: inverterSplit(total(dayTotals, "consumption"), total(dayTotals, "purchase")),
      generation: total(dayTotals, "generation"),
      consumption: total(dayTotals, "consumption"),
      purchase: total(dayTotals, "purchase"),
      export: total(dayTotals, "export"),
      charge: total(dayTotals, "charge"),
      discharge: total(dayTotals, "discharge"),
    },
    cycle,
    power: [...power.values()].sort((a, b) => a.ts - b.ts),
    daily,
    monthly,
    hasBattery: socs.length > 0 || series.daily.some((x) => x.charge + x.discharge > 0),
  };
}

// ---------------------------------------------------------------- views
// One shape for both "all meters" and a single meter, so the dashboard renders either the same way.

export type MonthPoint = { month: string; grid: number; solar: number };
export type ViewDevice = MeterDashboard["devices"][number] & { meterLabel: string };

export type Ladder = {
  meterId: string;
  label: string;
  kwh: number;
  projectedKwh: number;
  tariff: Tariff;
  nextStep: ReturnType<typeof nextPriceStep>;
  lifeline: boolean;
  cycleEnd: string;
  daysElapsed: number;
  daysInCycle: number;
  trackedDays: number;
};

export type DashboardView = {
  key: string;
  title: string;
  meterCount: number;
  liveGridW: number | null;
  liveSolarW: number | null;
  lastReadingAt: number | null;
  todayGridKwh: number;
  todaySolarKwh: number;
  /** Rough Tk value of today's grid use at each meter's average rate this cycle. */
  todayCost: number;
  cycleKwh: number;
  billSoFar: number;
  projectedBill: number;
  projectedKwh: number;
  solarCycleKwh: number;
  solarSaving: number;
  hasSolar: boolean;
  hasCycle: boolean;
  /** "day 7 of 31" when every meter shares one cycle, else null. */
  cycleProgress: { day: number; of: number; start: string; end: string } | null;
  partialFrom: string | null;
  /** Average kWh per day since readings began this cycle. */
  dailyAverage: number;
  projectionReliable: boolean;
  /** Highest 5-minute grid power today. */
  peakToday: { w: number; ts: number } | null;
  power: PowerPoint[];
  daily: DayPoint[];
  monthly: MonthPoint[];
  devices: ViewDevice[];
  ladders: Ladder[];
  balances: { meterId: string; label: string; balance: PrepaidBalance }[];
  /** Prepaid meters that don't have a balance entered yet. */
  prepaidWithoutBalance: number;
  costs: { fixed: number; total: number; shares: (CostShare & { meterLabel: string })[] };
};

export function meterLabel(m: Meter) {
  return m.label ?? `Meter ${m.meterNo}`;
}

function avgRate(m: MeterDashboard) {
  const p = m.cycle?.projected;
  return p && p.kwh > 0 ? p.energyCharge / p.kwh : 0;
}

function sumNullable(values: (number | null)[]) {
  const present = values.filter((v): v is number => v !== null);
  return present.length ? present.reduce((a, b) => a + b, 0) : null;
}

/** Combines any number of meters into one view (one meter in = that meter's view). */
export function buildView(key: string, title: string, meters: MeterDashboard[]): DashboardView {
  const cycles = meters.map((m) => m.cycle).filter((c): c is Projection => c !== null);
  const sameCycle =
    cycles.length > 0 && cycles.every((c) => c.cycle.start === cycles[0].cycle.start && c.cycle.end === cycles[0].cycle.end);

  // Power curves line up on 5-minute buckets, so summing by timestamp is exact.
  const power = new Map<number, { grid: number | null; solar: number | null }>();
  for (const m of meters)
    for (const p of m.power) {
      const b = power.get(p.ts) ?? { grid: null, solar: null };
      if (p.grid !== null) b.grid = (b.grid ?? 0) + p.grid;
      if (p.solar !== null) b.solar = (b.solar ?? 0) + p.solar;
      power.set(p.ts, b);
    }

  const sumSeries = <T extends { grid: number; solar: number }>(key: keyof T, series: T[][]) => {
    const out = new Map<string, T>();
    for (const list of series)
      for (const p of list) {
        const k = String(p[key]);
        const prev = out.get(k);
        out.set(k, prev ? { ...prev, grid: round(prev.grid + p.grid), solar: round(prev.solar + p.solar) } : { ...p });
      }
    return [...out.values()].sort((a, b) => String(a[key]).localeCompare(String(b[key])));
  };

  const devices = meters.flatMap((m) => m.devices.map((d) => ({ ...d, meterLabel: meterLabel(m.meter) })));
  const lastReadingAt = [...devices.map((d) => d.live?.ts.getTime() ?? null), ...meters.map((m) => m.lastSolarAt)].reduce<number | null>(
    (t, ts) => (ts !== null && (t === null || ts > t) ? ts : t),
    null,
  );

  const first = cycles[0];
  return {
    key,
    title,
    meterCount: meters.length,
    liveGridW: sumNullable(meters.map((m) => m.liveGridW)),
    liveSolarW: sumNullable(meters.map((m) => m.liveSolarW)),
    lastReadingAt,
    todayGridKwh: round(meters.reduce((s, m) => s + m.todayGridKwh, 0)),
    todaySolarKwh: round(meters.reduce((s, m) => s + m.todaySolarKwh, 0)),
    todayCost: round(meters.reduce((s, m) => s + m.todayGridKwh * avgRate(m), 0)),
    cycleKwh: round(cycles.reduce((s, c) => s + c.kwh, 0)),
    billSoFar: round(cycles.reduce((s, c) => s + c.bill.total, 0)),
    projectedBill: round(cycles.reduce((s, c) => s + c.projected.total, 0)),
    projectedKwh: round(cycles.reduce((s, c) => s + c.projectedKwh, 0)),
    solarCycleKwh: round(cycles.reduce((s, c) => s + (c.solar?.outputKwh ?? 0), 0)),
    solarSaving: round(cycles.reduce((s, c) => s + (c.solar?.saving ?? 0), 0)),
    hasSolar: meters.some((m) => m.hasSolar),
    hasCycle: cycles.length > 0,
    cycleProgress:
      sameCycle && first
        ? { day: Math.max(Math.ceil(first.daysElapsed), 1), of: first.daysInCycle, start: first.cycle.start, end: first.cycle.end }
        : null,
    partialFrom: cycles.map((c) => c.partialFrom).filter((p): p is string => !!p).sort().at(-1) ?? null,
    dailyAverage: round(cycles.reduce((s, c) => s + c.kwh / Math.max(c.trackedDays, 1), 0)),
    projectionReliable: cycles.every((c) => c.projectionReliable),
    peakToday: [...power.entries()].reduce<{ w: number; ts: number } | null>(
      (best, [ts, b]) => (b.grid !== null && (!best || b.grid > best.w) ? { w: b.grid, ts } : best),
      null,
    ),
    power: [...power.entries()].sort((a, b) => a[0] - b[0]).map(([ts, b]) => ({ ts, ...b })),
    daily: sumSeries("day", meters.map((m) => m.daily)),
    monthly: sumSeries("month", meters.map((m) => m.monthly)),
    devices,
    prepaidWithoutBalance: meters.filter((m) => m.meter.connectionType === "prepaid" && !m.balance).length,
    balances: meters.flatMap((m) => (m.balance ? [{ meterId: m.meter.id, label: meterLabel(m.meter), balance: m.balance }] : [])),
    costs: {
      fixed: round(meters.reduce((s, m) => s + (m.costs?.fixed ?? 0), 0)),
      total: round(cycles.reduce((s, c) => s + c.bill.total, 0)),
      shares: meters
        .flatMap((m) => (m.costs?.shares ?? []).map((sh) => ({ ...sh, meterLabel: meterLabel(m.meter) })))
        .sort((a, b) => b.tk - a.tk),
    },
    ladders: meters.flatMap((m) =>
      m.cycle && m.tariff
        ? [
            {
              meterId: m.meter.id,
              label: meterLabel(m.meter),
              kwh: m.cycle.kwh,
              projectedKwh: m.cycle.projectedKwh,
              tariff: m.tariff,
              nextStep: m.nextStep,
              lifeline: m.cycle.bill.lifeline,
              cycleEnd: m.cycle.cycle.end,
              daysElapsed: m.cycle.daysElapsed,
              daysInCycle: m.cycle.daysInCycle,
              trackedDays: m.cycle.trackedDays,
            },
          ]
        : [],
    ),
  };
}
