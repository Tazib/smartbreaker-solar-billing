# Energy Tracker

A self-hosted home energy dashboard for Bangladesh. It reads **TOMZN TOVA 63T** smart breakers through
Tuya Cloud and **Deye** solar inverters through Deye Cloud. It turns those readings into what you actually
care about: what this month's electricity bill will be on the BERC slab tariff, how close you are to the next
price step, how long your prepaid balance will last, and how much your solar saves.

The app is **read-only** towards your devices. It never switches a breaker or changes an inverter setting.

- [Features](#features)
- [How it works](#how-it-works)
- [Specifications](#specifications)
- [Requirements](#requirements)
- [Installation (local)](#installation-local)
- [Connecting Tuya breakers](#connecting-tuya-breakers)
- [Connecting Deye inverters](#connecting-deye-inverters)
- [Deploying to a server](#deploying-to-a-server)
- [Configuration reference](#configuration-reference)
- [First-time setup in the app](#first-time-setup-in-the-app)
- [Scripts](#scripts)
- [Project structure](#project-structure)
- [Updating, backups and troubleshooting](#updating-backups-and-troubleshooting)

---

## Features

### Home dashboard
- **Using now**: live power for the whole home. With solar, it adds the grid and what the inverter supplies
  from its panels and battery.
- **Projected bill** for the current billing cycle, with "day 10 of 31" progress and the bill so far.
- **One view at a time**: all meters combined, each meter on its own, or the **Solar** tab.
- **Today / this cycle**: kWh, rough Tk value, daily average, and peak power today.
- **Price steps**: where each meter sits on the slab ladder, and how many units are left before the price
  per unit goes up.
- **Charts**: today's power curve (5-minute averages), the last 30 days, and the last 12 months, grid vs solar.
- **Where the money goes**: the cycle's bill split by breaker. Energy charges are shared by kWh, and fixed
  charges (demand charge, meter rent, their VAT) are shown separately.
- **Breakers list**: live W, V, A and leakage per breaker, with online/offline status.
- Refreshes every minute. Works in light and dark mode, and installs on a phone as an app (PWA).

### Solar (Deye Cloud)
- **No extra breaker needed.** The inverter's own figures come from Deye Cloud: panel output, home use,
  grid in/out, battery charge/discharge and battery %.
- **Solar tab** with:
  - live panel output, home load, grid (buying / sending / not used) and battery state
  - **Saved this cycle** in Tk, the real bill against the bill without solar, and the whole-house split
    between solar & battery and grid
  - today: solar produced, used from solar & battery, what the inverter took from the grid, and the
    self-powered %
  - this cycle's totals and charts for today, 30 days and 12 months
- When the inverter stops reporting, the last snapshot is kept, greyed out, with "last report N minutes ago".
- Each profile connects **its own Deye account**, so several households can each link their own inverters.
- The poller loads up to a year of daily history from Deye when an inverter is first linked.
- Non-Deye inverters still work with a pair of breakers (inverter input + output).

### Bills and tariffs
- Bangladesh **telescopic slab** billing, with the **lifeline** rate, **demand charge** per sanctioned kW,
  **prepaid rebate %**, **VAT** and **meter rent**.
- Tariffs are stored as data and **versioned by effective date**, so a BERC rate change doesn't rewrite old
  bills. Ships with BERC LT-A residential rates (June 2026).
- Billing cycles can be the calendar month or start on any day from 1 to 28.
- Each finished cycle's bill is stored with its full slab breakdown and solar saving.
- **Units used this cycle so far** can be entered from the utility meter, for usage before tracking began,
  without double counting.

### Prepaid meters
- Enter the balance the meter shows, then log each recharge. The app estimates today's balance from usage
  since then.
- **Days left** at this cycle's pace, with a "recharge soon" warning under 3 days.

### Accounts and profiles
- Email + password login. A **super admin** manages everything; **users** see only the profiles they belong to.
- A **profile** is a household. It has its own Tuya account, Deye account, meters, breakers and inverters.

---

## How it works

```
 TOVA 63T breakers ──► Tuya Cloud ──┐
                                    ├──► Poller (every 1 min / 5 min) ──► PostgreSQL ──► Next.js web app ──► browser / phone
 Deye inverters ────► Deye Cloud ───┘
```

The **poller** is a separate Node process:

- **Every minute** it asks Tuya for every breaker's status in one batch request. It stores a reading and
  adds the change in each breaker's energy counter to that day's total.
- **Every 5 minutes** it asks Deye for each linked inverter's latest snapshot. **Every 15 minutes** it
  refreshes today's and yesterday's daily totals.
- **Every hour** it stores bills for billing cycles that have ended, and deletes per-minute readings older
  than the retention period. Daily totals and bills are kept forever.

The **web app** works out bills, projections, balances and savings from the database on each page load.

### The bill

```
Bill = energy charge (telescopic slabs, or the lifeline rate if the month's use is within the lifeline limit)
     + demand charge × sanctioned kW
     − rebate % of (energy + demand)
     + VAT % of (energy + demand − rebate)
     + meter rent
```

A cycle uses the tariff version in force on its first day. The projection is usage so far plus the average
rate since tracking began, applied to the days left.

### The solar saving

```
Saving = bill(meter kWh − inverter's grid input + inverter's output to loads) − bill(meter kWh)
```

In words: the bill if everything the inverter powered had come straight from the grid, minus the real bill.
It is priced on the meter's own slabs, so it counts the higher price steps that solar keeps you out of. With
Deye, the input is "bought from grid" and the output is "consumption". It can be negative on a day when the
inverter charged its battery from the grid but delivered less.

---

## Specifications

| | |
|---|---|
| Framework | Next.js 16 (App Router, Server Components, Server Actions), React 19, TypeScript |
| UI | Tailwind CSS 4, shadcn/ui on Base UI, ECharts, lucide icons, next-themes |
| Database | PostgreSQL 14+ with Drizzle ORM and SQL migrations (`drizzle/`) |
| Auth | Better Auth (email + password, admin plugin for roles) |
| Poller | Node + tsx, clock-aligned timer, run under PM2 or Docker |
| Tests | Vitest: bill maths, cycles, cost shares, counter deltas, Tuya and Deye decoding, solar saving |
| Time zone | All days and cycles in Asia/Dhaka |
| Hosting | PM2 + Nginx (e.g. aaPanel) or Docker Compose; HTTPS through Let's Encrypt |

### Supported devices

**TOMZN TOVA 63T** (Tuya category `dlq`), and any Tuya breaker that reports `forward_energy_total`:

| Data point | Use |
|---|---|
| `forward_energy_total` | Cumulative kWh (scale 2). **The billing source.** A drop means the counter was reset; it becomes the new baseline. |
| `phase_a` | Base64: voltage /10 V (bytes 0–1), current /1000 A (2–4), power /1000 kW (5–7) |
| `supply_frequency`, `leakage_current` | Hz /10, mA |
| `power_factor`, `temp_zone_1` | Stored when the device reports them |

A jump larger than the breaker could physically carry in the elapsed time (20 kW) is ignored, so one bad
reading can't inflate a bill.

**Deye inverters** on Deye Cloud (hybrid, off-grid or on-grid), through the official OpenAPI:
`/account/token`, `/station/list`, `/station/latest` and `/station/history` (daily granularity).

### API usage

| Source | Calls |
|---|---|
| Tuya | 1 batch request per minute for up to 20 breakers; token cached until expiry |
| Deye | About 385 per inverter per day (latest every 5 min, daily totals every 15 min); token cached about 60 days; about 13 calls once per inverter for the history backfill |

### Data kept

| Table | Contents | Kept |
|---|---|---|
| `readings` | Per-minute breaker readings | `READINGS_RETENTION_DAYS` (default 180) |
| `solar_readings` | Deye snapshots, about every 5 min | Same retention |
| `daily_energy`, `solar_daily` | kWh per breaker / per inverter per day | Forever |
| `bills` | Stored bill per meter per cycle, with breakdown | Forever |

Other tables: `profiles`, `profile_members`, `tariff_plans`, `tariff_versions`, `tariff_slabs`, `meters`,
`devices`, `meter_adjustments`, `meter_balances`, `meter_recharges`, `solar_stations`, plus the Better Auth
tables.

### Security notes
- Device access is read-only: the app only calls Tuya and Deye read endpoints.
- Deye passwords are never stored. The app keeps only the SHA-256 hash, which is the form Deye's login takes.
- Secrets live in `.env`, which is git-ignored. The web app listens on `127.0.0.1` and is reached through Nginx.

---

## Requirements

- **Node.js 22+** and **PostgreSQL 14+** (or Docker)
- A **Tuya IoT** cloud project with your Smart Life app account linked (for breakers)
- Optional: a **Deye Cloud developer** app (for Deye inverters)

---

## Installation (local)

```sh
git clone https://github.com/Tazib/tomzn63t-meter-monitor.git energy-tracker
cd energy-tracker
cp .env.example .env
```

Fill in `.env`. At minimum you need `DATABASE_URL`, `BETTER_AUTH_SECRET` (`openssl rand -base64 32`),
`BETTER_AUTH_URL=http://localhost:3000`, the Tuya keys and `SEED_ADMIN_*`. See the
[configuration reference](#configuration-reference).

```sh
npm install
npm run db:migrate       # create the tables
npm run seed:admin       # first super admin from SEED_ADMIN_*
npm run seed:tariffs     # BERC LT-A residential rates (June 2026)

npm run dev              # web app on http://localhost:3000
npm run poller           # in a second terminal: reads the devices
```

`npm run poller -- --once` runs a single poll and exits, which is handy for testing.

Don't run a local poller and a server poller at the same time against the same Tuya/Deye accounts. It
doubles the API calls (each writes to its own database, so no data is mixed).

### Quick start with Docker

```sh
cp .env.example .env     # also set POSTGRES_PASSWORD
docker compose up -d --build
docker compose run --rm app npm run db:migrate
docker compose run --rm app npm run seed:admin
docker compose run --rm app npm run seed:tariffs
```

This starts PostgreSQL, the web app (on `127.0.0.1:3000`) and the poller.

---

## Connecting Tuya breakers

1. Create an account on the [Tuya IoT Platform](https://platform.tuya.com) and create a **Cloud project**.
   Pick the data centre your Smart Life app uses (e.g. *Central Europe* → `https://openapi.tuyaeu.com`).
2. In the project, open **Devices → Link App Account** and scan the QR code with the Smart Life app.
3. Copy the **Access ID** and **Access Secret** from the project's **Overview** into `TUYA_ACCESS_ID` /
   `TUYA_ACCESS_SECRET`.
4. Copy the linked account's **UID** (Devices → Link App Account). In the app, paste it into the profile on the
   **Profiles** page.
5. Make sure the project's **IoT Core** API service is active. The free trial must be renewed now and then on
   the Tuya site.

---

## Connecting Deye inverters

1. Sign in at [developer.deyecloud.com](https://developer.deyecloud.com) with your Deye Cloud account and
   create an **Application**.
2. Put its **App ID** and **App Secret** in `.env` as `DEYE_APP_ID` / `DEYE_APP_SECRET`. The EU data centre
   (`DEYE_BASE_URL`, the default) also serves Asia; use `https://us1-developer.deyecloud.com/v1.0` for the
   Americas.
3. Restart the web app and the poller.
4. In the app, each household opens **Devices → Solar inverters**, connects **its own** Deye Cloud email and
   password (checked with Deye; only a hash is stored), and links its station:
   - **Meter**: the meter the inverter draws grid power through. Its tariff prices the saving.
   - **Grid power into the inverter**:
     - *A breaker in this app measures it*: a tracked 63T sits on the inverter's grid input.
     - *No breaker: use Deye's figure*: Deye's "bought from grid" is added to that meter's usage, so the bill
       stays right.
5. Within about 5 minutes the poller loads the history, and the **Solar** tab appears on the home page.

---

## Deploying to a server

[DEPLOY.md](DEPLOY.md) is a step-by-step guide for a Linux server with **aaPanel**: a free **DuckDNS**
domain, PostgreSQL, PM2 or Docker, Nginx reverse proxy, Let's Encrypt HTTPS, and installing the app on phones.

The short version with PM2:

```sh
npm ci && npm run build && npm run db:migrate
npm run seed:admin && npm run seed:tariffs
pm2 start ecosystem.config.cjs && pm2 save      # energy-web (on PORT) + energy-poller
```

Then point an Nginx reverse proxy with HTTPS at `127.0.0.1:$PORT`, and set `BETTER_AUTH_URL` to the public
`https://` address.

---

## Configuration reference

All settings go in `.env` (template: [.env.example](.env.example)).

| Variable | Required | Description |
|---|---|---|
| `DATABASE_URL` | Yes | `postgres://user:password@host:5432/db` |
| `POSTGRES_PASSWORD` | Docker only | Password for the bundled Postgres |
| `BETTER_AUTH_SECRET` | Yes | Random 32+ character secret |
| `BETTER_AUTH_URL` | Yes | Public URL of the site, exactly as users open it |
| `PORT` | PM2 | Port the web app listens on (default `3100`) |
| `TUYA_BASE_URL` | Yes | Tuya data centre, e.g. `https://openapi.tuyaeu.com` |
| `TUYA_ACCESS_ID` / `TUYA_ACCESS_SECRET` | Yes | Tuya cloud project keys |
| `POLL_INTERVAL_SECONDS` | No | Breaker poll interval (default `60`, minimum `10`) |
| `READINGS_RETENTION_DAYS` | No | Days of per-minute readings to keep (default `180`) |
| `DEYE_BASE_URL` | No | Deye OpenAPI base (default EU: `https://eu1-developer.deyecloud.com/v1.0`) |
| `DEYE_APP_ID` / `DEYE_APP_SECRET` | For Deye | Deye developer application |
| `DEYE_POLL_SECONDS` | No | Deye poll interval (default `300`, minimum `60`) |
| `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD` / `SEED_ADMIN_NAME` | For seeding | First super admin |

---

## First-time setup in the app

1. **Profiles** (super admin): create a household profile and paste its Tuya account UID.
2. **Users**: create logins and add them to the profile.
3. **Tariffs**: check the rates. When BERC changes them, use **Add new rates** with the start date; don't edit
   old versions.
4. **Meters**: add each utility meter with its tariff, sanctioned load, meter rent, rebate % and cycle start
   day. Optionally enter **units used this cycle so far**. For prepaid meters, enter the **balance**.
5. **Devices**: add each 63T under its meter. Link Deye inverters under **Solar inverters**.

---

## Scripts

| Script | What it does |
|---|---|
| `npm run dev` / `build` / `start` | Next.js development server, production build, production server |
| `npm run poller` | The poller (`-- --once` for a single run) |
| `npm run db:generate` / `db:migrate` / `db:studio` | Create a migration from the schema, apply migrations, browse the database |
| `npm run seed:admin` / `seed:tariffs` | First super admin, default tariff (both safe to re-run) |
| `npm test` | Unit tests |
| `npm run typecheck` / `lint` | Type and lint checks |

---

## Project structure

| Path | |
|---|---|
| `src/app/(app)/` | Pages: home dashboard, bills, meters, devices, tariffs, admin (profiles, users) |
| `src/components/dashboard/` | Dashboard views: meter view, Solar tab, slab ladder, charts |
| `src/lib/tuya/` | Tuya Cloud client (HMAC signing, token, batch status) and data-point decoding |
| `src/lib/deye/` | Deye Cloud client (token per account, stations, latest, daily history) and decoding |
| `src/lib/poll.ts` | One breaker poll cycle |
| `src/lib/solar-poll.ts` | Deye snapshots, daily totals, history backfill |
| `src/lib/energy.ts` | Counter deltas, reset handling, Dhaka day boundaries |
| `src/lib/billing.ts` | Bill maths, price steps, cycles, cost shares, solar saving (pure functions) |
| `src/lib/billing-data.ts` | Meter bills, projections, prepaid balance, storing finished bills |
| `src/lib/dashboard-data.ts` | Builds the dashboard and Solar tab data |
| `src/db/schema.ts` | Database schema; migrations in `drizzle/` |
| `scripts/` | Poller and seed scripts |

Design notes: [PLAN.md](PLAN.md) (decisions and data model), [PRODUCT.md](PRODUCT.md) (who it's for),
[DESIGN.md](DESIGN.md) (visual system).

---

## Updating, backups and troubleshooting

**Update** a PM2 install:

```sh
git pull && npm ci --no-audit --no-fund && npm run build && npm run db:migrate && pm2 restart energy-web energy-poller
```

**Back up** before updates that add migrations:

```sh
pg_dump "$DATABASE_URL" | gzip > ~/backups/energy-$(date +%F).sql.gz
```

[DEPLOY.md](DEPLOY.md) covers daily backups, Docker updates and a troubleshooting table. Common ones:

| Symptom | Check |
|---|---|
| "No readings yet today" | `pm2 logs energy-poller`. `Tuya token` errors mean wrong keys or an expired Tuya trial. |
| `poll failed: fetch failed` now and then | A short internet drop; the next poll catches up from the energy counter. |
| Solar tab says "last report N minutes ago" | The inverter's Wi-Fi logger stopped uploading to Deye Cloud; check the Deye app. |
| Login works on localhost but not the domain | `BETTER_AUTH_URL` must match the public URL exactly. Restart after changing it. |
