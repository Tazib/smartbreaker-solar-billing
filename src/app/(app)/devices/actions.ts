"use server";

import { revalidatePath } from "next/cache";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/db";
import { assertProfileAccess, isSuperAdmin, requireUser } from "@/lib/session";
import { errorMessage, type ActionResult } from "@/lib/action-result";
import { listUserDevices } from "@/lib/tuya/client";
import { hasEnergyCounter, parseStatus } from "@/lib/tuya/decode";
import { checkLogin, hashDeyePassword, listStations } from "@/lib/deye/client";
import { profileDeyeAccount } from "@/lib/deye/accounts";
import { isTime } from "@/lib/ats";

/** Loads a tracked device and checks the user may manage its profile. */
async function deviceForUser(user: { id: string; role?: string | null }, deviceId: string) {
  const [row] = await db
    .select({ device: schema.devices, profileId: schema.meters.profileId })
    .from(schema.devices)
    .innerJoin(schema.meters, eq(schema.meters.id, schema.devices.meterId))
    .where(eq(schema.devices.id, deviceId));
  if (!row) throw new Error("Device not found");
  await assertProfileAccess(user, row.profileId);
  return row;
}

const placementFields = {
  name: z.string().trim().min(1, "Name is required"),
  source: z.enum(["grid", "solar"]),
  meterId: z.uuid("Pick a meter"),
  inverterInputDeviceId: z
    .string()
    .transform((v) => v || null)
    .pipe(z.uuid().nullable()),
};

const needsInput = (v: { source: string; inverterInputDeviceId: string | null }) =>
  v.source === "grid" || !!v.inverterInputDeviceId;
const needsInputMessage = { message: "A solar device needs its inverter input device" };

const addDeviceSchema = z
  .object({ profileId: z.uuid(), tuyaDeviceId: z.string().min(1), ...placementFields })
  .refine(needsInput, needsInputMessage);

/**
 * Checks the meter and inverter input belong to the profile. Returns an error message or null.
 * `selfId` is the device being edited (it can't be its own inverter input).
 */
async function checkPlacement(
  profileId: string,
  meterId: string,
  inverterInputDeviceId: string | null,
  selfId?: string,
): Promise<string | null> {
  const [meter] = await db
    .select({ id: schema.meters.id })
    .from(schema.meters)
    .where(and(eq(schema.meters.id, meterId), eq(schema.meters.profileId, profileId)));
  if (!meter) return "That meter is not in this profile";

  if (inverterInputDeviceId) {
    if (inverterInputDeviceId === selfId) return "A device can't be its own inverter input";
    const [input] = await db
      .select({ source: schema.devices.source, profileId: schema.meters.profileId })
      .from(schema.devices)
      .innerJoin(schema.meters, eq(schema.meters.id, schema.devices.meterId))
      .where(eq(schema.devices.id, inverterInputDeviceId));
    if (!input || input.profileId !== profileId || input.source !== "grid") {
      return "The inverter input must be a grid device in this profile";
    }
  }
  return null;
}

