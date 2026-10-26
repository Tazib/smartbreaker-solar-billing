import { formatDistanceToNowStrict } from "date-fns";
import Link from "next/link";
import { Sun, TriangleAlert } from "lucide-react";
import type { DashboardView as View, ViewDevice } from "@/lib/dashboard-data";
import { kwh, period, shortDate, tk, watts } from "@/lib/format";
import { cn } from "@/lib/utils";
import { AnimatedNumber } from "@/components/animated-number";
import { EnergyCharts } from "./energy-charts";
import { SlabLadder } from "./slab-ladder";

/** Everything for one view (all meters, or a single meter), top to bottom by importance. */
export function DashboardView({ view }: { view: View }) {
  return (
    <div className="grid min-w-0 gap-5">
      <Hero view={view} />
      <StatStrip view={view} />
      <BalancePanel view={view} />
      {view.ladders.length > 0 && (
        <Panel title="Price steps" note={view.ladders.length === 1 ? undefined : "Each meter is billed on its own"} i={2}>
          <div className="grid gap-8">
            {view.ladders.map((l) => (
              <SlabLadder key={l.meterId} ladder={l} showLabel={view.ladders.length > 1} />
            ))}
          </div>
        </Panel>
      )}
      <Panel title="Usage" i={3}>
        <EnergyCharts
          power={view.power}
          daily={view.daily}
          monthly={view.monthly}
          hasSolar={view.hasSolar}
          powerSolarLabel="Solar & battery"
        />
      </Panel>
      {view.costs.total > 0 && (
        <Panel title="Where the money goes" note={`${tk(view.costs.total)} this cycle so far`} i={4}>
          <CostList costs={view.costs} showMeter={view.meterCount > 1} />
        </Panel>
      )}
      <Panel title="Breakers" note={`${view.devices.length} tracked`} i={5}>
        <BreakerList devices={view.devices} showMeter={view.meterCount > 1} />
      </Panel>
    </div>
  );
}

export function Panel({
  title,
  note,
  i = 0,
  children,
  className,
}: {
  title?: string;
  note?: string;
  i?: number;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section
      className={cn("rise min-w-0 rounded-3xl bg-card p-5 ring-1 ring-foreground/[0.07] sm:p-7", className)}
      style={{ "--i": i } as React.CSSProperties}
    >
      {title && (
        <div className="mb-5 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <h2 className="text-[0.95rem] font-semibold tracking-tight">{title}</h2>
          {note && <span className="text-xs text-muted-foreground">{note}</span>}
        </div>
      )}
      {children}
    </section>
  );
}

