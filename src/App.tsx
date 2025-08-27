import React, { useEffect, useRef, useState } from "react";

/**
======================================================================
* Execution Planner — v2.1 (Corrected)
* - FIX: Corrected JSX structure in PlannerCard to resolve build error.
* - Post-Trade Report Card with Planned vs. Actual Execution Chart
* - Live Pacing Indicator (Ahead/Behind Schedule)
* - "Required Rate to Catch Up" advisory metric
* - Market Impact warnings on high-participation intervals
====================================================================== */

type ExecMode = "OTD" | "INLINE";
type CapMode = "NONE" | "PCT";
type Curve = "equal" | "ucurve";
type Side = "BUY" | "SELL";
type MarketKey = "Egypt" | "Kuwait" | "Qatar" | "DFM" | "ADX" | "Saudi";

// --- CONSTANTS ---
const IMPACT_WARNING_THRESHOLD = 0.25; // 25% participation

const MARKET_PRESET: Record<
  MarketKey,
  { start: string; auction: string; auctionMatch: string; talStart: string; talEnd: string }
> = {
  Egypt: { start: "10:00", auction: "14:15", auctionMatch: "14:25", talStart: "14:25", talEnd: "14:30" },
  Kuwait: { start: "09:00", auction: "12:30", auctionMatch: "12:40", talStart: "12:40", talEnd: "12:45" },
  Qatar: { start: "09:30", auction: "13:00", auctionMatch: "13:10", talStart: "13:10", talEnd: "13:15" },
  DFM: { start: "09:00", auction: "13:45", auctionMatch: "13:55", talStart: "13:55", talEnd: "14:00" },
  ADX: { start: "09:00", auction: "13:45", auctionMatch: "13:55", talStart: "13:55", talEnd: "14:00" },
  Saudi: { start: "10:00", auction: "15:00", auctionMatch: "15:10", talStart: "15:10", talEnd: "15:20" },
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
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(
    d.getSeconds()
  ).padStart(2, "0")}`;
}
function useInterval(cb: () => void, delay: number | null) {
  const ref = useRef(cb);
  useEffect(() => {
    ref.current = cb;
  }, [cb]);
  useEffect(() => {
    if (delay == null) return;
    const id = setInterval(() => ref.current(), delay);
    return () => clearInterval(id);
  }, [delay]);
}

/* -------------------- Types & defaults -------------------- */
type Snapshot = {
  at: string; // HH:MM:SS
  currentVol: number;
  expectedContVol: number;
  expectedAuctionVol: number;
  orderExecQty: number;
  orderExecNotional: number;
  marketTurnover: number;
  marketVWAPInput: number;
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
  startVol: number;
  currentVol: number;
  expectedContVol: number;
  expectedAuctionVol: number;
  marketTurnover: number;
  marketVWAPInput: number;
  orderExecQty: number;
  orderExecNotional: number;
  market?: MarketKey;
  startFromNow?: boolean;
  completed?: boolean;
  snapshots: Snapshot[];
};

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
    startFromNow: false,
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

type PlanRow = {
  interval: string;
  s: string;
  e: string;
  expMktVol: number;
  maxAllowed: number | "∞";
  suggestedQty: number;
  cumSuggested: number;
  impactRisk: boolean;
};
type BuiltPlan = {
  rows: PlanRow[];
  contPlanned: number;
  auctionAllowed: number;
  auctionPlanned: number;
  accumSuggested: number; // cont + auction
};

function buildPlan(order: Order): BuiltPlan {
  const slices = timeSlices(order.sessionStart, order.sessionEnd, order.intervalMins);
  const weights = order.curve === "equal" ? equalWeights(slices.length) : uCurveWeights(slices.length);
  const contVolPerSlice = weights.map((w) => Math.floor(w * order.expectedContVol));
  const reserveAuctionQty = Math.floor((order.orderQty * order.reserveAuctionPct) / 100);
  const auctionAllowed =
    order.capMode === "PCT" ? Math.floor((order.expectedAuctionVol * order.maxPart) / 100) : order.expectedAuctionVol;

  const buildRows = (targetContinuousQty: number) => {
    let remaining = targetContinuousQty;
    let cum = 0;
    return slices.map((slice, i) => {
      const sliceVol = Math.max(0, contVolPerSlice[i] ?? 0);
      let base = Math.floor((weights[i] ?? 0) * targetContinuousQty);
      base = Math.min(base, remaining);
      let suggested = applyCap(order.capMode, order.maxPart, base, sliceVol);
      const isLast = i === slices.length - 1;
      if (order.deferCompletion && !isLast) {
        const keepBack = Math.ceil(targetContinuousQty * 0.05);
        if (remaining - suggested <= 0) suggested = Math.max(0, remaining - keepBack);
      }
      suggested = Math.min(suggested, remaining);
      remaining -= suggested;
      cum += suggested;
      return {
        interval: slice.label,
        s: slice.s,
        e: slice.e,
        expMktVol: sliceVol,
        maxAllowed: order.capMode === "PCT" ? Math.floor((sliceVol * order.maxPart) / 100) : "∞",
        suggestedQty: suggested,
        cumSuggested: cum,
        impactRisk: sliceVol > 0 && suggested / sliceVol > IMPACT_WARNING_THRESHOLD,
      };
    });
  };

  if (order.execMode === "OTD") {
    const targetQty = Math.max(0, order.orderQty - reserveAuctionQty);
    const rows = buildRows(targetQty);
    const contPlanned = rows.reduce((a, r) => a + r.suggestedQty, 0);
    const auctionPlanned = Math.min(reserveAuctionQty + Math.max(0, targetQty - contPlanned), auctionAllowed);
    return { rows, contPlanned, auctionAllowed, auctionPlanned, accumSuggested: contPlanned + auctionPlanned };
  }

  // INLINE mode logic...
  const expectedTotalVol = order.currentVol + order.expectedContVol + order.expectedAuctionVol;
  const pov = expectedTotalVol > 0 ? Math.min(1, order.orderQty / expectedTotalVol) : 0;
  let cum = 0;
  const rows = slices.map((slice, i) => {
    const sliceVol = Math.max(0, contVolPerSlice[i] ?? 0);
    const base = Math.floor(sliceVol * pov);
    const suggested = applyCap(order.capMode, order.maxPart, base, sliceVol);
    cum += suggested;
    return {
      interval: slice.label, s: slice.s, e: slice.e, expMktVol: sliceVol,
      maxAllowed: order.capMode === "PCT" ? Math.floor((sliceVol * order.maxPart) / 100) : "∞",
      suggestedQty: suggested, cumSuggested: cum,
      impactRisk: sliceVol > 0 && suggested / sliceVol > IMPACT_WARNING_THRESHOLD,
    };
  });
  const contPlanned = rows.reduce((a, r) => a + r.suggestedQty, 0);
  let auctionPlanned = Math.floor(order.expectedAuctionVol * pov);
  return { rows, contPlanned, auctionAllowed, auctionPlanned, accumSuggested: contPlanned + auctionPlanned };
}

function performanceBps(side: Side, orderVWAP: number, marketVWAP: number) {
  if (!marketVWAP || !orderVWAP) return 0;
  return side === "BUY"
    ? ((marketVWAP - orderVWAP) / marketVWAP) * 10000
    : ((orderVWAP - marketVWAP) / marketVWAP) * 10000;
}

/* -------------------- Metrics & Alerts -------------------- */
function computeMetrics(order: Order, plan: BuiltPlan) {
  const marketVWAP =
    order.currentVol > 0
      ? order.marketTurnover > 0 ? order.marketTurnover / order.currentVol : order.marketVWAPInput || 0
      : order.marketVWAPInput || 0;
  const orderVWAP = order.orderExecQty > 0 ? order.orderExecNotional / order.orderExecQty : 0;
  const slipBps = performanceBps(order.side, orderVWAP, marketVWAP);
  const curTime = nowHHMM();

  // --- Pacing Calculation ---
  let pacing = 0;
  let requiredRate = 0;
  const liveRow = plan.rows.find((r) => curTime >= r.s && curTime < r.e);
  if (liveRow) {
    const plannedToDate = liveRow.cumSuggested;
    if (plannedToDate > 0) {
      pacing = (order.orderExecQty / plannedToDate - 1) * 100;
    }
    const remainingToPlan = Math.max(0, plan.accumSuggested - plannedToDate);
    const remainingVol = plan.rows
      .filter(r => r.s >= curTime)
      .reduce((sum, r) => sum + r.expMktVol, 0);
    if (remainingVol > 0) {
      requiredRate = (remainingToPlan / remainingVol) * 100;
    }
  }

  return {
    suggestedAccum: plan.accumSuggested,
    executedAccum: order.orderExecQty,
    completionPct: order.orderQty > 0 ? (order.orderExecQty / order.orderQty) * 100 : 0,
    remaining: Math.max(0, order.orderQty - order.orderExecQty),
    marketVWAP, orderVWAP, slipBps,
    minsToAuction: minutesBetween(curTime, order.auctionStart),
    coverage: plan.accumSuggested / Math.max(1, order.orderQty),
    liveRow,
    pacing, requiredRate,
  };
}

function buildAlerts(order: Order, m: ReturnType<typeof computeMetrics>) {
  if (order.completed) return [] as string[];
  const alerts: string[] = [];
  if (!(order.marketTurnover > 0 || m.marketVWAP > 0)) alerts.push("Missing market VWAP");
  if (order.currentVol === 0 && order.startVol === 0) alerts.push("Missing market volume");
  if (m.liveRow && m.liveRow.impactRisk) alerts.push("Impact risk on live slice");
  if (m.coverage < 0.95) alerts.push("Coverage risk: plan < 95% of order");
  if (m.requiredRate > IMPACT_WARNING_THRESHOLD * 1.5 * 100) alerts.push(`High required rate (${m.requiredRate.toFixed(0)}%)`);
  return alerts;
}

/* -------------------- Small UI atoms & New Components -------------------- */
function HeaderStat({ title, value }: { title: string; value: React.ReactNode }) {
  return (
    <div className="p-3 rounded-xl bg-slate-100">
      <div className="opacity-60 text-xs">{title}</div>
      <div className="font-semibold">{value}</div>
    </div>
  );
}
function IntInput({ label, value, onChange, className }: { label?: string; value: number; onChange: (n: number) => void; className?: string }) {
  const [draft, setDraft] = useState(formatInt(value));
  useEffect(() => setDraft(formatInt(value)), [value]);
  return (
    <label className={`text-sm ${className || ""}`}>
      {label}
      <input inputMode="numeric" pattern="[0-9]*" className="mt-1 w-full border rounded-xl p-2" value={draft}
        onChange={(e) => {
          const n = parseIntSafe(e.target.value);
          setDraft(formatInt(n));
          onChange(n);
        }}
      />
    </label>
  );
}
function MoneyInput({ label, value, onNumberChange, className, decimals = 4 }: { label?: string; value: number; onNumberChange: (n: number) => void; className?: string; decimals?: number }) {
  const [draft, setDraft] = useState(value === 0 ? "" : String(value));
  useEffect(() => setDraft(value === 0 ? "" : String(value)), [value]);
  return (
    <label className={`text-sm ${className || ""}`}>
      {label}
      <input inputMode="decimal" className="mt-1 w-full border rounded-xl p-2" value={draft}
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
function theme(side: Side) {
  return side === "BUY"
    ? { text: "text-emerald-700", bgSoft: "bg-emerald-50", border: "border-emerald-300", strong: "bg-emerald-600", fill: "fill-emerald-600", stroke: "stroke-emerald-600" }
    : { text: "text-rose-700", bgSoft: "bg-rose-50", border: "border-rose-300", strong: "bg-rose-600", fill: "fill-rose-600", stroke: "stroke-rose-600" };
}

function PacingIndicator({ pacing, requiredRate }: { pacing: number; requiredRate: number }) {
  if (!isFinite(pacing)) return null;
  const status = pacing > 5 ? "Ahead" : pacing < -5 ? "Behind" : "On Track";
  const color = status === "Ahead" ? "text-green-600" : status === "Behind" ? "text-amber-600" : "text-slate-600";

  return (
    <div className="text-xs px-2.5 py-1 rounded-full bg-slate-100 flex items-center gap-2">
      <span className="font-semibold">Pacing:</span>
      <span className={color}>
        {pacing.toFixed(0)}% ({status})
      </span>
      {status === "Behind" && (
        <span className="opacity-70" title="Required participation rate to catch up">
          | Req. Rate: {requiredRate.toFixed(1)}%
        </span>
      )}
    </div>
  );
}

function ExecutionChart({ order, plan, t }: { order: Order; plan: BuiltPlan, t: ReturnType<typeof theme> }) {
  const chartHeight = 150;
  const chartWidth = 400;

  const totalDuration = minutesBetween(order.sessionStart, order.sessionEnd);
  if (totalDuration <= 0) return <div>Invalid session times for chart.</div>

  const plannedPoints = [{x:0, y:chartHeight}, ...plan.rows.map(row => {
    const timePct = Math.max(0, minutesBetween(order.sessionStart, row.e) / totalDuration);
    const qtyPct = row.cumSuggested / order.orderQty;
    return { x: timePct * chartWidth, y: chartHeight - qtyPct * chartHeight };
  })];

  const actualPoints = [{x:0, y:chartHeight}, ...order.snapshots.map(snap => {
    const timePct = Math.max(0, minutesBetween(order.sessionStart, snap.at.slice(0, 5)) / totalDuration);
    const qtyPct = snap.orderExecQty / order.orderQty;
    return { x: timePct * chartWidth, y: chartHeight - qtyPct * chartHeight };
  })];
   if (order.completed && order.orderExecQty > 0) {
      const lastSnap = order.snapshots[order.snapshots.length-1];
      const timePct = lastSnap ? Math.max(0, minutesBetween(order.sessionStart, lastSnap.at.slice(0,5)) / totalDuration) : 1;
      actualPoints.push({x: timePct * chartWidth, y: chartHeight - (order.orderExecQty / order.orderQty) * chartHeight});
  }


  const toPath = (points: { x: number; y: number }[]) =>
    "M " + points.map(p => `${p.x.toFixed(2)} ${p.y.toFixed(2)}`).join(" L ");

  return (
    <div className="mt-4">
      <h4 className="font-semibold mb-2">Planned vs. Actual Execution</h4>
      <svg viewBox={`0 0 ${chartWidth} ${chartHeight}`} className="w-full h-auto border rounded-lg bg-white">
        <path d={toPath(plannedPoints)} strokeDasharray="4" className="stroke-slate-400" fill="none" strokeWidth="2" />
        <path d={toPath(actualPoints)} className={t.stroke} fill="none" strokeWidth="2" />
        <g transform="translate(10, 10)">
          <rect x="0" y="0" width="10" height="10" className="fill-slate-400" />
          <text x="15" y="9" className="text-[8px] fill-slate-600">Planned</text>
          <rect x="0" y="15" width="10" height="10" className={t.fill} />
          <text x="15" y="24" className="text-[8px] fill-slate-600">Actual</text>
        </g>
      </svg>
    </div>
  );
}

function PostTradeReportCard({ order, plan, metrics }: { order: Order; plan: BuiltPlan; metrics: ReturnType<typeof computeMetrics> }) {
  const t = theme(order.side);
  return (
    <div className="p-4">
      <h3 className="text-lg font-bold">Post-Trade Report Card</h3>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-3">
        <HeaderStat title="Final VWAP Slip" value={`${metrics.slipBps.toFixed(1)} bps`} />
        <HeaderStat title="Completion" value={`${metrics.completionPct.toFixed(1)}%`} />
        <HeaderStat title="Total Executed" value={formatInt(order.orderExecQty)} />
        <HeaderStat title="Final Order VWAP" value={formatMoney(metrics.orderVWAP, 4)} />
      </div>
      <ExecutionChart order={order} plan={plan} t={t} />
      <div className="mt-4">
        <h4 className="font-semibold mb-2">Decision Journal (Snapshots)</h4>
        <div className="overflow-x-auto rounded-xl border max-h-48">
          <table className="w-full text-xs">
             <thead className="bg-slate-50 sticky top-0">
                  <tr className="text-left">
                    <th className="p-2">Time</th><th className="p-2">Exec Qty</th><th className="p-2">Exec Notional</th><th className="p-2">Cur Vol</th>
                  </tr>
                </thead>
                <tbody>
                  {[...order.snapshots].map((s, i) => (
                    <tr key={i} className="border-t">
                      <td className="p-2 font-mono">{s.at}</td>
                      <td className="p-2">{formatInt(s.orderExecQty)}</td>
                      <td className="p-2">{formatMoney(s.orderExecNotional, 2)}</td>
                      <td className="p-2">{formatInt(s.currentVol)}</td>
                    </tr>
                  ))}
                  {order.snapshots.length === 0 && (
                    <tr><td colSpan={4} className="p-4 text-center text-slate-500">No snapshots were logged for this order.</td></tr>
                  )}
                </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
function VWAPBox({ order }: { order: Order }) {
  const marketVWAP =
    order.currentVol > 0
      ? order.marketTurnover > 0 ? order.marketTurnover / order.currentVol : order.marketVWAPInput || 0
      : order.marketVWAPInput || 0;
  const orderVWAP = order.orderExecQty > 0 ? order.orderExecNotional / order.orderExecQty : 0;
  const perf = performanceBps(order.side, orderVWAP, marketVWAP);
  const color = perf > 0 ? "text-green-600" : perf < 0 ? "text-red-600" : "";
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
      <HeaderStat title="Market VWAP" value={marketVWAP ? formatMoney(marketVWAP, 4) : "—"} />
      <HeaderStat title="Order VWAP" value={orderVWAP ? formatMoney(orderVWAP, 4) : "—"} />
      <HeaderStat title="Perf (bps)" value={<span className={color}>{Number.isFinite(perf) ? perf.toFixed(1) : "—"}</span>} />
      <HeaderStat title="Exec Qty" value={formatInt(order.orderExecQty)} />
    </div>
  );
}

function TradeSimulator({ order, marketVWAP }: { order: Order; marketVWAP: number }) {
  const [whatifQtyStr, setWhatifQtyStr] = useState("");
  const [whatifPriceStr, setWhatifPriceStr] = useState("");
  const whatifQty = parseIntSafe(whatifQtyStr);
  const whatifPrice = toNumberOrZero(whatifPriceStr);
  const currentVWAP = order.orderExecQty > 0 ? order.orderExecNotional / order.orderExecQty : 0;
  const currentCompletion = order.orderQty > 0 ? (order.orderExecQty / order.orderQty) * 100 : 0;
  const currentSlip = performanceBps(order.side, currentVWAP, marketVWAP);
  let newVWAP = currentVWAP;
  let newCompletion = currentCompletion;
  let newSlip = currentSlip;
  const showResults = whatifQty > 0 && whatifPrice > 0;
  if (showResults) {
    const newExecQty = order.orderExecQty + whatifQty;
    const newExecNotional = order.orderExecNotional + whatifQty * whatifPrice;
    newVWAP = newExecQty > 0 ? newExecNotional / newExecQty : 0;
    newCompletion = order.orderQty > 0 ? (newExecQty / order.orderQty) * 100 : 0;
    newSlip = performanceBps(order.side, newVWAP, marketVWAP);
  }
  const getChangeColor = (key: "vwap" | "completion" | "slip", current: number, next: number) => {
    const diff = next - current;
    if (!isFinite(diff) || diff === 0) return "text-slate-500";
    if (key === "completion" || key === "slip") return diff > 0 ? "text-green-600" : "text-red-600";
    if (order.side === "BUY") return diff < 0 ? "text-green-600" : "text-red-600";
    return diff > 0 ? "text-green-600" : "text-red-600";
  };
  return (
    <div className="p-3 rounded-xl bg-slate-50 border mt-4">
      <h4 className="font-semibold text-sm">VWAP Impact Calculator</h4>
      <div className="grid grid-cols-2 gap-3 mt-2">
        <label className="text-sm"> What-if Qty
          <input className="mt-1 w-full border rounded-xl p-2" value={formatInt(whatifQty)} onChange={(e) => setWhatifQtyStr(e.target.value)} placeholder="e.g., 100000" inputMode="numeric"/>
        </label>
        <label className="text-sm"> What-if Price
          <input className="mt-1 w-full border rounded-xl p-2" value={whatifPriceStr} onChange={(e) => setWhatifPriceStr(parseMoneySafeAllowTyping(e.target.value))} placeholder="e.g., 15.25" inputMode="decimal"/>
        </label>
      </div>
      {showResults && (
        <>
          <hr className="my-2 border-slate-200" />
          <div className="text-xs space-y-1 font-mono">
            <div> <span className="opacity-70">New Order VWAP: </span> {currentVWAP.toFixed(4)} →{" "} <strong className={getChangeColor("vwap", currentVWAP, newVWAP)}>{newVWAP.toFixed(4)}</strong> </div>
            <div> <span className="opacity-70">New Completion: </span> {currentCompletion.toFixed(1)}% →{" "} <strong className={getChangeColor("completion", currentCompletion, newCompletion)}>{newCompletion.toFixed(1)}%</strong> </div>
            <div> <span className="opacity-70">New Slip (bps): </span> {Number.isFinite(currentSlip) ? currentSlip.toFixed(1) : "—"} →{" "} <strong className={getChangeColor("slip", currentSlip, newSlip)}>{Number.isFinite(newSlip) ? newSlip.toFixed(1) : "—"}</strong> </div>
          </div>
        </>
      )}
    </div>
  );
}

/* -------------------- Main Per-order Card -------------------- */
function PlannerCard({ order, onChange, onRemove, onDuplicate, alertsOn }: { order: Order; onChange: (o: Order) => void; onRemove: () => void; onDuplicate: () => void; alertsOn: boolean; }) {
  const t = theme(order.side);
  const [clock, setClock] = useState(nowHHMMSS());
  useInterval(() => setClock(nowHHMMSS()), 1000);
  const plan = buildPlan(order);
  const metrics = computeMetrics(order, plan);
  const alerts = buildAlerts(order, metrics);
  const [showInputs, setShowInputs] = useState(true);
  const [showDetails, setShowDetails] = useState(false);
  function logSnapshot() {
    const snap: Snapshot = {
      at: nowHHMMSS(),
      currentVol: order.currentVol,
      expectedContVol: order.expectedContVol,
      expectedAuctionVol: order.expectedAuctionVol,
      orderExecQty: order.orderExecQty,
      orderExecNotional: order.orderExecNotional,
      marketTurnover: order.marketTurnover,
      marketVWAPInput: order.marketVWAPInput,
    };
    onChange({ ...order, snapshots: [...order.snapshots, snap] });
  }

  return (
    <div className={`rounded-2xl shadow border ${t.border} bg-white overflow-hidden`}>
      <div className={`px-4 py-3 border-b ${t.border} flex items-center justify-between`}>
        <div className="flex items-center gap-3">
          <span className={`inline-flex items-center px-2.5 py-1 rounded-full text-xs font-semibold ${t.bgSoft} ${t.text}`}>{order.side}</span>
          <div className="font-semibold">{order.name} ({order.symbol})</div>
        </div>
        <div className="flex gap-2">
          <button onClick={() => onChange({ ...order, completed: !order.completed })} className={`px-3 py-2 rounded-xl text-sm ${order.completed ? 'bg-green-600 text-white' : 'bg-slate-900 text-white'}`}>
            {order.completed ? "✓ Re-open" : "Mark Completed"}
          </button>
          <button onClick={onDuplicate} className="px-3 py-2 rounded-xl border text-sm">Duplicate</button>
          <button onClick={onRemove} className="px-3 py-2 rounded-xl border text-sm text-red-600">Remove</button>
        </div>
      </div>

      {order.completed ? (
        <PostTradeReportCard order={order} plan={plan} metrics={metrics} />
      ) : (
        <>
          <div className="p-4 grid grid-cols-2 md:grid-cols-4 gap-3">
            <HeaderStat title="Suggested Accum" value={formatInt(metrics.suggestedAccum)} />
            <HeaderStat title="Executed Accum" value={formatInt(metrics.executedAccum)} />
            <HeaderStat title="Completion %" value={`${metrics.completionPct.toFixed(1)}%`} />
            <HeaderStat title="VWAP Slip" value={`${Number.isFinite(metrics.slipBps) ? metrics.slipBps.toFixed(1) : '—'} bps`} />
          </div>
          <div className="px-4 pb-2 flex flex-wrap items-center gap-2">
            {alerts.map((a, i) => ( <span key={i} className={`text-xs px-2.5 py-1 rounded-full border ${t.border} ${t.bgSoft} ${t.text}`}>⚠️ {a}</span> ))}
            <div className="ml-auto"> <PacingIndicator pacing={metrics.pacing} requiredRate={metrics.requiredRate} /> </div>
          </div>

          <div className="px-4 pt-2">
            <button onClick={() => setShowInputs(s => !s)} className="text-xs border rounded px-2 py-1 w-full bg-slate-50 hover:bg-slate-100 flex items-center justify-center gap-2">
              {showInputs ? 'Hide Inputs & Settings' : 'Show Inputs & Settings'}
            </button>
          </div>
          {showInputs && (
            <div className="px-4 pb-4 pt-2 grid grid-cols-1 md:grid-cols-3 gap-4 border-t mt-2">
               {/* This is the full, restored input section */}
              <div className="space-y-3">
                <h3 className="font-semibold">Order</h3>
                <IntInput label="Order Qty" value={order.orderQty} onChange={(n) => onChange({ ...order, orderQty: n })} />
                <label className="text-sm">Mode
                    <select className="mt-1 w-full border rounded-xl p-2" value={order.execMode} onChange={(e) => onChange({ ...order, execMode: e.target.value as ExecMode })}>
                        <option value="OTD">OTD (time-sliced)</option><option value="INLINE">Inline (POV)</option>
                    </select>
                </label>
                <label className="text-sm">Cap
                    <select className="mt-1 w-full border rounded-xl p-2" value={order.capMode} onChange={(e) => onChange({ ...order, capMode: e.target.value as CapMode })}>
                        <option value="PCT">Max % of Volume</option><option value="NONE">No Volume Cap</option>
                    </select>
                </label>
                {order.capMode === "PCT" && ( <label className="text-sm">Max Part %<input type="number" className="mt-1 w-full border rounded-xl p-2" value={order.maxPart} onChange={(e) => onChange({ ...order, maxPart: Math.max(0, parseFloat(e.target.value || "0")) })}/></label> )}
                <label className="text-sm">Reserve Auction %<input type="number" className="mt-1 w-full border rounded-xl p-2" value={order.reserveAuctionPct} onChange={(e) => onChange({ ...order, reserveAuctionPct: Math.max(0, parseFloat(e.target.value || "0")) })}/></label>
              </div>
              <div className="space-y-3">
                <h3 className="font-semibold">Volumes</h3>
                <IntInput label="Current Vol (cum)" value={order.currentVol} onChange={(n) => onChange({ ...order, currentVol: n })} />
                <IntInput label="Expected Continuous Vol" value={order.expectedContVol} onChange={(n) => onChange({ ...order, expectedContVol: n })} />
                <IntInput label="Expected Auction Vol" value={order.expectedAuctionVol} onChange={(n) => onChange({ ...order, expectedAuctionVol: n })} />
              </div>
              <div className="space-y-3">
                <h3 className="font-semibold">VWAP & Execution</h3>
                <MoneyInput label="Market Turnover" value={order.marketTurnover} onNumberChange={(n) => onChange({ ...order, marketTurnover: n })} />
                <MoneyInput label="OR Manual Market VWAP" value={order.marketVWAPInput} onNumberChange={(n) => onChange({ ...order, marketVWAPInput: n })} />
                <IntInput label="Your Executed Qty" value={order.orderExecQty} onChange={(n) => onChange({ ...order, orderExecQty: n })} />
                <MoneyInput label="Your Executed Notional" value={order.orderExecNotional} onNumberChange={(n) => onChange({ ...order, orderExecNotional: n })} />
                <TradeSimulator order={order} marketVWAP={metrics.marketVWAP} />
              </div>
            </div>
          )}

          <div className="px-4 pb-4">
            <div className="flex items-center justify-between mt-2">
                <button onClick={() => setShowDetails(s => !s)} className="text-xs border rounded px-2 py-1 bg-slate-50 hover:bg-slate-100 flex items-center justify-center gap-2">
                   {showDetails ? 'Hide Execution Plan Details' : 'Show Execution Plan Details'}
                </button>
                <button onClick={logSnapshot} className={`px-3 py-1.5 rounded-lg text-xs text-white ${t.strong}`}>Log Snapshot</button>
            </div>
            {showDetails && (
              <div className="overflow-x-auto rounded-xl border mt-2 max-h-60">
                <table className="w-full text-sm">
                  <thead className="bg-white sticky top-0">
                    <tr className="text-left border-b">
                      <th className="p-2">Interval</th><th className="p-2">Suggested Qty</th><th className="p-2">Exp Mkt Vol</th><th className="p-2">Max Allowed</th>
                    </tr>
                  </thead>
                  <tbody>
                    {plan.rows.map((r) => (
                      <tr key={r.interval} className={`border-b last:border-0 ${r.impactRisk ? 'bg-amber-50' : ''} ${metrics.liveRow?.s === r.s ? `${t.bgSoft} animate-pulse` : ""}`}>
                        <td className={`p-2 ${t.text}`}>{r.impactRisk && '⚠️ '}{r.interval}</td>
                        <td className="p-2 font-semibold">{formatInt(r.suggestedQty)}</td><td className="p-2">{formatInt(r.expMktVol)}</td>
                        <td className="p-2">{typeof r.maxAllowed === 'number' ? formatInt(r.maxAllowed) : r.maxAllowed}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

/* -------------------- App Shell -------------------- */
export default function App() {
  const [orders, setOrders] = useState<Order[]>([defaultOrder("BUY", 1), defaultOrder("SELL", 1)]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [hideCompleted, setHideCompleted] = useState(false);
  const visibleBase = selectedId ? orders.filter((o) => o.id === selectedId) : orders;
  const visible = hideCompleted ? visibleBase.filter((o) => !o.completed) : visibleBase;
  const addOrder = (side: Side) => setOrders((o) => [...o, defaultOrder(side, o.length + 1)]);
  const removeOrder = (id: string) => {
    setOrders((o) => o.filter((x) => x.id !== id));
    if (selectedId === id) setSelectedId(null);
  };
  const duplicateOrder = (id: string) =>
    setOrders((o) => {
      const src = o.find((x) => x.id === id);
      if (!src) return o;
      return [...o, { ...src, id: Math.random().toString(36).slice(2, 9), name: src.name + " (copy)" }];
    });
  const updateOrder = (id: string, next: Order) => setOrders((o) => o.map((x) => (x.id === id ? next : x)));

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <div className="sticky top-0 z-20 backdrop-blur bg-slate-50/80 border-b">
        <div className="max-w-7xl mx-auto p-4">
          <div className="flex items-center justify-between flex-wrap gap-3">
            <h1 className="text-xl font-bold">Execution Planner v2.1</h1>
            <div className="flex items-center gap-2">
              <label className="text-xs flex items-center gap-2 mr-2">
                <input type="checkbox" checked={hideCompleted} onChange={(e) => setHideCompleted(e.target.checked)} /> Hide completed
              </label>
              <button onClick={() => addOrder("BUY")} className="px-3 py-2 rounded-xl bg-emerald-600 text-white text-sm">+ Add BUY</button>
              <button onClick={() => addOrder("SELL")} className="px-3 py-2 rounded-xl bg-rose-600 text-white text-sm">+ Add SELL</button>
            </div>
          </div>
        </div>
      </div>
      <div className="max-w-5xl mx-auto p-4 flex gap-6">
        <div className="flex-1 grid gap-5">
          {orders.map((o) => (
             (!hideCompleted || !o.completed) && <PlannerCard key={o.id} order={o} alertsOn={true} onChange={(n) => updateOrder(o.id, n)} onRemove={() => removeOrder(o.id)} onDuplicate={() => duplicateOrder(o.id)}/>
          ))}
          {orders.filter(o => !hideCompleted || !o.completed).length === 0 && <div className="text-sm text-slate-500 text-center py-10">No orders to show.</div>}
        </div>
      </div>
    </div>
  );
}