export async function addDevice(_: ActionResult | null, formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const parsed = addDeviceSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { ok: false, message: parsed.error.issues[0].message };
  const { profileId, tuyaDeviceId, name, source, meterId } = parsed.data;
  const inverterInputDeviceId = source === "solar" ? parsed.data.inverterInputDeviceId : null;

  try {
    await assertProfileAccess(user, profileId);

    const [profile] = await db.select().from(schema.profiles).where(eq(schema.profiles.id, profileId));
    if (!profile?.tuyaUid) return { ok: false, message: "This profile has no Tuya account linked" };

    const placementError = await checkPlacement(profileId, meterId, inverterInputDeviceId);
    if (placementError) return { ok: false, message: placementError };

    // Only devices owned by the profile's own Tuya account can be added.
    const tuyaDevice = (await listUserDevices(profile.tuyaUid)).find((d) => d.id === tuyaDeviceId);
    if (!tuyaDevice) return { ok: false, message: "Device not found in this profile's Tuya account" };
    if (!hasEnergyCounter(tuyaDevice.status)) return { ok: false, message: "This device has no energy meter" };

    // Start the baseline now so usage before tracking is never counted.
    const m = parseStatus(tuyaDevice.status);
    const inserted = await db
      .insert(schema.devices)
      .values({
        tuyaDeviceId,
        name,
        source,
        meterId,
        inverterInputDeviceId,
        lastEnergyKwh: m.energyKwh?.toFixed(3),
        lastSeenAt: new Date(),
        online: tuyaDevice.online,
      })
      .onConflictDoNothing({ target: schema.devices.tuyaDeviceId })
      .returning({ id: schema.devices.id });
    if (inserted.length === 0) return { ok: false, message: "This device is already being tracked" };
  } catch (e) {
    return { ok: false, message: errorMessage(e) };
  }

  revalidatePath("/devices");
  return { ok: true, message: `Now tracking ${name}` };
}

const updateDeviceSchema = z.object({ deviceId: z.uuid(), ...placementFields }).refine(needsInput, needsInputMessage);

/** Name, grid/solar, meter and inverter input of a tracked device. Usage history stays with the device. */
export async function updateDevice(_: ActionResult | null, formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const parsed = updateDeviceSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { ok: false, message: parsed.error.issues[0].message };
  const { deviceId, name, source, meterId } = parsed.data;
  const inverterInputDeviceId = source === "solar" ? parsed.data.inverterInputDeviceId : null;

  try {
    const { device, profileId } = await deviceForUser(user, deviceId);
    // A device can move between meters, but only within its own profile.
    const placementError = await checkPlacement(profileId, meterId, inverterInputDeviceId, deviceId);
    if (placementError) return { ok: false, message: placementError };

    if (device.source === "grid" && source === "solar") {
      const dependents = await db
        .select({ name: schema.devices.name })
        .from(schema.devices)
        .where(eq(schema.devices.inverterInputDeviceId, deviceId));
      if (dependents.length) {
        return {
          ok: false,
          message: `${dependents.map((d) => d.name).join(", ")} uses this as its inverter input, so it must stay grid`,
        };
      }
    }

    await db
      .update(schema.devices)
      .set({ name, source, meterId, inverterInputDeviceId })
      .where(eq(schema.devices.id, deviceId));
  } catch (e) {
    return { ok: false, message: errorMessage(e) };
  }
  revalidatePath("/", "layout");
  return { ok: true, message: "Saved" };
}

export async function setDeviceActive(_: ActionResult | null, formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const deviceId = String(formData.get("deviceId"));
  const active = formData.get("active") === "true";
  try {
    await deviceForUser(user, deviceId);
    // Resuming clears the baseline so the paused period is never billed as one big jump.
    await db
      .update(schema.devices)
      .set(active ? { active, lastEnergyKwh: null } : { active })
      .where(eq(schema.devices.id, deviceId));
  } catch (e) {
    return { ok: false, message: errorMessage(e) };
  }
  revalidatePath("/devices");
  return { ok: true, message: active ? "Tracking resumed" : "Tracking paused" };
}

export async function deleteDevice(_: ActionResult | null, formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!isSuperAdmin(user)) return { ok: false, message: "Only the super admin can delete devices" };
  const deviceId = String(formData.get("deviceId"));
  try {
    await deviceForUser(user, deviceId);
    const dependents = await db
      .select({ name: schema.devices.name })
      .from(schema.devices)
      .where(eq(schema.devices.inverterInputDeviceId, deviceId));
    if (dependents.length) {
      return { ok: false, message: `Used as inverter input by ${dependents.map((d) => d.name).join(", ")}` };
    }
    await db.delete(schema.devices).where(eq(schema.devices.id, deviceId));
  } catch (e) {
    return { ok: false, message: errorMessage(e) };
  }
  revalidatePath("/devices");
  return { ok: true, message: "Device and its readings deleted" };
}

