import React, { useEffect, useMemo, useRef, useState } from "react";

/** =========================================================================
 * Execution Planner — Pro Co-Pilot (Client-Side Only)
 * - Per-order market preset & profile (Quiet/Normal/Volatile)
 * - Simple vs Advanced view (per order)
 * - Pacing: accumulated planned vs accumulated executed (at “now”)
 * - Multi-level alerts: critical toast, market-state banner, inline hints
 * - Orders Rail (click to focus), rename, duplicate, remove, mark complete
 * - OTD fix: reserve auction % is withheld before slicing
 * - Post-Trade Report Card (planned vs actual + suggestions)
 * - What-If Simulator: multi legs (qty@price) → new VWAP & completion
 * - Impact Score (1-10), Required Rate to Catch Up, Cap pressure flags
 * - CSV export
 * =========================================================================*/

/* -------------------- Types -------------------- */
type ExecMode = "OTD" | "INLINE";
type CapMode = "NONE" | "PCT";
type Curve = "equal" | "ucurve";
type Side = "BUY" | "SELL";
type MarketKey = "Egypt" | "Kuwait" | "Qatar" | "DFM" | "ADX" | "Saudi";
type ProfileKey = "Quiet" | "Normal" | "Volatile";

type Snapshot = {
  at: string; // HH:MM:SS
  currentVol: number;
  expectedContVol: number;
  expectedAuctionVol: number;
  orderExecQty: number;
  orderExecNotional: number;
  marketTurnover: number;
  marketVWAPInput: number;
  note?: string;
};

type Order = {
  id: string;
  name: string;
  symbol: string;
  side: Side;

  orderQty: number;

  execMode: ExecMode;
  capMode: CapMode;
  maxPart: number; // %
  reserveAuctionPct: number; // %
  deferCompletion: boolean;

  sessionStart: string;
  sessionEnd: string;
  auctionStart: string;
  auctionEnd: string;
  talStart: string;
  talEnd: string;
  intervalMins: number;
  curve: Curve;

  // volumes (user-updated intraday)
  startVol: number;        // volume before market open (if applicable)
  currentVol: number;      // cum vol so far in continuous
  expectedContVol: number; // forecast rest of continuous
  expectedAuctionVol: number;

  // VWAP monitor
  marketTurnover: number;   // if >0, implies VWAP = turnover/currentVol
  marketVWAPInput: number;  // manual override if turnover unavailable

  // execution so far
  orderExecQty: number;
  orderExecNotional: number;

  // UI helpers
  market?: MarketKey;
  profile?: ProfileKey;
  startFromNow?: boolean;
  showAdvanced?: boolean;
  completed?: boolean;

  // history
  snapshots: Snapshot[];
};

/* -------------------- Presets -------------------- */
const MARKET_PRESET: Record<
  MarketKey,
  { start: string; auction: string; auctionMatch: string; talStart: string; talEnd: string }
> = {
  Egypt: { start: "10:00", auction: "14:15", auctionMatch: "14:25", talStart: "14:25", talEnd: "14:30" },
  Kuwait:{ start: "09:00", auction: "12:30", auctionMatch: "12:40", talStart: "12:40", talEnd: "12:45" },
  Qatar: { start: "09:30", auction: "13:00", auctionMatch: "13:10", talStart: "13:10", talEnd: "13:15" },
  DFM:   { start: "09:00", auction: "13:45", auctionMatch: "13:55", talStart: "13:55", talEnd: "14:00" },
  ADX:   { start: "09:00", auction: "13:45", auctionMatch: "13:55", talStart: "13:55", talEnd: "14:00" },
  Saudi: { start: "10:00", auction: "15:00", auctionMatch: "15:10", talStart: "15:10", talEnd: "15:20" },
};

const MARKET_PROFILES: Record<ProfileKey, { contMult: number; auctionMult: number; label: string }> = {
  Quiet:    { contMult: 0.8,  auctionMult: 0.8,  label: "Lower expected volume" },
  Normal:   { contMult: 1.0,  auctionMult: 1.0,  label: "Baseline expected volume" },
  Volatile: { contMult: 1.25, auctionMult: 1.15, label: "Higher expected volume" },
};

