import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  bigserial,
  boolean,
  check,
  date,
  doublePrecision,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

// ---------------------------------------------------------------------------
// Better Auth tables (core + admin plugin fields)
// ---------------------------------------------------------------------------

export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  // admin plugin: "admin" = super admin, "user" = normal user
  role: text("role").default("user"),
  banned: boolean("banned").default(false),
  banReason: text("ban_reason"),
  banExpires: timestamp("ban_expires", { withTimezone: true }),
});

export const session = pgTable("session", {
  id: text("id").primaryKey(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  token: text("token").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  impersonatedBy: text("impersonated_by"),
});

export const account = pgTable("account", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  idToken: text("id_token"),
  accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
  refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
  scope: text("scope"),
  password: text("password"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const verification = pgTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// Profiles
// ---------------------------------------------------------------------------

export const profiles = pgTable("profiles", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  // UID of the Smart Life / Tuya app account linked to the cloud project.
  // Devices offered in "Add device" are limited to this account.
  tuyaUid: text("tuya_uid"),
  // Deye Cloud login for this profile's inverters. Only the SHA-256 of the password is kept (what
  // Deye's login takes), set by a profile member on the Devices page.
  deyeEmail: text("deye_email"),
  deyePasswordHash: text("deye_password_hash"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const profileMembers = pgTable(
  "profile_members",
  {
    profileId: uuid("profile_id")
      .notNull()
      .references(() => profiles.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.profileId, t.userId] })],
);

// ---------------------------------------------------------------------------
// Tariffs: plan -> versions (effective dates) -> slabs
// ---------------------------------------------------------------------------

export const tariffPlans = pgTable("tariff_plans", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(), // e.g. "BERC LT-A Residential"
  description: text("description"),
  createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const tariffVersions = pgTable(
  "tariff_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    planId: uuid("plan_id")
      .notNull()
      .references(() => tariffPlans.id, { onDelete: "cascade" }),
    effectiveFrom: date("effective_from").notNull(),
    // Lifeline: if monthly use <= lifelineMaxKwh, all units are billed at lifelineRate
    // instead of the slabs. Leave null when the tariff has no lifeline band.
    lifelineMaxKwh: numeric("lifeline_max_kwh", { precision: 10, scale: 2 }),
    lifelineRate: numeric("lifeline_rate", { precision: 10, scale: 4 }),
    demandChargePerKw: numeric("demand_charge_per_kw", { precision: 10, scale: 2 }).notNull().default("0"),
    vatPercent: numeric("vat_percent", { precision: 5, scale: 2 }).notNull().default("5"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("tariff_versions_plan_effective_uq").on(t.planId, t.effectiveFrom)],
);

export const tariffSlabs = pgTable(
  "tariff_slabs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    versionId: uuid("version_id")
      .notNull()
      .references(() => tariffVersions.id, { onDelete: "cascade" }),
    // Units in (fromKwh, toKwh]; toKwh null = no upper limit.
    fromKwh: numeric("from_kwh", { precision: 10, scale: 2 }).notNull(),
    toKwh: numeric("to_kwh", { precision: 10, scale: 2 }),
    rate: numeric("rate", { precision: 10, scale: 4 }).notNull(), // Tk per kWh
  },
  (t) => [index("tariff_slabs_version_idx").on(t.versionId)],
);

// ---------------------------------------------------------------------------
// Meters and devices
// ---------------------------------------------------------------------------

export const connectionType = pgEnum("connection_type", ["prepaid", "postpaid"]);

export const meters = pgTable(
  "meters",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    profileId: uuid("profile_id")
      .notNull()
      .references(() => profiles.id, { onDelete: "cascade" }),
    meterNo: text("meter_no").notNull(),
    label: text("label"),
    utility: text("utility"), // DESCO, DPDC, BPDB, ...
    connectionType: connectionType("connection_type").notNull().default("prepaid"),
    tariffPlanId: uuid("tariff_plan_id")
      .notNull()
      .references(() => tariffPlans.id, { onDelete: "restrict" }),
    sanctionedLoadKw: numeric("sanctioned_load_kw", { precision: 8, scale: 2 }).notNull().default("0"),
    meterRent: numeric("meter_rent", { precision: 10, scale: 2 }).notNull().default("0"),
    rebatePercent: numeric("rebate_percent", { precision: 5, scale: 2 }).notNull().default("0"),
    // 1 = calendar month; otherwise the cycle runs from this day to the day before next month.
    billingCycleDay: integer("billing_cycle_day").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("meters_meter_no_uq").on(t.meterNo),
    check("meters_cycle_day_ck", sql`${t.billingCycleDay} between 1 and 28`),
  ],
);

export const deviceSource = pgEnum("device_source", ["grid", "solar"]);

export const devices = pgTable(
  "devices",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tuyaDeviceId: text("tuya_device_id").notNull().unique(),
    name: text("name").notNull(),
    source: deviceSource("source").notNull(),
    // grid: the meter this device sits under.
    // solar: the reference meter whose tariff values the savings.
    meterId: uuid("meter_id")
      .notNull()
      .references(() => meters.id, { onDelete: "restrict" }),
    // solar only: the grid 63T on the inverter's input.
    inverterInputDeviceId: uuid("inverter_input_device_id"),
    energyScale: integer("energy_scale").notNull().default(2), // forward_energy_total / 10^scale = kWh
    // ATS window: during these Dhaka times part of this breaker's load runs from a Deye inverter, which also
    // counts it. The extra inverter load (vs the 30 minutes before the window) is moved out of grid usage.
    atsStart: text("ats_start"), // "HH:MM"
    atsEnd: text("ats_end"),
    atsStationId: uuid("ats_station_id").references((): AnyPgColumn => solarStations.id, { onDelete: "set null" }),
    active: boolean("active").notNull().default(true),
    // Poller state
    lastEnergyKwh: numeric("last_energy_kwh", { precision: 14, scale: 3 }),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    online: boolean("online"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("devices_meter_idx").on(t.meterId)],
);

// Units used in a billing cycle that the breakers didn't record (e.g. before tracking began).
// Entered as "units this cycle so far" from the utility meter; stored as the difference from
// what the breakers had recorded at that moment, so nothing is counted twice.
export const meterAdjustments = pgTable(
  "meter_adjustments",
  {
    meterId: uuid("meter_id")
      .notNull()
      .references(() => meters.id, { onDelete: "cascade" }),
    cycleStart: date("cycle_start").notNull(),
    kwh: numeric("kwh", { precision: 12, scale: 3 }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.meterId, t.cycleStart] })],
);