// ---------------------------------------------------------------- Deye inverters

/** Loads a linked station and checks the user may manage its profile. */
async function stationForUser(user: { id: string; role?: string | null }, stationId: string) {
  const [station] = await db.select().from(schema.solarStations).where(eq(schema.solarStations.id, stationId));
  if (!station) throw new Error("Inverter not found");
  await assertProfileAccess(user, station.profileId);
  return station;
}

async function meterInProfile(profileId: string, meterId: string) {
  const [meter] = await db
    .select({ id: schema.meters.id })
    .from(schema.meters)
    .where(and(eq(schema.meters.id, meterId), eq(schema.meters.profileId, profileId)));
  return !!meter;
}

const stationFields = {
  name: z.string().trim().min(1, "Name is required"),
  meterId: z.uuid("Pick a meter"),
  gridDrawMetered: z.enum(["yes", "no"], "Say whether a breaker measures the inverter's grid input").transform((v) => v === "yes"),
};

const addStationSchema = z.object({ profileId: z.uuid(), deyeStationId: z.string().min(1), ...stationFields });

const deyeLoginSchema = z.object({
  profileId: z.uuid(),
  email: z.email("Enter the email you use on Deye Cloud"),
  password: z.string().min(1, "Enter the Deye Cloud password"),
});

/**
 * Connects a profile to its own Deye Cloud account. Any member may do it, so each household enters
 * its own login. The password is checked with Deye, then only its SHA-256 is stored.
 */
export async function connectDeye(_: ActionResult | null, formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const parsed = deyeLoginSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { ok: false, message: parsed.error.issues[0].message };
  const { profileId, email, password } = parsed.data;
  try {
    await assertProfileAccess(user, profileId);
    const account = { email, passwordHash: hashDeyePassword(password) };
    await checkLogin(account);
    await db.update(schema.profiles).set({ deyeEmail: email, deyePasswordHash: account.passwordHash }).where(eq(schema.profiles.id, profileId));
  } catch (e) {
    return { ok: false, message: errorMessage(e) };
  }
  revalidatePath("/devices");
  return { ok: true, message: "Deye account connected" };
}

/** Forgets the profile's Deye login. Linked inverters stay, but stop updating until one is connected again. */
export async function disconnectDeye(_: ActionResult | null, formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const profileId = String(formData.get("profileId"));
  try {
    await assertProfileAccess(user, profileId);
    await db.update(schema.profiles).set({ deyeEmail: null, deyePasswordHash: null }).where(eq(schema.profiles.id, profileId));
  } catch (e) {
    return { ok: false, message: errorMessage(e) };
  }
  revalidatePath("/devices");
  return { ok: true, message: "Deye account disconnected" };
}

/** Links a station from the profile's own Deye account. */
export async function addStation(_: ActionResult | null, formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const parsed = addStationSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { ok: false, message: parsed.error.issues[0].message };
  const { profileId, deyeStationId, name, meterId, gridDrawMetered } = parsed.data;

  try {
    await assertProfileAccess(user, profileId);
    if (!(await meterInProfile(profileId, meterId))) return { ok: false, message: "That meter is not in this profile" };
    const account = await profileDeyeAccount(profileId);
    if (!account) return { ok: false, message: "Connect this profile's Deye account first" };
    // Only stations on the profile's own Deye account can be linked.
    const station = (await listStations(account)).find((s) => s.id === deyeStationId);
    if (!station) return { ok: false, message: "Station not found on this profile's Deye account" };
    const inserted = await db
      .insert(schema.solarStations)
      .values({ profileId, deyeStationId, name, meterId, gridDrawMetered })
      .onConflictDoNothing({ target: schema.solarStations.deyeStationId })
      .returning({ id: schema.solarStations.id });
    if (inserted.length === 0) return { ok: false, message: "This inverter is already linked" };
  } catch (e) {
    return { ok: false, message: errorMessage(e) };
  }
  revalidatePath("/", "layout");
  return { ok: true, message: `Linked ${name}. The poller loads its last year of history within 5 minutes.` };
}