/* -------------------- Utilities -------------------- */
function minutesBetween(t1: string, t2: string) {
  const [h1, m1] = t1.split(":").map((x) => parseInt(x || "0", 10));
  const [h2, m2] = t2.split(":").map((x) => parseInt(x || "0", 10));
  return h2 * 60 + m2 - (h1 * 60 + m1);
}
function addMinutes(t: string, mins: number) {
  const [h, m] = t.split(":").map((x) => parseInt(x || "0", 10));
  const total = h * 60 + m + mins;
  const hh = Math.floor(total / 60) % 24;
  const mm = ((total % 60) + 60) % 60;
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}
function timeSlices(start: string, end: string, step: number) {
  const out: { s: string; e: string; label: string }[] = [];
  const total = Math.max(0, minutesBetween(start, end));
  const n = Math.max(1, Math.ceil(total / step));
  for (let i = 0; i < n; i++) {
    const s = addMinutes(start, i * step);
    const e = i === n - 1 ? end : addMinutes(start, (i + 1) * step);
    out.push({ s, e, label: `${s} – ${e}` });
  }
  return out;
}
function uCurveWeights(n: number) {
  if (n <= 0) return [] as number[];
  const w: number[] = [];
  const mid = (n - 1) / 2;
  for (let i = 0; i < n; i++) {
    const x = Math.abs(i - mid) / (mid || 1);
    w.push(0.6 + 0.8 * (1 - x));
  }
  const sum = w.reduce((a, b) => a + b, 0) || 1;
  return w.map((x) => x / sum);
}
function equalWeights(n: number) {
  if (n <= 0) return [] as number[];
  return Array(n).fill(1 / n);
}
function formatInt(n: number | null | undefined) {
  if (n == null || isNaN(n as any)) return "";
  return Math.trunc(Number(n)).toLocaleString();
}
function parseIntSafe(v: string) {
  const digits = v.replace(/[^0-9]/g, "");
  return digits ? parseInt(digits, 10) : 0;
}
function formatMoney(n: number | null | undefined, decimals = 4) {
  if (n == null || isNaN(n as any)) return "";
  return Number(n).toLocaleString(undefined, {
    maximumFractionDigits: decimals,
    minimumFractionDigits: 0,
  });
}
function parseMoneySafeAllowTyping(v: string) {
  const cleaned = v.replace(/[^0-9.]/g, "");
  const parts = cleaned.split(".");
  if (parts.length > 2) return parts[0] + "." + parts.slice(1).join("");
  return cleaned;
}
function toNumberOrZero(v: string) {
  const n = parseFloat(v);
  return isNaN(n) ? 0 : n;
}
function nowHHMM() {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
function nowHHMMSS() {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
}
function useInterval(cb: () => void, delay: number | null) {
  const ref = useRef(cb);
  useEffect(() => { ref.current = cb; }, [cb]);
  useEffect(() => {
    if (delay == null) return;
    const id = setInterval(() => ref.current(), delay);
    return () => clearInterval(id);
  }, [delay]);
}
function sideTheme(side: Side) {
  return side === "BUY"
    ? { text: "text-emerald-700", bgSoft: "bg-emerald-50", border: "border-emerald-300", strong: "bg-emerald-600" }
    : { text: "text-rose-700", bgSoft: "bg-rose-50", border: "border-rose-300", strong: "bg-rose-600" };
}
function performanceBps(side: Side, orderVWAP: number, marketVWAP: number) {
  if (!marketVWAP || !orderVWAP) return 0;
  return side === "BUY"
    ? ((marketVWAP - orderVWAP) / marketVWAP) * 10000
    : ((orderVWAP - marketVWAP) / marketVWAP) * 10000;
}

/* -------------------- Defaults -------------------- */
function defaultOrder(side: Side, idx = 1): Order {
  return {
    id: Math.random().toString(36).slice(2, 9),
    name: side === "BUY" ? `Buy ${idx}` : `Sell ${idx}`,
    symbol: "QNBK",
    side,
    orderQty: 1_600_000,

    execMode: "OTD",
    capMode: "PCT",
    maxPart: 15,
    reserveAuctionPct: 10,
    deferCompletion: true,

    sessionStart: "09:30",
    sessionEnd: "13:00",
    auctionStart: "13:00",
    auctionEnd: "13:10",
    talStart: "13:10",
    talEnd: "13:15",
    intervalMins: 30,
    curve: "ucurve",

    startVol: 0,
    currentVol: 0,
    expectedContVol: 800_000,
    expectedAuctionVol: 400_000,

    marketTurnover: 0,
    marketVWAPInput: 0,

    orderExecQty: 0,
    orderExecNotional: 0,

    market: "Qatar",
    profile: "Normal",
    startFromNow: false,
    showAdvanced: false,
    completed: false,

    snapshots: [],
  };
}

/* -------------------- Planning & analytics -------------------- */
function applyCap(capMode: CapMode, maxPart: number, qty: number, sliceVol: number) {
  if (capMode === "NONE") return Math.max(0, Math.floor(qty));
  const allowed = Math.floor((sliceVol * maxPart) / 100);
  return Math.max(0, Math.min(Math.floor(qty), allowed));
}

type BuiltPlan = {
  rows: Array<{ interval: string; s: string; e: string; expMktVol: number; maxAllowed: number | "∞"; suggestedQty: number; highImpact?: boolean }>;
  contPlanned: number;
  auctionAllowed: number;
  auctionPlanned: number;
  accPlanByTime: (tHHMM: string) => number; // accumulated suggested up to t
};

function buildPlan(order: Order): BuiltPlan {
  const slices = timeSlices(order.sessionStart, order.sessionEnd, order.intervalMins);
  const weights = order.curve === "equal" ? equalWeights(slices.length) : uCurveWeights(slices.length);
  const contVolPerSlice = weights.map((w) => Math.floor(w * order.expectedContVol));

  // OTD FIX: reserve is withheld BEFORE slicing
  const reserveAuctionQty = Math.floor((order.orderQty * order.reserveAuctionPct) / 100);
  const targetContinuousQty = Math.max(0, order.orderQty - reserveAuctionQty);

  const auctionAllowed =
    order.capMode === "PCT" ? Math.floor((order.expectedAuctionVol * order.maxPart) / 100) : order.expectedAuctionVol;

  let rows: BuiltPlan["rows"] = [];

  if (order.execMode === "OTD") {
    let remaining = targetContinuousQty;
    rows = slices.map((slice, i) => {
      const sliceVol = Math.max(0, contVolPerSlice[i]);
      let base = Math.floor(weights[i] * targetContinuousQty);
      base = Math.min(base, remaining);
      let suggested = applyCap(order.capMode, order.maxPart, base, sliceVol);

      // keep some for last/auction if defer
      const isLast = i === slices.length - 1;
      if (order.deferCompletion && !isLast) {
        const keepBack = Math.ceil(targetContinuousQty * 0.05);
        if (remaining - suggested <= 0) suggested = Math.max(0, remaining - keepBack);
      }
      suggested = Math.min(suggested, remaining);
      remaining -= suggested;

      // flag high impact if suggested > 25% of expected volume
      const highImpact = sliceVol > 0 && suggested / sliceVol > 0.25;

      return {
        interval: slice.label,
        s: slice.s,
        e: slice.e,
        expMktVol: sliceVol,
        maxAllowed: order.capMode === "PCT" ? Math.floor((sliceVol * order.maxPart) / 100) : "∞",
        suggestedQty: suggested,
        highImpact,
      };
    });

    const contPlanned = rows.reduce((a, r) => a + r.suggestedQty, 0);
    const auctionPlanned = Math.min(reserveAuctionQty, auctionAllowed);

    const accPlanByTime = (t: string) =>
      rows.filter((r) => r.s <= t + ":00").reduce((a, r) => a + r.suggestedQty, 0);

    return { rows, contPlanned, auctionAllowed, auctionPlanned, accPlanByTime };
  }

  // INLINE (POV)
  const expectedTotalVol = order.currentVol + order.expectedContVol + order.expectedAuctionVol;
  const pov = expectedTotalVol > 0 ? Math.min(1, order.orderQty / expectedTotalVol) : 0;

  rows = slices.map((slice, i) => {
    const sliceVol = Math.max(0, contVolPerSlice[i]);
    const base = Math.floor(sliceVol * pov);
    const suggested = applyCap(order.capMode, order.maxPart, base, sliceVol);
    const highImpact = sliceVol > 0 && suggested / sliceVol > 0.25;
    return {
      interval: slice.label,
      s: slice.s,
      e: slice.e,
      expMktVol: sliceVol,
      maxAllowed: order.capMode === "PCT" ? Math.floor((sliceVol * order.maxPart) / 100) : "∞",
      suggestedQty: suggested,
      highImpact,
    };
  });

  const contPlanned = rows.reduce((a, r) => a + r.suggestedQty, 0);
  let auctionPlanned =
    order.capMode === "PCT"
      ? Math.floor((order.expectedAuctionVol * pov * order.maxPart) / 100)
      : Math.floor(order.expectedAuctionVol * pov);

  // Do not exceed total; shave if needed
  let totalPlanned = contPlanned + auctionPlanned;
  if (totalPlanned > order.orderQty) {
    const excess = totalPlanned - order.orderQty;
    if (order.deferCompletion) {
      for (let i = rows.length - 1; i >= 0 && excess > 0; i--) {
        const trim = Math.min(excess, rows[i].suggestedQty);
        rows[i].suggestedQty -= trim;
        totalPlanned -= trim;
      }
    } else {
      auctionPlanned = Math.max(0, auctionPlanned - excess);
    }
  }

  const accPlanByTime = (t: string) =>
    rows.filter((r) => r.s <= t + ":00").reduce((a, r) => a + r.suggestedQty, 0);

  return { rows, contPlanned, auctionAllowed, auctionPlanned, accPlanByTime };
}

/* -------------------- Small UI atoms -------------------- */
function HeaderStat({ title, value }: { title: string; value: React.ReactNode }) {
  return (
    <div className="p-3 rounded-xl bg-slate-100">
      <div className="opacity-60 text-xs">{title}</div>
      <div className="font-semibold">{value}</div>
    </div>
  );
}
function IntInput({
  label,
  value,
  onChange,
  className,
}: {
  label?: string;
  value: number;
  onChange: (n: number) => void;
  className?: string;
}) {
  const [draft, setDraft] = useState(formatInt(value));
  useEffect(() => setDraft(formatInt(value)), [value]);
  return (
    <label className={`text-sm ${className || ""}`}>
      {label}
      <input
        inputMode="numeric"
        pattern="[0-9]*"
        className="mt-1 w-full border rounded-xl p-2"
        value={draft}
        onChange={(e) => {
          const n = parseIntSafe(e.target.value);
          setDraft(formatInt(n));
          onChange(n);
        }}
      />
    </label>
  );
}
function MoneyInput({
  label,
  value,
  onNumberChange,
  className,
  decimals = 4,
}: {
  label?: string;
  value: number;
  onNumberChange: (n: number) => void;
  className?: string;
  decimals?: number;
}) {
  const [draft, setDraft] = useState(value === 0 ? "" : String(value));
  useEffect(() => setDraft(value === 0 ? "" : String(value)), [value]);
  return (
    <label className={`text-sm ${className || ""}`}>
      {label}
      <input
        inputMode="decimal"
        className="mt-1 w-full border rounded-xl p-2"
        value={draft}
        onChange={(e) => {
          const next = parseMoneySafeAllowTyping(e.target.value);
          setDraft(next);
          onNumberChange(toNumberOrZero(next));
        }}
        onBlur={() => {
          const n = toNumberOrZero(draft);
          setDraft(n ? formatMoney(n, decimals) : "");
          onNumberChange(n);
        }}
        onFocus={() => {
          const n = toNumberOrZero(draft);
          if (n) setDraft(String(n));
        }}
      />
    </label>
  );
}

/* -------------------- VWAP box -------------------- */
function VWAPBox({ order }: { order: Order }) {
  const marketVWAP =
    order.currentVol > 0
      ? order.marketTurnover > 0
        ? order.marketTurnover / order.currentVol
        : order.marketVWAPInput || 0
      : order.marketVWAPInput || 0;

  const orderVWAP = order.orderExecQty > 0 ? order.orderExecNotional / order.orderExecQty : 0;
  const perf = performanceBps(order.side, orderVWAP, marketVWAP);
  const color = perf > 0 ? "text-green-600" : perf < 0 ? "text-red-600" : "";

  return (
    <div className="grid md:grid-cols-4 gap-3 text-sm mt-2">
      <HeaderStat title="Market VWAP" value={marketVWAP ? formatMoney(marketVWAP, 4) : "—"} />
      <HeaderStat title="Order VWAP" value={orderVWAP ? formatMoney(orderVWAP, 4) : "—"} />
      <HeaderStat title="Perf (bps)" value={<span className={color}>{Number.isFinite(perf) ? perf.toFixed(1) : "—"}</span>} />
      <HeaderStat title="Exec Qty" value={formatInt(order.orderExecQty)} />
    </div>
  );
}

/* -------------------- Coaching / Impact -------------------- */
function impactScore(order: Order, plan: BuiltPlan, nowHHmm: string) {
  // Based on remaining qty, slices left, cap binding pressure
  const plannedToNow = plan.accPlanByTime(nowHHmm);
  const remainingQty = Math.max(0, order.orderQty - plannedToNow);
  const liveIdx = plan.rows.findIndex((r) => nowHHmm + ":00" >= r.s && nowHHmm + ":00" < r.e);
  const slicesLeft = liveIdx >= 0 ? plan.rows.length - liveIdx : plan.rows.length;
  const avgReq = slicesLeft > 0 ? remainingQty / slicesLeft : remainingQty;

  const capHitSlices = plan.rows.filter((r) => typeof r.maxAllowed === "number" && r.suggestedQty >= r.maxAllowed).length;
  const capHeat = plan.rows.length ? capHitSlices / plan.rows.length : 0;

  // Normalize to 1..10
  const sizeFactor = order.orderQty > 0 ? remainingQty / order.orderQty : 0;
  const score = Math.min(10, Math.max(1, Math.round(2 + 5 * sizeFactor + 3 * capHeat)));
  return { score, avgReq };
}
function requiredRateToCatchUp(order: Order, plan: BuiltPlan, nowHHmm: string) {
  const plannedToNow = plan.accPlanByTime(nowHHmm);
  const executed = order.orderExecQty;
  const deficit = Math.max(0, plannedToNow - executed);
  const liveIdx = plan.rows.findIndex((r) => nowHHmm + ":00" >= r.s && nowHHmm + ":00" < r.e);
  const slicesLeft = liveIdx >= 0 ? plan.rows.length - liveIdx : plan.rows.length;

  // compare to expected market volume left
  const expVolLeft = plan.rows
    .filter((_, i) => (liveIdx >= 0 ? i >= liveIdx : true))
    .reduce((a, r) => a + r.expMktVol, 0);

  const reqPart = expVolLeft > 0 ? deficit / expVolLeft : 0;
  return { deficit, reqPart }; // 0..1
}

/* -------------------- What-If Simulator -------------------- */
function WhatIfSimulator({
  order,
}: {
  order: Order;
}) {
  const [legs, setLegs] = useState<Array<{ qty: number; price: number }>>([{ qty: 0, price: 0 }]);

  const addLeg = () => setLegs((x) => [...x, { qty: 0, price: 0 }]);
  const removeLeg = (i: number) => setLegs((x) => x.filter((_, k) => k !== i));

  const currentVWAP = order.orderExecQty > 0 ? order.orderExecNotional / order.orderExecQty : 0;
  const totals = useMemo(() => {
    const addQty = legs.reduce((a, l) => a + (l.qty || 0), 0);
    const addNotional = legs.reduce((a, l) => a + (l.qty || 0) * (l.price || 0), 0);
    const newQty = order.orderExecQty + addQty;
    const newNotional = order.orderExecNotional + addNotional;
    const newVWAP = newQty > 0 ? newNotional / newQty : 0;
    const newCompletion = order.orderQty > 0 ? (newQty / order.orderQty) * 100 : 0;
    return { addQty, addNotional, newQty, newNotional, newVWAP, newCompletion };
  }, [legs, order.orderExecQty, order.orderExecNotional, order.orderQty]);

  return (
    <div className="rounded-xl border p-3">
      <div className="font-semibold mb-2">Trade Simulator (what-if)</div>
      <div className="space-y-2">
        {legs.map((l, i) => (
          <div key={i} className="grid grid-cols-2 gap-2 items-end">
            <IntInput label={`Leg ${i + 1} Qty`} value={l.qty} onChange={(n) => {
              const next = [...legs]; next[i] = { ...next[i], qty: n }; setLegs(next);
            }} />
            <MoneyInput label={`Leg ${i + 1} Price`} value={l.price} onNumberChange={(n) => {
              const next = [...legs]; next[i] = { ...next[i], price: n }; setLegs(next);
            }} />
            <div className="col-span-2 flex justify-end">
              {legs.length > 1 && (
                <button onClick={() => removeLeg(i)} className="text-xs px-2 py-1 border rounded-lg">Remove</button>
              )}
            </div>
          </div>
        ))}
        <div className="flex gap-2">
          <button onClick={addLeg} className="text-xs px-2 py-1 border rounded-lg">+ Add leg</button>
        </div>
      </div>
      <div className="grid md:grid-cols-3 gap-3 text-sm mt-3">
        <HeaderStat title="Current VWAP" value={currentVWAP ? formatMoney(currentVWAP, 4) : "—"} />
        <HeaderStat title="Simulated VWAP" value={totals.newVWAP ? formatMoney(totals.newVWAP, 4) : "—"} />
        <HeaderStat title="New Completion %" value={`${totals.newCompletion.toFixed(1)}%`} />
      </div>
    </div>
  );
}

/* -------------------- Planner Card -------------------- */
function PlannerCard({
  order,
  onChange,
  onRemove,
  onDuplicate,
  onFocusMe,
}: {
  order: Order;
  onChange: (o: Order) => void;
  onRemove: () => void;
  onDuplicate: () => void;
  onFocusMe: () => void;
}) {
  const t = sideTheme(order.side);
  const [clock, setClock] = useState(nowHHMMSS());
  useInterval(() => setClock(nowHHMMSS()), 1000);

  // Market preset apply
  function applyMarketPreset(m: MarketKey, startFromNow: boolean) {
    const p = MARKET_PRESET[m];
    const sStart = startFromNow ? nowHHMM() : p.start;
    onChange({
      ...order,
      market: m,
      startFromNow,
      sessionStart: sStart,
      sessionEnd: p.auction,
      auctionStart: p.auction,
      auctionEnd: p.auctionMatch,
      talStart: p.talStart,
      talEnd: p.talEnd,
    });
  }
  // Profile apply (scale expected vols relative to current inputs)
  function applyProfile(pf: ProfileKey) {
    const pr = MARKET_PROFILES[pf];
    onChange({
      ...order,
      profile: pf,
      expectedContVol: Math.max(0, Math.round(order.expectedContVol * pr.contMult)),
      expectedAuctionVol: Math.max(0, Math.round(order.expectedAuctionVol * pr.auctionMult)),
    });
  }

  const plan = useMemo(() => buildPlan(order), [order]);
  const totalPlanned = plan.contPlanned + plan.auctionPlanned;
  const remaining = Math.max(0, order.orderQty - totalPlanned);

  // Accumulated suggested vs executed at NOW
  const nowHM = nowHHMM();
  const shouldHaveExecuted = useMemo(() => plan.accPlanByTime(nowHM), [plan, nowHM]);
  const executed = order.orderExecQty;
  const paceDelta = executed - shouldHaveExecuted; // + ahead, - behind
  const pacePct = shouldHaveExecuted > 0 ? (paceDelta / shouldHaveExecuted) * 100 : 0;

  const progress = order.orderQty > 0 ? Math.min(100, Math.round((executed / order.orderQty) * 100)) : 0;

  // Required rate if behind
  const { deficit, reqPart } = useMemo(() => requiredRateToCatchUp(order, plan, nowHM), [order, plan, nowHM]);
  const { score: impact, avgReq } = useMemo(() => impactScore(order, plan, nowHM), [order, plan, nowHM]);

  // Alerts
  const alertsInline: string[] = [];
  const missingVWAP = !(order.marketTurnover > 0 || order.marketVWAPInput > 0);
  if (missingVWAP) alertsInline.push("Missing market VWAP (turnover or manual)");
  if (order.currentVol === 0 && order.startVol === 0) alertsInline.push("Missing market volume");
  if (order.orderExecQty > order.orderQty) alertsInline.push("Executed > Order (check inputs)");
  const capBindingNow = plan.rows.some(
    (r) =>
      nowHM + ":00" >= r.s &&
      nowHM + ":00" < r.e &&
      typeof r.maxAllowed === "number" &&
      r.suggestedQty >= r.maxAllowed
  );
  if (capBindingNow) alertsInline.push("Cap binding in live slice");

  // Market state banner (session transitions)
  const nowInAuction = nowHM >= order.auctionStart && nowHM < order.auctionEnd;
  const closingSoon =
    minutesBetween(nowHM, order.auctionStart) <= 10 && minutesBetween(nowHM, order.auctionStart) > 0;

  // Critical toast (pacing deviation / high impact)
  const [toast, setToast] = useState<string | null>(null);
  useEffect(() => {
    if (order.completed) return;
    if (pacePct < -20) setToast("⚠️ Pacing: behind plan >20% — increase clips or adjust reserve.");
    else if (impact >= 8) setToast("⚠️ High Impact Score — consider spreading residual or raising cap cautiously.");
    else setToast(null);
  }, [pacePct, impact, order.completed]);

  // CSV export
  const csv = useMemo(() => {
    const base = plan.rows.map((r) => ({
      Interval: r.interval,
      "Expected Market Vol": r.expMktVol,
      "Max Allowed": r.maxAllowed,
      "Suggested Qty": r.suggestedQty,
    }));
    base.push({
      Interval: "Auction",
      "Expected Market Vol": order.expectedAuctionVol,
      "Max Allowed": plan.auctionAllowed,
      "Suggested Qty": plan.auctionPlanned,
    });
    base.push({
      Interval: "Totals",
      "Expected Market Vol": order.startVol + order.currentVol + order.expectedContVol + order.expectedAuctionVol,
      "Max Allowed": "—",
      "Suggested Qty": totalPlanned,
    });
    const headers = Object.keys(base[0] || {});
    const esc = (v: any) => {
      const s = String(v ?? "");
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    return [headers.join(",")]
      .concat(base.map((r) => headers.map((h) => esc((r as any)[h])).join(",")))
      .join("\n");
  }, [plan, order, totalPlanned]);
  function downloadCSV() {
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${order.symbol}_${order.side}_${order.execMode}_plan.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // Snapshot log
  function logSnapshot(note?: string) {
    const snap: Snapshot = {
      at: nowHHMMSS(),
      currentVol: order.currentVol,
      expectedContVol: order.expectedContVol,
      expectedAuctionVol: order.expectedAuctionVol,
      orderExecQty: order.orderExecQty,
      orderExecNotional: order.orderExecNotional,
      marketTurnover: order.marketTurnover,
      marketVWAPInput: order.marketVWAPInput,
      note,
    };
    onChange({ ...order, snapshots: [...order.snapshots, snap] });
  }

  // HUD “Next Best Action”
  let nextAction = "Keep steady.";
  if (pacePct < -5) {
    const reqPct = Math.max(0, Math.min(100, reqPart * 100));
    nextAction = `Behind: raise participation to ~${reqPct.toFixed(1)}% for remaining flow.`;
  } else if (capBindingNow) {
    nextAction = "Cap binding: consider +2–3% cap where liquidity allows.";
  } else if (impact >= 8) {
    nextAction = "High impact risk: spread residual and preserve auction reserve.";
  }

  // Completed → Report Card
  if (order.completed) {
    const marketVWAP =
      order.currentVol > 0
        ? order.marketTurnover > 0
          ? order.marketTurnover / order.currentVol
          : order.marketVWAPInput || 0
        : order.marketVWAPInput || 0;
    const orderVWAP = order.orderExecQty > 0 ? order.orderExecNotional / order.orderExecQty : 0;
    const slippage = performanceBps(order.side, orderVWAP, marketVWAP);

    // simple SVG cumulative planned vs actual from snapshots
    const pointsPlan = (() => {
      let acc = 0;
      return plan.rows.map((r) => {
        acc += r.suggestedQty;
        return { t: r.e, acc };
      });
    })();
    const pointsActual = (() => {
      const snaps = order.snapshots;
      if (snaps.length === 0) return [] as Array<{ t: string; acc: number }>;
      return snaps.map((s) => ({ t: s.at.slice(0, 5), acc: s.orderExecQty }));
    })();

    return (
      <div className={`rounded-2xl shadow border ${t.border} bg-white overflow-hidden`}>
        <div className={`px-4 py-3 border-b ${t.border} flex items-center justify-between`}>
          <div className="flex items-center gap-3">
            <span className={`inline-flex items-center px-2.5 py-1 rounded-full text-xs font-semibold ${t.bgSoft} ${t.text}`}>{order.side}</span>
            <input
              className="text-lg font-semibold bg-transparent border-b focus:outline-none"
              value={order.name}
              onChange={(e) => onChange({ ...order, name: e.target.value })}
            />
            <span className="text-xs px-2 py-1 rounded-full bg-slate-900 text-white">Completed</span>
          </div>
          <div className="flex gap-2">
            <button onClick={() => onChange({ ...order, completed: false })} className="px-3 py-2 rounded-xl border text-sm">Back to Live</button>
            <button onClick={onDuplicate} className="px-3 py-2 rounded-xl border text-sm">Duplicate</button>
            <button onClick={onRemove} className="px-3 py-2 rounded-xl border text-sm">Remove</button>
          </div>
        </div>

        <div className="p-4 grid md:grid-cols-4 gap-3">
          <HeaderStat title="Final Completion" value={`${progress}%`} />
          <HeaderStat title="Order VWAP" value={orderVWAP ? formatMoney(orderVWAP, 4) : "—"} />
          <HeaderStat title="Market VWAP" value={marketVWAP ? formatMoney(marketVWAP, 4) : "—"} />
          <HeaderStat title="Slippage (bps)" value={Number.isFinite(slippage) ? slippage.toFixed(1) : "—"} />
        </div>

        <div className="px-4 pb-4">
          <div className="text-sm font-semibold mb-2">Planned vs Actual (cumulative)</div>
          <div className="rounded-xl border p-3">
            <svg viewBox="0 0 600 180" className="w-full h-40">
              <rect x="0" y="0" width="600" height="180" fill="white" />
              {/* Axes */}
              <line x1="40" y1="150" x2="580" y2="150" stroke="#cbd5e1" />
              <line x1="40" y1="20" x2="40" y2="150" stroke="#cbd5e1" />
              {/* Planned path */}
              {pointsPlan.length > 1 && (
                <polyline
                  points={pointsPlan.map((p, i) => {
                    const x = 40 + ((i + 1) / pointsPlan.length) * 540;
                    const y = 150 - (p.acc / Math.max(1, order.orderQty)) * 120;
                    return `${x},${y}`;
                  }).join(" ")}
                  fill="none"
                  stroke="#0ea5e9"
                  strokeWidth="2"
                />
              )}
              {/* Actual path */}
              {pointsActual.length > 1 && (
                <polyline
                  points={pointsActual.map((p, i) => {
                    const x = 40 + ((i + 1) / (pointsPlan.length || pointsActual.length)) * 540;
                    const y = 150 - (p.acc / Math.max(1, order.orderQty)) * 120;
                    return `${x},${y}`;
                  }).join(" ")}
                  fill="none"
                  stroke="#111827"
                  strokeWidth="2"
                />
              )}
              <text x="50" y="30" fontSize="10" fill="#0ea5e9">Planned</text>
              <text x="110" y="30" fontSize="10" fill="#111827">Actual</text>
            </svg>
          </div>
        </div>

        {/* snapshot table */}
        <div className="px-4 pb-4">
          <div className="text-sm font-semibold mb-2">Decision Journal</div>
          <div className="rounded-xl border overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="bg-slate-50">
                <tr className="text-left">
                  <th className="p-2">Time</th><th className="p-2">Exec Qty</th><th className="p-2">Exec Notional</th>
                  <th className="p-2">Cur Vol</th><th className="p-2">Exp Cont</th><th className="p-2">Exp Auction</th>
                  <th className="p-2">Turnover</th><th className="p-2">Manual VWAP</th><th className="p-2">Note</th>
                </tr>
              </thead>
              <tbody>
                {[...order.snapshots].reverse().map((s, i) => (
                  <tr key={i} className="border-t">
                    <td className="p-2 font-mono">{s.at}</td>
                    <td className="p-2">{formatInt(s.orderExecQty)}</td>
                    <td className="p-2">{formatMoney(s.orderExecNotional, 2)}</td>
                    <td className="p-2">{formatInt(s.currentVol)}</td>
                    <td className="p-2">{formatInt(s.expectedContVol)}</td>
                    <td className="p-2">{formatInt(s.expectedAuctionVol)}</td>
                    <td className="p-2">{formatMoney(s.marketTurnover, 2)}</td>
                    <td className="p-2">{s.marketVWAPInput ? formatMoney(s.marketVWAPInput, 4) : "—"}</td>
                    <td className="p-2">{s.note || "—"}</td>
                  </tr>
                ))}
                {order.snapshots.length === 0 && (
                  <tr><td className="p-2 text-slate-500" colSpan={9}>No snapshots logged.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={`rounded-2xl shadow border ${t.border} bg-white overflow-hidden`}>
      {/* Header */}
      <div className={`px-4 py-3 border-b ${t.border} flex items-center justify-between`}>
        <div className="flex items-center gap-3">
          <span className={`inline-flex items-center px-2.5 py-1 rounded-full text-xs font-semibold ${t.bgSoft} ${t.text}`}>{order.side}</span>
          <input
            className="text-lg font-semibold bg-transparent border-b focus:outline-none"
            value={order.name}
            onChange={(e) => onChange({ ...order, name: e.target.value })}
          />
          <span className="text-xs opacity-70">Local: <span className="font-mono">{clock}</span></span>
        </div>
        <div className="flex gap-2">
          <button onClick={downloadCSV} className="px-3 py-2 rounded-xl bg-slate-900 text-white text-sm">Export CSV</button>
          <button onClick={onDuplicate} className="px-3 py-2 rounded-xl border text-sm">Duplicate</button>
          <button onClick={onRemove} className="px-3 py-2 rounded-xl border text-sm">Remove</button>
        </div>
      </div>

      {/* Critical toast */}
      {toast && (
        <div className={`mx-3 mt-3 mb-0 p-3 rounded-xl border text-sm ${t.bgSoft} ${t.text} ${t.border}`}>
          {toast}
        </div>
      )}

      {/* Market-state banner */}
      {(closingSoon || nowInAuction) && (
        <div className="mx-3 mt-3 p-3 rounded-xl bg-amber-50 border border-amber-200 text-amber-800 text-sm cursor-pointer"
             onClick={onFocusMe}>
          {nowInAuction ? "AUCTION PERIOD LIVE — prioritize reserve & price discipline."
                         : "Continuous ends in ≤10 minutes — align residual with auction plan."}
        </div>
      )}

      {/* HUD / Status & Guidance Bar */}
      <div className="px-4 py-3 grid md:grid-cols-5 gap-3 items-end">
        <HeaderStat title="Should-Have Executed" value={formatInt(shouldHaveExecuted)} />
        <HeaderStat title="Executed" value={formatInt(executed)} />
        <HeaderStat title="Pacing" value={
          <span className={pacePct > 5 ? "text-green-600" : pacePct < -5 ? "text-red-600" : ""}>
            {pacePct >= 0 ? "+" : ""}{isFinite(pacePct) ? pacePct.toFixed(1) : "—"}%
          </span>} />
        <div className="flex flex-col gap-1">
          <div className="text-xs opacity-60">Completion</div>
          <div className="w-full h-2 rounded-full bg-slate-200 overflow-hidden">
            <div className={`h-2 ${t.strong}`} style={{ width: `${progress}%` }} />
          </div>
          <div className="text-xs opacity-60">{progress}% of {formatInt(order.orderQty)}</div>
        </div>
        <div className="text-sm">
          <div className="opacity-60 text-xs">Next Best Action</div>
          <div className="font-semibold">{nextAction}</div>
          <div className="text-xs mt-1">Impact Score: <span className={impact >= 8 ? "text-red-600" : impact >= 5 ? "text-amber-600" : "text-green-700"}>{impact}/10</span></div>
        </div>
      </div>

      {/* Market/Profile Row (per order) */}
      <div className="px-4 py-2 flex flex-wrap items-center gap-2 text-sm">
        <span className="opacity-70">Market:</span>
        {(["Egypt", "Kuwait", "Qatar", "DFM", "ADX", "Saudi"] as MarketKey[]).map((m) => (
          <button
            key={m}
            onClick={() => applyMarketPreset(m, !!order.startFromNow)}
            className={`px-3 py-1.5 rounded-full border ${order.market === m ? "bg-slate-900 text-white" : "bg-white"}`}
          >
            {m}
          </button>
        ))}
        <label className="flex items-center gap-2 ml-2">
          <input
            type="checkbox"
            checked={!!order.startFromNow}
            onChange={(e) => applyMarketPreset(order.market || "Qatar", e.target.checked)}
          />
          Start from now
        </label>

        <span className="opacity-70 ml-4">Profile:</span>
        {(["Quiet","Normal","Volatile"] as ProfileKey[]).map((p) => (
          <button
            key={p}
            onClick={() => applyProfile(p)}
            className={`px-3 py-1.5 rounded-full border ${order.profile === p ? "bg-slate-900 text-white" : "bg-white"}`}
          >
            {p}
          </button>
        ))}

        <div className="ml-auto flex gap-2">
          <button onClick={() => onChange({ ...order, showAdvanced: !order.showAdvanced })} className="px-3 py-1.5 rounded-full border">
            {order.showAdvanced ? "Simple View" : "Advanced"}
          </button>
          <button onClick={() => onChange({ ...order, completed: true })} className="px-3 py-1.5 rounded-full border">
            Mark Completed
          </button>
        </div>
      </div>

      {/* SIMPLE or ADVANCED INPUTS */}
      {!order.showAdvanced ? (
        // SIMPLE — minimal fields
        <div className="px-4 pb-4 grid md:grid-cols-3 gap-4">
          <div className="space-y-3">
            <h3 className="font-semibold">Order</h3>
            <label className="text-sm">
              Symbol
              <input
                className="mt-1 w-full border rounded-xl p-2"
                value={order.symbol}
                onChange={(e) => onChange({ ...order, symbol: e.target.value.toUpperCase() })}
              />
            </label>
            <label className="text-sm">
              Side
              <select
                className="mt-1 w-full border rounded-xl p-2"
                value={order.side}
                onChange={(e) => onChange({ ...order, side: e.target.value as Side })}
              >
                <option value="BUY">BUY</option>
                <option value="SELL">SELL</option>
              </select>
            </label>
            <IntInput label="Order Qty" value={order.orderQty} onChange={(n) => onChange({ ...order, orderQty: n })} />
            <label className="text-sm">
              Mode
              <select
                className="mt-1 w-full border rounded-xl p-2"
                value={order.execMode}
                onChange={(e) => onChange({ ...order, execMode: e.target.value as ExecMode })}
              >
                <option value="OTD">OTD (time-sliced)</option>
                <option value="INLINE">Inline (POV)</option>
              </select>
            </label>
            <label className="text-sm">
              Interval Minutes
              <input
                type="number"
                className="mt-1 w-full border rounded-xl p-2"
                value={order.intervalMins}
                onChange={(e) => onChange({ ...order, intervalMins: Math.max(1, parseInt(e.target.value || "1")) })}
              />
            </label>
          </div>

          <div className="space-y-3">
            <h3 className="font-semibold">Timing</h3>
            <div className="grid grid-cols-2 gap-3">
              <label className="text-sm">
                Session Start
                <input type="time" className="mt-1 w-full border rounded-xl p-2"
                  value={order.sessionStart} onChange={(e) => onChange({ ...order, sessionStart: e.target.value })} />
              </label>
              <label className="text-sm">
                Session End
                <input type="time" className="mt-1 w-full border rounded-xl p-2"
                  value={order.sessionEnd} onChange={(e) => onChange({ ...order, sessionEnd: e.target.value })} />
              </label>
              <label className="text-sm">
                Auction Start
                <input type="time" className="mt-1 w-full border rounded-xl p-2"
                  value={order.auctionStart} onChange={(e) => onChange({ ...order, auctionStart: e.target.value })} />
              </label>
              <label className="text-sm">
                Auction End
                <input type="time" className="mt-1 w-full border rounded-xl p-2"
                  value={order.auctionEnd} onChange={(e) => onChange({ ...order, auctionEnd: e.target.value })} />
              </label>
              <label className="text-sm">
                TAL Start
                <input type="time" className="mt-1 w-full border rounded-xl p-2"
                  value={order.talStart} onChange={(e) => onChange({ ...order, talStart: e.target.value })} />
              </label>
              <label className="text-sm">
                TAL End
                <input type="time" className="mt-1 w-full border rounded-xl p-2"
                  value={order.talEnd} onChange={(e) => onChange({ ...order, talEnd: e.target.value })} />
              </label>
            </div>
          </div>

          <div className="space-y-3">
            <h3 className="font-semibold">Live Inputs</h3>
            <div className="grid grid-cols-2 gap-3">
              <IntInput label="Current Volume (cum)" value={order.currentVol} onChange={(n) => onChange({ ...order, currentVol: n })} />
              <IntInput label="Expected Continuous" value={order.expectedContVol} onChange={(n) => onChange({ ...order, expectedContVol: n })} />
              <IntInput label="Expected Auction" value={order.expectedAuctionVol} onChange={(n) => onChange({ ...order, expectedAuctionVol: n })} />
            </div>
            <MoneyInput label="Turnover" value={order.marketTurnover} onNumberChange={(n) => onChange({ ...order, marketTurnover: n })} />
            <MoneyInput label="OR Manual Market VWAP" value={order.marketVWAPInput} onNumberChange={(n) => onChange({ ...order, marketVWAPInput: n })} />
            <IntInput label="Executed Qty" value={order.orderExecQty} onChange={(n) => onChange({ ...order, orderExecQty: n })} />
            <MoneyInput label="Executed Notional" value={order.orderExecNotional} onNumberChange={(n) => onChange({ ...order, orderExecNotional: n })} />
            <VWAPBox order={order} />
          </div>
        </div>
      ) : (
        // ADVANCED — cards with more coaching & options
        <div className="px-4 pb-4 grid lg:grid-cols-3 gap-4">
          <div className="space-y-3">
            <div className="rounded-xl border p-3">
              <div className="font-semibold mb-2">Execution Policy</div>
              <label className="text-sm">
                Cap Mode
                <select className="mt-1 w-full border rounded-xl p-2"
                  value={order.capMode}
                  onChange={(e) => onChange({ ...order, capMode: e.target.value as CapMode })}>
                  <option value="PCT">Max % of Volume</option>
                  <option value="NONE">No Volume Cap</option>
                </select>
              </label>
              {order.capMode === "PCT" && (
                <label className="text-sm">
                  Max Participation %
                  <input type="number" className="mt-1 w-full border rounded-xl p-2"
                    value={order.maxPart}
                    onChange={(e) => onChange({ ...order, maxPart: Math.max(0, parseFloat(e.target.value || "0")) })} />
                </label>
              )}
              <label className="text-sm">
                Reserve for Auction %
                <input type="number" className="mt-1 w-full border rounded-xl p-2"
                  value={order.reserveAuctionPct}
                  onChange={(e) => onChange({ ...order, reserveAuctionPct: Math.max(0, parseFloat(e.target.value || "0")) })} />
              </label>
              <label className="text-sm flex items-center gap-2 mt-2">
                <input type="checkbox" checked={order.deferCompletion}
                  onChange={(e) => onChange({ ...order, deferCompletion: e.target.checked })} />
                Do not complete before end
              </label>
              <label className="text-sm mt-2">
                Curve
                <select className="mt-1 w-full border rounded-xl p-2"
                  value={order.curve}
                  onChange={(e) => onChange({ ...order, curve: e.target.value as Curve })}>
                  <option value="ucurve">U-curve</option>
                  <option value="equal">Equal</option>
                </select>
              </label>
            </div>

            <div className="rounded-xl border p-3">
              <div className="font-semibold mb-2">Coaching & Advice</div>
              <ul className="list-disc pl-5 text-sm space-y-1">
                {pacePct < -5 && <li>Behind schedule by {Math.abs(pacePct).toFixed(1)}% — required participation ~{Math.max(0, Math.min(100, reqPart * 100)).toFixed(1)}%.</li>}
                {capBindingNow && <li>Cap binding now — consider +2–3% cap if safe.</li>}
                {impact >= 8 && <li>High Impact Score ({impact}/10) — spread residual; preserve auction reserve.</li>}
                {remaining > 0 && <li>Remaining planned: {formatInt(remaining)} (auction reserve: {formatInt(plan.auctionPlanned)} allowed {formatInt(plan.auctionAllowed)}).</li>}
                <li>Avg required per slice (residual): {formatInt(Math.max(0, Math.round(avgReq)))}.</li>
              </ul>
              <div className="mt-2 flex gap-2">
                <button onClick={() => logSnapshot()} className={`px-2.5 py-1.5 rounded-lg text-xs text-white ${t.strong}`}>Log snapshot</button>
                <button onClick={() => logSnapshot("Noted market regime / changed plan")} className="px-2.5 py-1.5 rounded-lg text-xs border">Log w/ note</button>
              </div>
            </div>

            <WhatIfSimulator order={order} />
          </div>

          <div className="space-y-3 lg:col-span-2">
            <div className="rounded-xl border overflow-x-auto">
              <div className="px-3 py-2 text-sm font-medium">Plan (with Impact flags)</div>
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-white">
                  <tr className="text-left border-b">
                    <th className="py-2 pr-2">Interval</th>
                    <th className="py-2 pr-2">Expected Mkt Vol</th>
                    <th className="py-2 pr-2">Max Allowed</th>
                    <th className="py-2 pr-2">Suggested Qty</th>
                    <th className="py-2 pr-2">Impact</th>
                  </tr>
                </thead>
                <tbody>
                  {plan.rows.map((r) => {
                    const isLive = nowHM + ":00" >= r.s && nowHM + ":00" < r.e;
                    return (
                      <tr key={r.interval} className={`border-b last:border-0 ${isLive ? `${t.bgSoft} animate-pulse` : ""}`}>
                        <td className={`py-2 pr-2 ${t.text}`}>{r.interval}</td>
                        <td className="py-2 pr-2">{formatInt(r.expMktVol)}</td>
                        <td className="py-2 pr-2">{typeof r.maxAllowed === "number" ? formatInt(r.maxAllowed) : r.maxAllowed}</td>
                        <td className="py-2 pr-2 font-semibold">{formatInt(r.suggestedQty)}</td>
                        <td className="py-2 pr-2">{r.highImpact ? "⚠️ >25% of vol" : "—"}</td>
                      </tr>
                    );
                  })}
                  <tr className="bg-slate-50">
                    <td className="py-2 pr-2 font-semibold">
                      Auction {order.auctionStart}–{order.auctionEnd}
                    </td>
                    <td className="py-2 pr-2">{formatInt(order.expectedAuctionVol)}</td>
                    <td className="py-2 pr-2">{formatInt(plan.auctionAllowed)}</td>
                    <td className="py-2 pr-2 font-semibold">{formatInt(plan.auctionPlanned)}</td>
                    <td className="py-2 pr-2">Reserve intact</td>
                  </tr>
                </tbody>
                <tfoot>
                  <tr className="border-t">
                    <td className="py-2 pr-2 font-semibold">Totals</td>
                    <td className="py-2 pr-2">{formatInt(order.startVol + order.currentVol + order.expectedContVol + order.expectedAuctionVol)}</td>
                    <td className="py-2 pr-2">—</td>
                    <td className="py-2 pr-2 font-semibold">{formatInt(totalPlanned)} (Remain {formatInt(remaining)})</td>
                    <td className="py-2 pr-2">—</td>
                  </tr>
                </tfoot>
              </table>
            </div>

            {/* Snapshots compact */}
            <div className="rounded-xl border">
              <div className="px-3 py-2 text-sm font-medium">Snapshots (latest first)</div>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead className="bg-slate-50">
                    <tr className="text-left">
                      <th className="p-2">Time</th>
                      <th className="p-2">Exec Qty</th>
                      <th className="p-2">Exec Notional</th>
                      <th className="p-2">Cur Vol</th>
                      <th className="p-2">Exp Cont</th>
                      <th className="p-2">Exp Auction</th>
                      <th className="p-2">Turnover</th>
                      <th className="p-2">Manual VWAP</th>
                      <th className="p-2">Note</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...order.snapshots].reverse().map((s, i) => (
                      <tr key={i} className="border-t">
                        <td className="p-2 font-mono">{s.at}</td>
                        <td className="p-2">{formatInt(s.orderExecQty)}</td>
                        <td className="p-2">{formatMoney(s.orderExecNotional, 2)}</td>
                        <td className="p-2">{formatInt(s.currentVol)}</td>
                        <td className="p-2">{formatInt(s.expectedContVol)}</td>
                        <td className="p-2">{formatInt(s.expectedAuctionVol)}</td>
                        <td className="p-2">{formatMoney(s.marketTurnover, 2)}</td>
                        <td className="p-2">{s.marketVWAPInput ? formatMoney(s.marketVWAPInput, 4) : "—"}</td>
                        <td className="p-2">{s.note || "—"}</td>
                      </tr>
                    ))}
                    {order.snapshots.length === 0 && (
                      <tr><td className="p-2 text-slate-500" colSpan={9}>No snapshots yet.</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>

          </div>
        </div>
      )}

      {/* Inline alerts */}
      {alertsInline.length > 0 && (
        <div className="px-4 pb-4">
          <div className="flex flex-wrap gap-2">
            {alertsInline.map((a, i) => (
              <span key={i} className={`text-xs px-2.5 py-1 rounded-full border ${t.border} ${t.bgSoft} ${t.text}`}>
                {a}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/* -------------------- Aggregates & App Shell -------------------- */
type Aggregates = {
  qtyTotal: number;
  plannedTotal: number;
  execQty: number;
  execNotional: number;
  marketTurnoverApprox: number;
  marketVolTotal: number;
};
function aggregateOrders(orders: Order[]): Aggregates {
  return orders.reduce<Aggregates>(
    (agg, o) => {
      const { contPlanned, auctionPlanned } = buildPlan(o);
      const planned = contPlanned + auctionPlanned;
      const marketVWAP =
        o.currentVol > 0
          ? o.marketTurnover > 0
            ? o.marketTurnover / o.currentVol
            : o.marketVWAPInput || 0
          : o.marketVWAPInput || 0;
      const turnoverApprox = o.marketTurnover > 0 ? o.marketTurnover : marketVWAP * o.currentVol;
      return {
        qtyTotal: agg.qtyTotal + o.orderQty,
        plannedTotal: agg.plannedTotal + planned,
        execQty: agg.execQty + o.orderExecQty,
        execNotional: agg.execNotional + o.orderExecNotional,
        marketTurnoverApprox: agg.marketTurnoverApprox + turnoverApprox,
        marketVolTotal: agg.marketVolTotal + o.currentVol,
      };
    },
    { qtyTotal: 0, plannedTotal: 0, execQty: 0, execNotional: 0, marketTurnoverApprox: 0, marketVolTotal: 0 }
  );
}
function SummaryCard({
  title,
  tint,
  ag,
  side,
}: {
  title: string;
  tint: "emerald" | "rose" | "slate";
  ag: Aggregates;
  side?: Side;
}) {
  const progress = ag.qtyTotal > 0 ? Math.min(100, Math.round((ag.execQty / ag.qtyTotal) * 100)) : 0;
  const orderVWAP = ag.execQty > 0 ? ag.execNotional / ag.execQty : 0;
  const marketVWAP = ag.marketVolTotal > 0 ? ag.marketTurnoverApprox / ag.marketVolTotal : 0;
  const perf = side ? performanceBps(side, orderVWAP, marketVWAP) : orderVWAP && marketVWAP ? ((orderVWAP - marketVWAP) / marketVWAP) * 10000 : 0;

  const color =
    perf > 0 ? "text-green-600" : perf < 0 ? "text-red-600" : "";
  const bg = tint === "emerald" ? "bg-emerald-50" : tint === "rose" ? "bg-rose-50" : "bg-slate-100";
  const bar = tint === "emerald" ? "bg-emerald-600" : tint === "rose" ? "bg-rose-600" : "bg-slate-600";

  return (
    <div className={`rounded-2xl p-4 ${bg} border`}>
      <div className="flex items-center justify-between">
        <div className="font-semibold">{title}</div>
        <div className="text-xs opacity-60">Executed {progress}%</div>
      </div>
      <div className="grid md:grid-cols-4 gap-3 text-sm mt-2">
        <HeaderStat title="Total Qty" value={formatInt(ag.qtyTotal)} />
        <HeaderStat title="Planned (total)" value={formatInt(ag.plannedTotal)} />
        <HeaderStat title="Executed" value={formatInt(ag.execQty)} />
        <HeaderStat title="Remaining" value={formatInt(Math.max(0, ag.qtyTotal - ag.execQty))} />
      </div>
      <div className="w-full h-2 rounded-full bg-white/60 overflow-hidden mt-2">
        <div className={`h-2 ${bar}`} style={{ width: `${progress}%` }} />
      </div>
      <div className="text-xs mt-2">
        Perf: <span className={color}>{Number.isFinite(perf) ? perf.toFixed(1) : "—"} bps</span>
      </div>
    </div>
  );
}

export default function App() {
  const [orders, setOrders] = useState<Order[]>([
    defaultOrder("BUY", 1),
    defaultOrder("SELL", 1),
  ]);
  const [selectedId, setSelectedId] = useState<string | null>(orders[0]?.id ?? null);

  const updateOrder = (id: string, next: Order) => setOrders((o) => o.map((x) => (x.id === id ? next : x)));
  const addOrder = (side: Side) => setOrders((o) => [...o, defaultOrder(side, o.length + 1)]);
  const removeOrder = (id: string) => {
    setOrders((o) => o.filter((x) => x.id !== id));
    if (selectedId === id) setSelectedId(null);
  };
  const duplicateOrder = (id: string) =>
    setOrders((o) => {
      const src = o.find((x) => x.id === id);
      if (!src) return o;
      return [...o, { ...src, id: Math.random().toString(36).slice(2, 9), name: src.name + " (copy)", completed: false }];
    });

  const visible = selectedId ? orders.filter((o) => o.id === selectedId) : orders;
  const agAll = aggregateOrders(visible);
  const agBuy = aggregateOrders(visible.filter((o) => o.side === "BUY"));
  const agSell = aggregateOrders(visible.filter((o) => o.side === "SELL"));

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      {/* App header */}
      <div className="sticky top-0 z-30 backdrop-blur bg-slate-50/80 border-b">
        <div className="max-w-7xl mx-auto p-4 grid gap-4">
          <div className="flex items-center justify-between">
            <h1 className="text-xl font-bold">Execution Planner — Co-Pilot</h1>
            <div className="flex gap-2">
              <button onClick={() => addOrder("BUY")} className="px-3 py-2 rounded-xl bg-emerald-600 text-white text-sm">+ Add BUY</button>
              <button onClick={() => addOrder("SELL")} className="px-3 py-2 rounded-xl bg-rose-600 text-white text-sm">+ Add SELL</button>
            </div>
          </div>

          <div className="grid md:grid-cols-3 gap-3">
            <SummaryCard title="ALL Orders" tint="slate" ag={agAll} />
            <SummaryCard title="BUY" tint="emerald" ag={agBuy} side="BUY" />
            <SummaryCard title="SELL" tint="rose" ag={agSell} side="SELL" />
          </div>
        </div>
      </div>

      {/* Body with Orders Rail + content */}
      <div className="max-w-7xl mx-auto p-4 grid md:grid-cols-[260px,1fr] gap-4">
        {/* Orders Rail */}
        <div className="rounded-2xl border bg-white overflow-hidden">
          <div className="px-3 py-2 text-sm font-medium border-b">Orders</div>
          <div className="divide-y">
            {orders.map((o) => {
              const selected = selectedId === o.id || (!selectedId && orders[0]?.id === o.id);
              const theme = sideTheme(o.side);
              return (
                <div
                  key={o.id}
                  className={`p-3 cursor-pointer ${selected ? "bg-slate-100" : ""}`}
                  onClick={() => setSelectedId(o.id)}
                  title="Click to focus this order"
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className={`text-[10px] px-2 py-0.5 rounded-full border ${theme.border} ${theme.bgSoft} ${theme.text}`}>{o.side}</span>
                      <span className="font-medium">{o.name}</span>
                    </div>
                    {o.completed && <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-900 text-white">Done</span>}
                  </div>
                  <div className="text-xs opacity-70 mt-1">
                    {o.market} · {o.execMode} · {o.capMode === "PCT" ? `${o.maxPart}% cap` : "No cap"}
                  </div>
                </div>
              );
            })}
            {orders.length === 0 && <div className="p-3 text-sm text-slate-500">No orders.</div>}
          </div>
        </div>

        {/* Content */}
        <div className="grid gap-5">
          {visible.map((o) => (
            <PlannerCard
              key={o.id}
              order={o}
              onChange={(n) => updateOrder(o.id, n)}
              onRemove={() => removeOrder(o.id)}
              onDuplicate={() => duplicateOrder(o.id)}
              onFocusMe={() => setSelectedId(o.id)}
            />
          ))}
          {visible.length === 0 && (
            <div className="text-sm text-slate-500">No orders selected.</div>
          )}
        </div>
      </div>

      {/* Quick sanity tests */}
      <div className="max-w-7xl mx-auto p-4">
        <div className="bg-white rounded-2xl shadow p-4 text-sm">
          <div className="font-semibold">Built-in Self Tests</div>
          <pre className="text-xs bg-slate-50 p-3 rounded-xl overflow-x-auto">{`console.assert(minutesBetween('09:30','10:00') === 30, 'minutesBetween');
console.assert(addMinutes('09:30', 30) === '10:00', 'addMinutes');
const ts = timeSlices('09:30','10:30',30); console.assert(ts.length===2 && ts[0].s==='09:30' && ts[1].e==='10:30', 'timeSlices');
const w1 = equalWeights(4); console.assert(Math.abs(w1.reduce((a,b)=>a+b,0)-1) < 1e-9, 'equal sum');
const w2 = uCurveWeights(5); console.assert(Math.abs(w2.reduce((a,b)=>a+b,0)-1) < 1e-9, 'u sum');`}</pre>
        </div>
      </div>
    </div>
  );
}