// Prepaid meters: the balance read off the meter at one moment (the anchor), plus recharges
// after it. The app estimates today's balance from those and the usage cost since.
export const meterBalances = pgTable("meter_balances", {
  meterId: uuid("meter_id")
    .primaryKey()
    .references(() => meters.id, { onDelete: "cascade" }),
  balanceTk: numeric("balance_tk", { precision: 12, scale: 2 }).notNull(),
  at: timestamp("at", { withTimezone: true }).notNull(),
  // Usage position at that moment, so cost since the anchor can be worked out exactly.
  cycleStart: date("cycle_start").notNull(),
  cycleKwh: numeric("cycle_kwh", { precision: 12, scale: 3 }).notNull(),
});

export const meterRecharges = pgTable(
  "meter_recharges",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    meterId: uuid("meter_id")
      .notNull()
      .references(() => meters.id, { onDelete: "cascade" }),
    at: timestamp("at", { withTimezone: true }).notNull(),
    amountTk: numeric("amount_tk", { precision: 12, scale: 2 }).notNull(),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
  },
  (t) => [index("meter_recharges_meter_at_idx").on(t.meterId, t.at)],
);

// ---------------------------------------------------------------------------
// Measurements
// ---------------------------------------------------------------------------

export const readings = pgTable(
  "readings",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    deviceId: uuid("device_id")
      .notNull()
      .references(() => devices.id, { onDelete: "cascade" }),
    ts: timestamp("ts", { withTimezone: true }).notNull(),
    energyKwh: numeric("energy_kwh", { precision: 14, scale: 3 }),
    powerW: doublePrecision("power_w"),
    voltageV: doublePrecision("voltage_v"),
    currentA: doublePrecision("current_a"),
    powerFactor: doublePrecision("power_factor"),
    frequencyHz: doublePrecision("frequency_hz"),
    leakageMa: doublePrecision("leakage_ma"),
    tempC: doublePrecision("temp_c"),
    // Part of powerW fed by an inverter through an ATS (not grid), when the device has an ATS window.
    inverterW: doublePrecision("inverter_w"),
  },
  (t) => [index("readings_device_ts_idx").on(t.deviceId, t.ts)],
);