const updateStationSchema = z.object({ stationId: z.uuid(), ...stationFields });

export async function updateStation(_: ActionResult | null, formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const parsed = updateStationSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { ok: false, message: parsed.error.issues[0].message };
  const { stationId, name, meterId, gridDrawMetered } = parsed.data;
  try {
    const station = await stationForUser(user, stationId);
    if (!(await meterInProfile(station.profileId, meterId))) return { ok: false, message: "That meter is not in this profile" };
    await db.update(schema.solarStations).set({ name, meterId, gridDrawMetered }).where(eq(schema.solarStations.id, stationId));
  } catch (e) {
    return { ok: false, message: errorMessage(e) };
  }
  revalidatePath("/", "layout");
  return { ok: true, message: "Saved" };
}

export async function setStationActive(_: ActionResult | null, formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const stationId = String(formData.get("stationId"));
  const active = formData.get("active") === "true";
  try {
    await stationForUser(user, stationId);
    await db.update(schema.solarStations).set({ active }).where(eq(schema.solarStations.id, stationId));
  } catch (e) {
    return { ok: false, message: errorMessage(e) };
  }
  revalidatePath("/devices");
  return { ok: true, message: active ? "Reading resumed" : "Reading paused" };
}

export async function deleteStation(_: ActionResult | null, formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!isSuperAdmin(user)) return { ok: false, message: "Only the super admin can remove inverters (it deletes their history)" };
  const stationId = String(formData.get("stationId"));
  try {
    await stationForUser(user, stationId);
    await db.delete(schema.solarStations).where(eq(schema.solarStations.id, stationId));
  } catch (e) {
    return { ok: false, message: errorMessage(e) };
  }
  revalidatePath("/", "layout");
  return { ok: true, message: "Inverter and its data removed" };
}

// ---------------------------------------------------------------- ATS window

const atsSchema = z.object({
  deviceId: z.uuid(),
  atsStationId: z.string().transform((v) => v || null).pipe(z.uuid().nullable()),
  atsStart: z.string(),
  atsEnd: z.string(),
});

/**
 * Sets (or clears, with no inverter picked) the daily window when part of a grid breaker's load is
 * switched onto a Deye inverter through an ATS. Applies from the next poll; past usage is unchanged.
 */
export async function updateAtsWindow(_: ActionResult | null, formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const parsed = atsSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { ok: false, message: parsed.error.issues[0].message };
  const { deviceId, atsStationId, atsStart, atsEnd } = parsed.data;

  try {
    const { device, profileId } = await deviceForUser(user, deviceId);
    if (device.source !== "grid") return { ok: false, message: "Only grid breakers can have an ATS window" };

    if (!atsStationId) {
      await db.update(schema.devices).set({ atsStart: null, atsEnd: null, atsStationId: null }).where(eq(schema.devices.id, deviceId));
      revalidatePath("/devices");
      return { ok: true, message: "ATS window removed" };
    }

    if (!isTime(atsStart) || !isTime(atsEnd)) return { ok: false, message: "Enter both times as HH:MM" };
    if (atsStart === atsEnd) return { ok: false, message: "Start and end can't be the same time" };
    const [station] = await db
      .select({ id: schema.solarStations.id })
      .from(schema.solarStations)
      .where(and(eq(schema.solarStations.id, atsStationId), eq(schema.solarStations.profileId, profileId)));
    if (!station) return { ok: false, message: "Pick an inverter from this profile" };

    await db.update(schema.devices).set({ atsStart, atsEnd, atsStationId }).where(eq(schema.devices.id, deviceId));
  } catch (e) {
    return { ok: false, message: errorMessage(e) };
  }
  revalidatePath("/", "layout");
  return { ok: true, message: `ATS window saved: ${atsStart}–${atsEnd}. It applies from the next minute.` };
}