function Hero({ view }: { view: View }) {
  const total = (view.liveGridW ?? 0) + (view.liveSolarW ?? 0);
  // With solar, the whole home: grid plus what the inverter supplies from panels and battery.
  const usingNow = view.liveGridW === null && view.liveSolarW === null ? null : view.hasSolar ? total : view.liveGridW;
  const gridShare = total > 0 ? (view.liveGridW ?? 0) / total : 1;
  const progress = view.cycleProgress;

  return (
    <section
      className="rise grid min-w-0 overflow-hidden rounded-3xl bg-card ring-1 ring-foreground/[0.07] md:grid-cols-2"
      style={{ "--i": 0 } as React.CSSProperties}
    >
      <div className="grid min-w-0 content-between gap-6 p-6 sm:p-8">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-sm font-medium text-muted-foreground">Using now</h2>
          <LiveBadge at={view.lastReadingAt} />
        </div>
        <div>
          {usingNow === null ? (
            <div className="text-[3.25rem] leading-none font-semibold tracking-[-0.04em] text-muted-foreground/50 sm:text-[4rem]">—</div>
          ) : (
            <AnimatedNumber
              value={usingNow}
              format="power"
              className="block text-[3.25rem] leading-none font-semibold tracking-[-0.04em] sm:text-[4rem]"
              unitClassName="ml-1.5 text-[0.4em] font-medium tracking-normal text-muted-foreground"
            />
          )}
          <p className="mt-2 text-sm text-muted-foreground">
            {usingNow === null
              ? "Waiting for a live reading from the breakers"
              : view.hasSolar
                ? "From the grid, solar and battery together"
                : "From the grid"}
          </p>
        </div>
        {view.hasSolar ? (
          <div className="grid gap-2.5">
            {total > 0 && (
              <div className="flex h-1.5 gap-[3px] overflow-hidden rounded-full">
                <div className="fill-bar rounded-full bg-grid" style={{ flexGrow: gridShare, flexBasis: 0 }} />
                <div className="fill-bar rounded-full bg-solar" style={{ flexGrow: 1 - gridShare, flexBasis: 0 }} />
              </div>
            )}
            <div className="flex flex-wrap gap-x-5 gap-y-1 text-sm">
              <Legend color="bg-grid" label="Grid" value={view.liveGridW} />
              <Legend color="bg-solar" label="Solar & battery" value={view.liveSolarW} />
            </div>
          </div>
        ) : (
          view.peakToday && (
            <div className="flex items-baseline justify-between gap-3 border-t border-border pt-4 text-sm">
              <span className="text-muted-foreground">Peak today</span>
              <span className="tabular-nums">
                <span className="font-semibold">{watts(view.peakToday.w)}</span>
                <span className="text-muted-foreground"> at {timeFmt.format(view.peakToday.ts)}</span>
              </span>
            </div>
          )
        )}
      </div>

      <div className="grid min-w-0 content-between gap-6 border-t border-border p-6 sm:p-8 md:border-t-0 md:border-l">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-sm font-medium text-muted-foreground">Projected bill</h2>
          {progress && (
            <span className="text-xs text-muted-foreground tabular-nums">
              Day {progress.day} of {progress.of}
            </span>
          )}
        </div>
        <div>
          {view.hasCycle ? (
            <AnimatedNumber
              value={view.projectedBill}
              format="tk0"
              className="block text-[3.25rem] leading-none font-semibold tracking-[-0.04em] sm:text-[4rem]"
            />
          ) : (
            <div className="text-[3.25rem] leading-none font-semibold tracking-[-0.04em] text-muted-foreground/50 sm:text-[4rem]">—</div>
          )}
          <p className="mt-2 text-sm text-muted-foreground">
            {view.hasCycle ? (
              <>
                {tk(view.billSoFar)} so far · about {kwh(Math.round(view.projectedKwh))}
                {progress && ` by ${shortDate(progress.end)}`}
                {!view.projectionReliable && (
                  <span className="mt-1 block text-xs">Rough estimate until there&apos;s a full day of readings.</span>
                )}
              </>
            ) : (
              "Add tariff rates to see the bill"
            )}
          </p>
        </div>
        {progress && (
          <div className="grid gap-2">
            <div className="h-1.5 overflow-hidden rounded-full bg-foreground/[0.07]">
              <div className="fill-bar h-full rounded-full bg-foreground/70" style={{ transform: `scaleX(${progress.day / progress.of})` }} />
            </div>
            <div className="flex justify-between text-xs text-muted-foreground">
              <span>{period(progress.start, progress.end)}</span>
              {view.partialFrom && <span>Partial: tracking began {view.partialFrom}</span>}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

const timeFmt = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Dhaka" });

function LiveBadge({ at }: { at: number | null }) {
  if (at === null) return <span className="text-xs text-muted-foreground">No live data</span>;
  return (
    <span className="flex items-center gap-2 text-xs font-medium text-grid">
      <span className="live-dot" />
      Live
      <span className="font-normal text-muted-foreground">· {formatDistanceToNowStrict(at, { addSuffix: true })}</span>
    </span>
  );
}

function Legend({ color, label, value }: { color: string; label: string; value: number | null }) {
  return (
    <span className="flex items-center gap-2">
      <span className={cn("size-2 rounded-full", color)} />
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium tabular-nums">{value === null ? "—" : watts(value)}</span>
    </span>
  );
}

function StatStrip({ view }: { view: View }) {
  const cells: { label: string; value: number; format: "kwh" | "tk"; hint?: string; solar?: boolean }[] = [
    { label: "Today", value: view.todayGridKwh, format: "kwh", hint: view.todayCost > 0 ? `≈ ${tk(view.todayCost)}` : undefined },
    { label: "This cycle", value: view.cycleKwh, format: "kwh", hint: view.hasCycle ? `${tk(view.billSoFar)} with charges` : undefined },
    ...(view.hasSolar
      ? [
          { label: "Solar today", value: view.todaySolarKwh, format: "kwh" as const, solar: true },
          { label: "Saved by solar", value: view.solarSaving, format: "tk" as const, hint: `${kwh(view.solarCycleKwh)} this cycle`, solar: true },
        ]
      : [
          {
            label: "Daily average",
            value: view.dailyAverage,
            format: "kwh" as const,
            hint: view.partialFrom ? "Since tracking began" : "This cycle",
          },
          { label: "Bill so far", value: view.billSoFar, format: "tk" as const, hint: "Incl. demand charge, rent, VAT" },
        ]),
  ];

  return (
    <section
      className="rise grid grid-cols-2 overflow-hidden rounded-3xl bg-card ring-1 ring-foreground/[0.07] lg:grid-cols-4"
      style={{ "--i": 1 } as React.CSSProperties}
    >
      {cells.map((c, i) => (
        <div
          key={c.label}
          className={cn(
            "grid gap-1.5 p-5 sm:p-6",
            i % 2 === 1 && "border-l border-border",
            i >= 2 && "border-t border-border lg:border-t-0",
            i === 2 && "lg:border-l",
          )}
        >
          <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
            {c.solar && <Sun className="size-3.5 text-solar" aria-hidden />}
            {c.label}
          </div>
          <AnimatedNumber value={c.value} format={c.format} className="text-2xl font-semibold tracking-[-0.025em]" />
          {c.hint && <div className="text-xs text-muted-foreground">{c.hint}</div>}
        </div>
      ))}
    </section>
  );
}

function BreakerList({ devices, showMeter }: { devices: ViewDevice[]; showMeter: boolean }) {
  if (devices.length === 0) {
    return <p className="text-sm text-muted-foreground">No breakers yet. Add them on the Devices page.</p>;
  }
  const max = Math.max(...devices.map((d) => d.live?.powerW ?? 0), 1);
  return (
    <ul className="-mx-2 grid min-w-0">
      {devices.map((d) => {
        const w = d.live?.powerW ?? null;
        const state = !d.active ? "Paused" : d.live ? "Live" : d.online === false ? "Offline" : "No data";
        return (
          <li
            key={d.id}
            className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-4 gap-y-2 rounded-xl px-2 py-3 transition-colors hover:bg-foreground/[0.03] sm:grid-cols-[auto_minmax(0,1.2fr)_minmax(0,1fr)_auto]"
          >
            <span
              className={cn(
                "size-2 rounded-full",
                state === "Live" ? (d.source === "solar" ? "bg-solar" : "bg-grid") : state === "Offline" ? "bg-destructive" : "bg-foreground/25",
              )}
              title={state}
            />
            <div className="min-w-0">
              <div className="flex items-center gap-2 truncate text-sm font-medium">
                {d.name}
                {d.source === "solar" && <Sun className="size-3.5 shrink-0 text-solar" aria-label="Solar" />}
              </div>
              <div className="truncate text-xs text-muted-foreground">
                {state === "Live" ? (
                  <>
                    {d.live?.voltageV != null && `${d.live.voltageV.toFixed(0)} V`}
                    {d.live?.currentA != null && ` · ${d.live.currentA.toFixed(2)} A`}
                    {d.live?.leakageMa != null && d.live.leakageMa > 0 && ` · leak ${d.live.leakageMa} mA`}
                    {d.live?.inverterW != null && d.live.inverterW > 0 && ` · ${watts(d.live.inverterW)} from inverter (ATS)`}
                  </>
                ) : (
                  <>
                    {state}
                    {d.lastSeenAt && ` · ${formatDistanceToNowStrict(d.lastSeenAt, { addSuffix: true })}`}
                  </>
                )}
                {showMeter && ` · ${d.meterLabel}`}
              </div>
            </div>
            <div className="col-span-3 hidden h-1 overflow-hidden rounded-full bg-foreground/[0.06] sm:col-span-1 sm:block">
              <div
                className={cn("fill-bar h-full rounded-full", d.source === "solar" ? "bg-solar" : "bg-grid")}
                style={{ transform: `scaleX(${w === null ? 0 : w / max})` }}
              />
            </div>
            <div className="text-right">
              {w === null ? (
                <div className="text-sm text-muted-foreground">—</div>
              ) : (
                <AnimatedNumber value={w} format="power" className="text-sm font-semibold" unitClassName="ml-0.5 text-xs font-normal text-muted-foreground" />
              )}
              <div className="text-xs text-muted-foreground tabular-nums">{kwh(d.todayKwh)} today</div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function BalancePanel({ view }: { view: View }) {
  if (view.balances.length === 0) {
    if (view.prepaidWithoutBalance === 0) return null;
    return (
      <Link
        href="/meters"
        className="rise flex items-center justify-between gap-3 rounded-2xl border border-dashed border-border px-5 py-4 text-sm transition-colors hover:bg-foreground/[0.03]"
        style={{ "--i": 1 } as React.CSSProperties}
      >
        <span>
          <span className="font-medium">Track your prepaid balance.</span>{" "}
          <span className="text-muted-foreground">Enter what the meter shows and see how many days it will last.</span>
        </span>
        <span className="shrink-0 font-medium text-grid">Set balance →</span>
      </Link>
    );
  }

  return (
    <Panel title="Prepaid balance" note={view.balances.length > 1 ? "Estimated from usage and recharges" : undefined} i={1}>
      <div className={cn("grid gap-6", view.balances.length > 1 && "md:grid-cols-2")}>
        {view.balances.map(({ meterId, label, balance: b }) => {
          const low = b.balanceTk <= 0 || (b.daysLeft !== null && b.daysLeft < 3);
          const cover = b.daysLeft === null ? 0 : Math.min(b.daysLeft / 30, 1);
          return (
            <div key={meterId} className="grid content-start gap-3">
              {view.balances.length > 1 && <div className="text-sm font-medium">{label}</div>}
              <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                <AnimatedNumber value={b.balanceTk} format="tk" className="text-[2rem] leading-none font-semibold tracking-[-0.03em]" />
                <span className="text-sm text-muted-foreground tabular-nums">
                  {b.daysLeft === null ? "Not enough usage yet" : `about ${Math.floor(b.daysLeft)} day${Math.floor(b.daysLeft) === 1 ? "" : "s"} left`}
                </span>
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-foreground/[0.07]" aria-hidden>
                <div
                  className={cn("fill-bar h-full rounded-full", low ? "bg-warning" : "bg-foreground/70")}
                  style={{ transform: `scaleX(${cover})` }}
                />
              </div>
              {low ? (
                <div className="flex items-start gap-2 rounded-xl bg-warning-surface px-3 py-2 text-sm text-warning">
                  <TriangleAlert className="mt-0.5 size-4 shrink-0" />
                  <span className="font-medium">{b.balanceTk <= 0 ? "Balance may have run out. Recharge now." : "Recharge soon."}</span>
                </div>
              ) : null}
              <p className="text-xs text-muted-foreground">
                {b.dailySpendTk > 0 && `${tk(b.dailySpendTk)} a day at this cycle's pace. `}
                {b.lastRecharge
                  ? `Last recharge ${tk(b.lastRecharge.amountTk)} on ${dateFmt.format(b.lastRecharge.at)}.`
                  : `Balance set on ${dateFmt.format(b.anchorAt)}.`}
              </p>
            </div>
          );
        })}
      </div>
    </Panel>
  );
}

const dateFmt = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "Asia/Dhaka" });

function CostList({ costs, showMeter }: { costs: View["costs"]; showMeter: boolean }) {
  const rows = [
    ...costs.shares.map((s) => ({ key: s.key, label: s.label, sub: showMeter ? s.meterLabel : null, kwh: s.kwh, tk: s.tk, kind: s.key.startsWith("before-") ? "muted" : "grid" })),
    { key: "fixed", label: "Fixed charges", sub: "Demand charge, meter rent, VAT", kwh: null, tk: costs.fixed, kind: "muted" },
  ] as { key: string; label: string; sub: string | null; kwh: number | null; tk: number; kind: "grid" | "muted" }[];
  const max = Math.max(...rows.map((r) => r.tk), 1);

  return (
    <ul className="grid min-w-0 gap-4">
      {rows.map((r) => (
        <li key={r.key} className="grid min-w-0 gap-1.5">
          <div className="flex min-w-0 items-end justify-between gap-3 text-sm">
            <span className="grid min-w-0">
              <span className="truncate font-medium">{r.label}</span>
              {r.sub && <span className="truncate text-xs text-muted-foreground">{r.sub}</span>}
            </span>
            <span className="shrink-0 tabular-nums">
              {r.kwh !== null && <span className="text-muted-foreground">{kwh(Math.round(r.kwh * 10) / 10)} · </span>}
              <span className="font-semibold">{tk(r.tk)}</span>
              <span className="ml-1.5 inline-block w-9 text-right text-xs text-muted-foreground">
                {costs.total > 0 ? `${Math.round((r.tk / costs.total) * 100)}%` : ""}
              </span>
            </span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-foreground/[0.06]" aria-hidden>
            <div
              className={cn("fill-bar h-full rounded-full", r.kind === "grid" ? "bg-grid" : "bg-foreground/30")}
              style={{ transform: `scaleX(${r.tk / max})` }}
            />
          </div>
        </li>
      ))}
    </ul>
  );
}