// kWh used per device per day (Asia/Dhaka), from counter deltas.
export const dailyEnergy = pgTable(
  "daily_energy",
  {
    deviceId: uuid("device_id")
      .notNull()
      .references(() => devices.id, { onDelete: "cascade" }),
    day: date("day").notNull(),
    // Grid kWh only: this is what bills count.
    kwh: numeric("kwh", { precision: 12, scale: 3 }).notNull().default("0"),
    // kWh the breaker saw that came from an inverter through an ATS (already left out of `kwh`).
    inverterKwh: numeric("inverter_kwh", { precision: 12, scale: 3 }).notNull().default("0"),
  },
  (t) => [primaryKey({ columns: [t.deviceId, t.day] })],
);

export const bills = pgTable(
  "bills",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    meterId: uuid("meter_id")
      .notNull()
      .references(() => meters.id, { onDelete: "cascade" }),
    periodStart: date("period_start").notNull(),
    periodEnd: date("period_end").notNull(),
    tariffVersionId: uuid("tariff_version_id").references(() => tariffVersions.id, { onDelete: "set null" }),
    kwh: numeric("kwh", { precision: 12, scale: 3 }).notNull(),
    total: numeric("total", { precision: 12, scale: 2 }).notNull(),
    breakdown: jsonb("breakdown").notNull(),
    solarKwh: numeric("solar_kwh", { precision: 12, scale: 3 }),
    solarSaving: numeric("solar_saving", { precision: 12, scale: 2 }),
    finalizedAt: timestamp("finalized_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("bills_meter_period_uq").on(t.meterId, t.periodStart)],
);

// ---------------------------------------------------------------------------
// Solar inverters read from Deye Cloud (no breakers needed)
// ---------------------------------------------------------------------------

export const solarStations = pgTable(
  "solar_stations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    profileId: uuid("profile_id")
      .notNull()
      .references(() => profiles.id, { onDelete: "cascade" }),
    // Station (plant) id on Deye Cloud.
    deyeStationId: text("deye_station_id").notNull(),
    name: text("name").notNull(),
    // The meter whose tariff values the savings, and that the inverter draws grid power through.
    meterId: uuid("meter_id")
      .notNull()
      .references(() => meters.id, { onDelete: "restrict" }),
    // True when a tracked breaker already measures what the inverter draws from the grid. False adds
    // Deye's "bought from grid" figure to the meter's usage, so the bill includes it.
    gridDrawMetered: boolean("grid_draw_metered").notNull().default(true),
    active: boolean("active").notNull().default(true),
    // Poller state
    backfilledAt: timestamp("backfilled_at", { withTimezone: true }),
    dailySyncedAt: timestamp("daily_synced_at", { withTimezone: true }),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("solar_stations_deye_uq").on(t.deyeStationId), index("solar_stations_meter_idx").on(t.meterId)],
);

// Power snapshots, one per Deye upload (about every 5 minutes).
export const solarReadings = pgTable(
  "solar_readings",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    stationId: uuid("station_id")
      .notNull()
      .references(() => solarStations.id, { onDelete: "cascade" }),
    ts: timestamp("ts", { withTimezone: true }).notNull(),
    generationW: doublePrecision("generation_w"),
    consumptionW: doublePrecision("consumption_w"),
    gridW: doublePrecision("grid_w"), // + buying, − selling
    batteryW: doublePrecision("battery_w"), // + discharging, − charging
    batterySoc: doublePrecision("battery_soc"),
  },
  (t) => [uniqueIndex("solar_readings_station_ts_uq").on(t.stationId, t.ts)],
);

// Deye's own daily totals (kWh, station's local day).
export const solarDaily = pgTable(
  "solar_daily",
  {
    stationId: uuid("station_id")
      .notNull()
      .references(() => solarStations.id, { onDelete: "cascade" }),
    day: date("day").notNull(),
    generationKwh: numeric("generation_kwh", { precision: 12, scale: 3 }).notNull().default("0"),
    consumptionKwh: numeric("consumption_kwh", { precision: 12, scale: 3 }).notNull().default("0"),
    purchaseKwh: numeric("purchase_kwh", { precision: 12, scale: 3 }).notNull().default("0"),
    exportKwh: numeric("export_kwh", { precision: 12, scale: 3 }).notNull().default("0"),
    chargeKwh: numeric("charge_kwh", { precision: 12, scale: 3 }).notNull().default("0"),
    dischargeKwh: numeric("discharge_kwh", { precision: 12, scale: 3 }).notNull().default("0"),
  },
  (t) => [primaryKey({ columns: [t.stationId, t.day] })],
);
