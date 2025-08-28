import React, { useEffect, useMemo, useRef, useState } from "react";

/* ============================================================
   Types
============================================================ */
type Side = "BUY" | "SELL";
type ExecMode = "OTD" | "INLINE";
type CapMode = "NONE" | "PCT";
type Curve = "equal" | "ucurve";
type MarketKey = "Egypt" | "Kuwait" | "Qatar" | "DFM" | "ADX" | "Saudi";

type Snapshot = {
  at: string; // HH:MM:SS
  currentVol: number;
  orderExecQty: number;
  orderExecNotional: number;
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

  startVol: number;
  currentVol: number; // cum market volume
  expectedContVol: number;
  expectedAuctionVol: number;

  marketTurnover: number; // currency
  marketVWAPInput: number; // manual VWAP
  orderExecQty: number; // executed qty (user input)
  orderExecNotional: number;

  market?: MarketKey;

  snapshots: Snapshot[];

  simpleMode?: boolean;
  completed?: boolean;
};

/* ============================================================
   Market presets (times)
============================================================ */
const MARKET_PRESET: Record<
  MarketKey,
  { start: string; end: string; auction: string; auctionMatch: string; talStart: string; talEnd: string }
> = {
  Egypt:  { start: "10:00", end: "14:15", auction: "14:15", auctionMatch: "14:25", talStart: "14:25", talEnd: "14:30" },
  Kuwait: { start: "09:00", end: "12:30", auction: "12:30", auctionMatch: "12:40", talStart: "12:40", talEnd: "12:45" },
  Qatar:  { start: "09:30", end: "13:00", auction: "13:00", auctionMatch: "13:10", talStart: "13:10", talEnd: "13:15" },
  DFM:    { start: "09:00", end: "13:45", auction: "13:45", auctionMatch: "13:55", talStart: "13:55", talEnd: "14:00" },
  ADX:    { start: "09:00", end: "13:45", auction: "13:45", auctionMatch: "13:55", talStart: "13:55", talEnd: "14:00" },
  Saudi:  { start: "10:00", end: "15:00", auction: "15:00", auctionMatch: "15:10", talStart: "15:10", talEnd: "15:20" },
};

/* ============================================================
   Utilities
============================================================ */
function pad2(n: number) { return String(n).padStart(2, "0"); }
function nowHHMM() { const d=new Date(); return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`; }
function nowHHMMSS() { const d=new Date(); return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`; }

