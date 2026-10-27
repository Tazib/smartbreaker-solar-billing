// One poll cycle: fetch all active devices in one batch, store readings and daily usage.
// Runs in the standalone poller process (scripts/poller.ts).
import { and, desc, eq, gte, lt, sql } from "drizzle-orm";
import { db, schema } from "@/db";
import { getStatuses } from "@/lib/tuya/client";
import { parseStatus } from "@/lib/tuya/decode";
import { dhakaDay, energyDelta } from "@/lib/energy";
import { atsWindowStart, inverterFedW, splitDelta } from "@/lib/ats";

type Device = typeof schema.devices.$inferSelect;

// A Deye snapshot older than this is too old to cap the breaker's reading with.
const SOLAR_FRESH_MS = 15 * 60_000;

/**
 * For a breaker inside its ATS window: the inverter's total load now (null when Deye has nothing recent).
 * Undefined outside the window.
 */
async function atsInverterLoad(device: Device, now: Date, cache: Map<string, number | null>) {
  if (!device.atsStart || !device.atsEnd || !device.atsStationId) return undefined;
  if (!atsWindowStart(now, device.atsStart, device.atsEnd)) return undefined;
  if (cache.has(device.atsStationId)) return cache.get(device.atsStationId)!;

  const r = schema.solarReadings;
  const [latest] = await db
    .select({ w: r.consumptionW })
    .from(r)
    .where(and(eq(r.stationId, device.atsStationId), gte(r.ts, new Date(now.getTime() - SOLAR_FRESH_MS))))
    .orderBy(desc(r.ts))
    .limit(1);
  const value = latest?.w ?? null;
  cache.set(device.atsStationId, value);
  return value;
}

export type PollSummary = { devices: number; stored: number; offline: number; missing: number; notes: string[] };

export async function pollOnce(now = new Date()): Promise<PollSummary> {
  const devices = await db.select().from(schema.devices).where(eq(schema.devices.active, true));
  const summary: PollSummary = { devices: devices.length, stored: 0, offline: 0, missing: 0, notes: [] };
  if (devices.length === 0) return summary;

  const statuses = await getStatuses(devices.map((d) => d.tuyaDeviceId));
  const atsCache = new Map<string, number | null>();

  for (const device of devices) {
    const status = statuses.get(device.tuyaDeviceId);
    if (!status) {
      summary.missing++;
      summary.notes.push(`${device.name}: no status returned`);
      continue;
    }

    const m = parseStatus(status, device.energyScale);
    if (!m.online) {
      summary.offline++;
      await db.update(schema.devices).set({ online: false }).where(eq(schema.devices.id, device.id));
      continue;
    }

    const prevKwh = device.lastEnergyKwh === null ? null : Number(device.lastEnergyKwh);
    const delta = m.energyKwh === null ? null : energyDelta(prevKwh, device.lastSeenAt, m.energyKwh, now);
    if (delta && delta.kind !== "normal" && delta.kind !== "first") {
      summary.notes.push(`${device.name}: ${delta.kind} (${prevKwh} → ${m.energyKwh} kWh, counted ${delta.kwh})`);
    }

    // ATS window: the breaker's circuit runs from the inverter, so its reading isn't grid usage.
    const inverterLoad = m.powerW !== null ? await atsInverterLoad(device, now, atsCache) : undefined;
    const fedW = inverterLoad === undefined ? null : inverterFedW(m.powerW!, inverterLoad);
    const split = delta && delta.kwh > 0 ? splitDelta(delta.kwh, m.powerW ?? 0, fedW ?? 0) : null;

    await db.transaction(async (tx) => {
      await tx.insert(schema.readings).values({
        deviceId: device.id,
        ts: now,
        energyKwh: m.energyKwh?.toFixed(3),
        powerW: m.powerW,
        voltageV: m.voltageV,
        currentA: m.currentA,
        powerFactor: m.powerFactor,
        frequencyHz: m.frequencyHz,
        leakageMa: m.leakageMa,
        tempC: m.tempC,
        inverterW: fedW,
      });

      if (split) {
        await tx
          .insert(schema.dailyEnergy)
          .values({ deviceId: device.id, day: dhakaDay(now), kwh: split.grid.toFixed(3), inverterKwh: split.inverter.toFixed(3) })
          .onConflictDoUpdate({
            target: [schema.dailyEnergy.deviceId, schema.dailyEnergy.day],
            set: {
              kwh: sql`${schema.dailyEnergy.kwh} + excluded.kwh`,
              inverterKwh: sql`${schema.dailyEnergy.inverterKwh} + excluded.inverter_kwh`,
            },
          });
      }

      await tx
        .update(schema.devices)
        .set({
          online: true,
          lastSeenAt: now,
          ...(m.energyKwh !== null && { lastEnergyKwh: m.energyKwh.toFixed(3) }),
        })
        .where(eq(schema.devices.id, device.id));
    });
    summary.stored++;
  }

  return summary;
}

/** Deletes per-minute readings older than `days`. Daily totals and bills are kept forever. */
export async function pruneReadings(days: number, now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - days * 86_400_000);
  const deleted = await db.delete(schema.readings).where(lt(schema.readings.ts, cutoff)).returning({ id: schema.readings.id });
  return deleted.length;
}