function minutesBetween(t1: string, t2: string) {
  const [h1, m1] = t1.split(":").map((x) => parseInt(x || "0", 10));
  const [h2, m2] = t2.split(":").map((x) => parseInt(x || "0", 10));
  return h2 * 60 + m2 - (h1 * 60 + m1);
}
function addMinutes(t: string, mins: number) {
  const [h, m] = t.split(":").map((x) => parseInt(x || "0", 10));
  const total = h * 60 + m + mins;
  const mod = ((total % (24 * 60)) + (24 * 60)) % (24 * 60);
  const hh = Math.floor(mod / 60);
  const mm = mod % 60;
  return `${pad2(hh)}:${pad2(mm)}`;
}
function withinSlice(cur: string, s: string, e: string) {
  const toMin = (t: string) => {
    const [hh, mm] = t.split(":").map((v) => parseInt(v || "0", 10));
    return hh * 60 + mm;
  };
  const c = toMin(cur), cs = toMin(s), ce = toMin(e);
  return c >= cs && c < ce;
}
function clamp01(n:number){ return Math.max(0, Math.min(1, n)); }
function formatInt(n: number | null | undefined) {
  if (n == null || isNaN(n as any)) return "—";
  return Math.trunc(Number(n)).toLocaleString();
}
function parseIntSafe(v: string) {
  const digits = v.replace(/[^0-9]/g, "");
  return digits ? parseInt(digits, 10) : 0;
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
function useInterval(callback: () => void, delay: number | null) {
  const savedRef = useRef<() => void>();
  useEffect(() => { savedRef.current = callback; }, [callback]);
  useEffect(() => {
    if (delay === null) return;
    const id = setInterval(() => savedRef.current && savedRef.current(), delay);
    return () => clearInterval(id);
  }, [delay]);
}

/* ============================================================
   Weighting & planning
============================================================ */
function uCurveWeights(n: number) {
  if (n <= 0) return [] as number[];
  const weights: number[] = [];
  const mid = (n - 1) / 2;
  for (let i = 0; i < n; i++) {
    const x = Math.abs(i - mid) / (mid || 1);
    const w = 0.6 + 0.8 * (1 - x);
    weights.push(w);
  }
  const sum = weights.reduce((a, b) => a + b, 0) || 1;
  return weights.map((w) => w / sum);
}
function equalWeights(n: number) {
  if (n <= 0) return [] as number[];
  return Array(n).fill(1 / n);
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
function applyCap(capMode: CapMode, maxPart: number, qty: number, sliceVol: number) {
  if (capMode === "NONE") return Math.max(0, Math.floor(qty));
  const allowed = Math.floor((sliceVol * maxPart) / 100);
  return Math.max(0, Math.min(Math.floor(qty), allowed));
}

/* ============================================================
   Planning + pacing target
============================================================ */
type BuiltRow = {
  interval: string;
  s: string;
  e: string;
  expMktVol: number;
  maxAllowed: number | "∞";
  suggestedQty: number;
};
type BuiltPlan = {
  rows: BuiltRow[];
  contPlanned: number;
  auctionAllowed: number;
  auctionPlanned: number;
};
function buildPlan(order: Order): BuiltPlan {
  const slices = timeSlices(order.sessionStart, order.sessionEnd, order.intervalMins);
  const weights = order.curve === "equal" ? equalWeights(slices.length) : uCurveWeights(slices.length);
  const contVolPerSlice = weights.map((w) => Math.floor(w * order.expectedContVol));
  const reserveAuctionQty = Math.floor((order.orderQty * order.reserveAuctionPct) / 100);

  const auctionAllowed =
    order.capMode === "PCT"
      ? Math.floor((order.expectedAuctionVol * order.maxPart) / 100)
      : order.expectedAuctionVol;

  const rows: BuiltRow[] = [];

  if (order.execMode === "OTD") {
    const targetContinuousQty = Math.max(0, order.orderQty - reserveAuctionQty);
    let remaining = targetContinuousQty;

    for (let i = 0; i < slices.length; i++) {
      const sliceVol = Math.max(0, contVolPerSlice[i]);
      const base = Math.min(Math.floor(weights[i] * targetContinuousQty), remaining);
      let suggested = applyCap(order.capMode, order.maxPart, base, sliceVol);
      const isLast = i === slices.length - 1;
      if (order.deferCompletion && !isLast) {
        const keepBack = Math.ceil(targetContinuousQty * 0.05);
        if (remaining - suggested <= 0) suggested = Math.max(0, remaining - keepBack);
      }
      suggested = Math.min(suggested, remaining);
      remaining -= suggested;

      rows.push({
        interval: slices[i].label,
        s: slices[i].s,
        e: slices[i].e,
        expMktVol: sliceVol,
        maxAllowed: order.capMode === "PCT" ? Math.floor((sliceVol * order.maxPart) / 100) : "∞",
        suggestedQty: suggested,
      });
    }

    const contPlanned = rows.reduce((a, r) => a + r.suggestedQty, 0);
    const auctionPlanned = Math.min(
      reserveAuctionQty + Math.max(0, targetContinuousQty - contPlanned),
      auctionAllowed
    );
    return { rows, contPlanned, auctionAllowed, auctionPlanned };
  }

  // INLINE POV
  const expectedTotalVol = order.currentVol + order.expectedContVol + order.expectedAuctionVol;
  const pov = expectedTotalVol > 0 ? Math.min(1, order.orderQty / expectedTotalVol) : 0;

  for (let i = 0; i < slices.length; i++) {
    const sliceVol = Math.max(0, contVolPerSlice[i]);
    const base = Math.floor(sliceVol * pov);
    const suggested = applyCap(order.capMode, order.maxPart, base, sliceVol);
    rows.push({
      interval: slices[i].label,
      s: slices[i].s,
      e: slices[i].e,
      expMktVol: sliceVol,
      maxAllowed: order.capMode === "PCT" ? Math.floor((sliceVol * order.maxPart) / 100) : "∞",
      suggestedQty: suggested,
    });
  }

  const contPlanned = rows.reduce((a, r) => a + r.suggestedQty, 0);
  let auctionPlanned =
    order.capMode === "PCT"
      ? Math.floor((order.expectedAuctionVol * pov * order.maxPart) / 100)
      : Math.floor(order.expectedAuctionVol * pov);

  let totalPlanned = contPlanned + auctionPlanned;
  if (totalPlanned > order.orderQty) {
    const excess = totalPlanned - order.orderQty;
    for (let i = rows.length - 1; i >= 0 && excess > 0; i--) {
      const trim = Math.min(excess, rows[i].suggestedQty);
      rows[i].suggestedQty -= trim;
      totalPlanned -= trim;
    }
    auctionPlanned = Math.max(0, order.orderQty - contPlanned);
  }
  return { rows, contPlanned, auctionAllowed, auctionPlanned };
}
function targetAccumByNow(plan: BuiltPlan, sessionStart: string, now: string) {
  let accum = 0;
  for (const r of plan.rows) {
    if (now >= r.e) {
      accum += r.suggestedQty;
    } else if (withinSlice(now, r.s, r.e)) {
      const sliceLen = Math.max(1, minutesBetween(r.s, r.e));
      const elapsed = Math.max(0, minutesBetween(r.s, now));
      const ratio = clamp01(elapsed / sliceLen);
      accum += Math.floor(r.suggestedQty * ratio);
      break;
    } else if (now < r.s) break;
  }
  return accum;
}

/* ============================================================
   Performance & Slippage
============================================================ */
function performanceBps(side: Side, orderVWAP: number, marketVWAP: number) {
  if (!marketVWAP || !orderVWAP) return 0;
  return side === "BUY"
    ? ((marketVWAP - orderVWAP) / marketVWAP) * 10000
    : ((orderVWAP - marketVWAP) / marketVWAP) * 10000;
}

/* ============================================================
   Small UI atoms
============================================================ */
function HeaderStat({ title, value }: { title: string; value: React.ReactNode }) {
  return (
    <div className="p-3 rounded-xl bg-slate-100">
      <div className="opacity-60 text-xs">{title}</div>
      <div className="font-semibold">{value}</div>
    </div>
  );
}
function IntInput({ label, value, onChange, className }: {
  label?: string; value: number; onChange: (n:number)=>void; className?: string;
}) {
  const [draft, setDraft] = useState(value === 0 ? "" : String(value));
  useEffect(()=>setDraft(value === 0 ? "" : String(value)),[value]);
  return (
    <label className={`text-sm ${className || ""}`}>
      {label}
      <input
        inputMode="numeric"
        pattern="[0-9]*"
        className="mt-1 w-full border rounded-xl p-2"
        value={draft}
        onChange={(e)=>{
          const n = parseIntSafe(e.target.value);
          setDraft(e.target.value);
          onChange(n);
        }}
        onBlur={()=> setDraft(value ? value.toLocaleString() : "")}
      />
    </label>
  );
}
function MoneyInput({ label, value, onNumberChange, className, decimals=4 }: {
  label?: string; value: number; onNumberChange:(n:number)=>void; className?:string; decimals?:number;
}) {
  const [draft, setDraft] = useState(value===0? "" : String(value));
  useEffect(()=>setDraft(value===0? "" : String(value)),[value]);
  return (
    <label className={`text-sm ${className || ""}`}>
      {label}
      <input
        inputMode="decimal"
        className="mt-1 w-full border rounded-xl p-2"
        value={draft}
        onChange={(e)=>{
          const next = parseMoneySafeAllowTyping(e.target.value);
          setDraft(next);
          onNumberChange(toNumberOrZero(next));
        }}
        onBlur={()=>{
          const n = toNumberOrZero(draft);
          setDraft(n ? n.toLocaleString(undefined,{maximumFractionDigits:decimals}) : "");
          onNumberChange(n);
        }}
        onFocus={()=>{
          const n = toNumberOrZero(draft);
          if (n) setDraft(String(n));
        }}
      />
    </label>
  );
}
function theme(side: Side) {
  return side === "BUY"
    ? { text: "text-emerald-700", bgSoft: "bg-emerald-50", border: "border-emerald-300", strong: "bg-emerald-600" }
    : { text: "text-rose-700", bgSoft: "bg-rose-50", border: "border-rose-300", strong: "bg-rose-600" };
}

/* ============================================================
   Phase
============================================================ */
type Phase = "PRE" | "CONT" | "AUCTION" | "TAL" | "CLOSED";
function getPhase(order: Order, now: string): Phase {
  if (now < order.sessionStart) return "PRE";
  if (now >= order.sessionStart && now < order.sessionEnd) return "CONT";
  if (now >= order.sessionEnd && now < order.auctionEnd) return "AUCTION";
  if (now >= order.auctionEnd && now < order.talEnd) return "TAL";
  return "CLOSED";
}

/* ============================================================
   Decision advice (Next Best Action) + Impact score
============================================================ */
function advise(order: Order, plan: BuiltPlan, nowHHMMs: string) {
  const shouldAccum = targetAccumByNow(plan, order.sessionStart, nowHHMMs);
  const execAccum = order.orderExecQty;
  const delta = execAccum - shouldAccum;

  // Live slice
  const live = plan.rows.find(r => withinSlice(nowHHMMs, r.s, r.e));
  let nextClip = 0;
  if (live) {
    const sliceLen = Math.max(1, minutesBetween(live.s, live.e));
    const elapsed = Math.max(0, minutesBetween(live.s, nowHHMMs));
    const alreadyShould = Math.floor(live.suggestedQty * clamp01(elapsed / sliceLen));
    const remainingInSlice = Math.max(0, live.suggestedQty - alreadyShould);
    nextClip = typeof live.maxAllowed === "number" ? Math.min(remainingInSlice, live.maxAllowed) : remainingInSlice;
  }

  const remainingOrder = Math.max(0, order.orderQty - execAccum);
  const expRemainingVol = Math.max(1, order.expectedContVol + order.expectedAuctionVol);
  const requiredPOV = remainingOrder / expRemainingVol;
  const impactScore = Math.min(10, Math.max(1, Math.round(requiredPOV * 10)));

  let action = "Hold steady.";
  if (delta < -0.1 * (shouldAccum || 1)) action = `Behind pace → execute ~${formatInt(Math.max(nextClip, Math.floor(remainingOrder*0.1)))}`;
  if (delta > 0.1 * (shouldAccum || 1)) action = "Ahead of pace → consider easing unless liquidity is exceptional.";
  if (impactScore >= 8) action = "High required participation → reduce clip size or lean on auction.";

  return { nextClip: Math.max(0, nextClip), pacingDelta: delta, requiredPOV, impactScore, action };
}

/* ============================================================
   Status HUD (compact, glanceable)
============================================================ */
function StatusHUD({ order, plan, nowHHMMs }: { order: Order; plan: BuiltPlan;