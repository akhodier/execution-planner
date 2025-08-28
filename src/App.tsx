import React, { useEffect, useMemo, useRef, useState } from "react";

/** ======================================================================
 * Execution Planner — Editable Names + Multi-Block What-If Simulator
 * - Per-order Market Presets (affects that order only)
 * - Editable Order Name (header inline)
 * - Multi-block What-If Simulator (Qty/Price rows -> blended VWAP & completion)
 * - Advanced Options (collapsible): min clip, impact guard, pace mode
 * - Compact pacing & alerts HUD
 * ====================================================================== */

/* -------------------- Market presets -------------------- */
type MarketKey = "Egypt" | "Kuwait" | "Qatar" | "DFM" | "ADX" | "Saudi";

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

/* -------------------- Types -------------------- */
type ExecMode = "OTD" | "INLINE";
type CapMode = "NONE" | "PCT";
type Curve = "equal" | "ucurve";
type Side = "BUY" | "SELL";

type WhatIfBlock = { qty: number; price: number };

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
  startVol: number;
  currentVol: number;
  expectedContVol: number;
  expectedAuctionVol: number;

  // VWAP monitor (either turnover OR manual VWAP)
  marketTurnover: number;
  marketVWAPInput: number;

  // executed so far
  orderExecQty: number;
  orderExecNotional: number;

  // presets / UI
  market?: MarketKey;
  startFromNow?: boolean;

  // simulator
  whatIf: WhatIfBlock[];

  // advanced options
  minClip?: number;
  impactGuardPct?: number;
  paceMode?: "Slow" | "Normal" | "Fast";
};

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
    startFromNow: false,

    whatIf: [],

    minClip: 0,
    impactGuardPct: 25,
    paceMode: "Normal",
  };
}

/* -------------------- Planning -------------------- */
function applyCap(capMode: CapMode, maxPart: number, qty: number, sliceVol: number) {
  if (capMode === "NONE") return Math.max(0, Math.floor(qty));
  const allowed = Math.floor((sliceVol * maxPart) / 100);
  return Math.max(0, Math.min(Math.floor(qty), allowed));
}
function buildPlan(order: Order) {
  const slices = timeSlices(order.sessionStart, order.sessionEnd, order.intervalMins);
  let weights = order.curve === "equal" ? equalWeights(slices.length) : uCurveWeights(slices.length);
  // Pace mode tweak (subtle, to keep UX predictable)
  if (order.paceMode === "Fast" && order.curve !== "equal") {
    // slightly front-load: multiply earlier weights a bit
    weights = weights.map((w, i) => w * (1 + 0.15 * (1 - i / Math.max(1, weights.length - 1))));
    const sum = weights.reduce((a, b) => a + b, 0);
    weights = weights.map((w) => w / (sum || 1));
  }
  if (order.paceMode === "Slow" && order.curve !== "equal") {
    // slightly back-load
    weights = weights.map((w, i) => w * (1 + 0.15 * (i / Math.max(1, weights.length - 1))));
    const sum = weights.reduce((a, b) => a + b, 0);
    weights = weights.map((w) => w / (sum || 1));
  }

  const contVolPerSlice = weights.map((w) => Math.floor(w * order.expectedContVol));
  const reserveAuctionQty = Math.floor((order.orderQty * order.reserveAuctionPct) / 100);

  type Row = { interval: string; s: string; e: string; expMktVol: number; maxAllowed: number | "∞"; suggestedQty: number; impactFlag?: boolean; };
  let rows: Row[] = [];

  const auctionAllowed =
    order.capMode === "PCT" ? Math.floor((order.expectedAuctionVol * order.maxPart) / 100) : order.expectedAuctionVol;

  if (order.execMode === "OTD") {
    const targetContinuousQty = Math.max(0, order.orderQty - reserveAuctionQty);
    let remaining = targetContinuousQty;

    rows = slices.map((slice, i) => {
      const sliceVol = Math.max(0, contVolPerSlice[i]);
      let base = Math.floor(weights[i] * targetContinuousQty);
      base = Math.min(base, remaining);
      let suggested = applyCap(order.capMode, order.maxPart, base, sliceVol);

      // min clip guard (advanced)
      if (order.minClip && suggested > 0) {
        suggested = Math.max(order.minClip, suggested);
      }

      const isLast = i === slices.length - 1;
      if (order.deferCompletion && !isLast) {
        const keepBack = Math.ceil(targetContinuousQty * 0.05);
        if (remaining - suggested <= 0) suggested = Math.max(0, remaining - keepBack);
      }

      suggested = Math.min(suggested, remaining);
      remaining -= suggested;

      const maxAllowed = order.capMode === "PCT" ? Math.floor((sliceVol * order.maxPart) / 100) : "∞";
      const impactFlag =
        typeof maxAllowed === "number" && sliceVol > 0
          ? suggested / sliceVol >= (order.impactGuardPct ?? 25) / 100
          : false;

      return {
        interval: slice.label,
        s: slice.s,
        e: slice.e,
        expMktVol: sliceVol,
        maxAllowed,
        suggestedQty: suggested,
        impactFlag,
      };
    });

    const contPlanned = rows.reduce((a, r) => a + r.suggestedQty, 0);
    const auctionPlanned = Math.min(
      reserveAuctionQty + Math.max(0, targetContinuousQty - contPlanned),
      auctionAllowed
    );

    return { rows, contPlanned, auctionAllowed, auctionPlanned };
  }

  // INLINE (POV)
  const expectedTotalVol = order.currentVol + order.expectedContVol + order.expectedAuctionVol;
  const pov = expectedTotalVol > 0 ? Math.min(1, order.orderQty / expectedTotalVol) : 0;

  rows = slices.map((slice, i) => {
    const sliceVol = Math.max(0, contVolPerSlice[i]);
    let base = Math.floor(sliceVol * pov);
    let suggested = applyCap(order.capMode, order.maxPart, base, sliceVol);
    // min clip guard (advanced)
    if (order.minClip && suggested > 0) {
      suggested = Math.max(order.minClip, suggested);
    }
    const maxAllowed = order.capMode === "PCT" ? Math.floor((sliceVol * order.maxPart) / 100) : "∞";
    const impactFlag =
      typeof maxAllowed === "number" && sliceVol > 0
        ? suggested / sliceVol >= (order.impactGuardPct ?? 25) / 100
        : false;

    return {
      interval: slice.label,
      s: slice.s,
      e: slice.e,
      expMktVol: sliceVol,
      maxAllowed,
      suggestedQty: suggested,
      impactFlag,
    };
  });

  const contPlanned = rows.reduce((a, r) => a + r.suggestedQty, 0);
  let auctionPlanned =
    order.capMode === "PCT"
      ? Math.floor((order.expectedAuctionVol * pov * order.maxPart) / 100)
      : Math.floor(order.expectedAuctionVol * pov);

  let totalPlanned = contPlanned + auctionPlanned;
  if (totalPlanned > order.orderQty) {
    const excess = totalPlanned - order.orderQty;
    auctionPlanned = Math.max(0, auctionPlanned - excess);
  }

  return { rows, contPlanned, auctionAllowed, auctionPlanned };
}

/* -------------------- VWAP + performance helpers -------------------- */
function performanceBps(side: Side, orderVWAP: number, marketVWAP: number) {
  if (!marketVWAP || !orderVWAP) return 0;
  return side === "BUY"
    ? ((marketVWAP - orderVWAP) / marketVWAP) * 10000
    : ((orderVWAP - marketVWAP) / marketVWAP) * 10000;
}

function impliedMarketVWAP(turnover: number, vol: number, manual: number) {
  if (vol > 0 && turnover > 0) return turnover / vol;
  if (manual > 0) return manual;
  return 0;
}

/* -------------------- Small atoms -------------------- */
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
function theme(side: Side) {
  return side === "BUY"
    ? { text: "text-emerald-700", bgSoft: "bg-emerald-50", border: "border-emerald-300", strong: "bg-emerald-600" }
    : { text: "text-rose-700", bgSoft: "bg-rose-50", border: "border-rose-300", strong: "bg-rose-600" };
}

/* -------------------- VWAP widget -------------------- */
function VWAPBox({ order }: { order: Order }) {
  const marketVWAP = impliedMarketVWAP(order.marketTurnover, order.currentVol, order.marketVWAPInput);
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

/* -------------------- What-If Simulator (multi-block) -------------------- */
function WhatIfSimulator({ order, onChange }: { order: Order; onChange: (o: Order) => void }) {
  const baseQty = order.orderExecQty;
  const baseNot = order.orderExecNotional;

  const totals = useMemo(() => {
    const addQty = order.whatIf.reduce((a, b) => a + (Number.isFinite(b.qty) ? b.qty : 0), 0);
    const addNot = order.whatIf.reduce((a, b) => a + ((Number.isFinite(b.qty) && Number.isFinite(b.price)) ? b.qty * b.price : 0), 0);
    const newQty = baseQty + addQty;
    const newNot = baseNot + addNot;
    const newVWAP = newQty > 0 ? newNot / newQty : 0;
    const newCompletion = order.orderQty > 0 ? (newQty / order.orderQty) * 100 : 0;
    return { addQty, addNot, newQty, newNot, newVWAP, newCompletion };
  }, [order.whatIf, baseQty, baseNot, order.orderQty]);

  const marketVWAP = impliedMarketVWAP(order.marketTurnover, order.currentVol, order.marketVWAPInput);
  const baseVWAP = baseQty > 0 ? baseNot / baseQty : 0;
  const basePerf = performanceBps(order.side, baseVWAP, marketVWAP);
  const newPerf = performanceBps(order.side, totals.newVWAP, marketVWAP);

  return (
    <div className="rounded-xl border p-3 bg-slate-50">
      <div className="flex items-center justify-between">
        <h4 className="font-semibold text-sm">What-If Simulator</h4>
        <button
          className="text-xs px-2 py-1 rounded-lg border"
          onClick={() => onChange({ ...order, whatIf: [...order.whatIf, { qty: 0, price: 0 }] })}
        >
          + Add Block
        </button>
      </div>

      <div className="mt-2 space-y-2">
        {order.whatIf.length === 0 && (
          <div className="text-xs text-slate-500">Add one or more hypothetical fills (Qty & Price) to see blended VWAP and completion.</div>
        )}
        {order.whatIf.map((w, i) => (
          <div key={i} className="flex items-center gap-2">
            <input
              type="number"
              placeholder="Qty"
              className="w-28 border rounded-lg p-1 text-sm"
              value={Number.isFinite(w.qty) ? w.qty : 0}
              onChange={(e) => {
                const arr = [...order.whatIf];
                arr[i] = { ...arr[i], qty: parseInt(e.target.value || "0") };
                onChange({ ...order, whatIf: arr });
              }}
            />
            <input
              type="number"
              step="0.0001"
              placeholder="Price"
              className="w-28 border rounded-lg p-1 text-sm"
              value={Number.isFinite(w.price) ? w.price : 0}
              onChange={(e) => {
                const arr = [...order.whatIf];
                arr[i] = { ...arr[i], price: parseFloat(e.target.value || "0") };
                onChange({ ...order, whatIf: arr });
              }}
            />
            <button
              className="text-xs px-2 py-1 rounded-lg border"
              onClick={() => onChange({ ...order, whatIf: order.whatIf.filter((_, j) => j !== i) })}
            >
              ✕
            </button>
          </div>
        ))}
      </div>

      <div className="mt-3 grid md:grid-cols-3 gap-3 text-sm">
        <HeaderStat title="New VWAP" value={totals.newQty ? formatMoney(totals.newVWAP, 4) : "—"} />
        <HeaderStat title="New Completion" value={`${totals.newQty ? totals.newCompletion.toFixed(1) : "0.0"}%`} />
        <HeaderStat
          title="Perf (bps) → What-If"
          value={
            <span>
              {Number.isFinite(basePerf) ? basePerf.toFixed(1) : "—"} →{" "}
              <span className={newPerf > 0 ? "text-green-600" : newPerf < 0 ? "text-red-600" : ""}>
                {Number.isFinite(newPerf) ? newPerf.toFixed(1) : "—"}
              </span>
            </span>
          }
        />
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
}: {
  order: Order;
  onChange: (o: Order) => void;
  onRemove: () => void;
  onDuplicate: () => void;
}) {
  const t = theme(order.side);
  const [clock, setClock] = useState(nowHHMMSS());
  useInterval(() => setClock(nowHHMMSS()), 1000);

  const plan = useMemo(() => buildPlan(order), [order]);
  const totalPlanned = plan.contPlanned + plan.auctionPlanned;
  const remaining = Math.max(0, order.orderQty - totalPlanned);
  const progress = order.orderQty > 0 ? Math.min(100, Math.round((totalPlanned / order.orderQty) * 100)) : 0;

  const marketVWAP = impliedMarketVWAP(order.marketTurnover, order.currentVol, order.marketVWAPInput);
  const orderVWAP = order.orderExecQty > 0 ? order.orderExecNotional / order.orderExecQty : 0;
  const perf = performanceBps(order.side, orderVWAP, marketVWAP);

  // Pacing — suggested accum by "now"
  const now = new Date();
  const nowStr = now.toTimeString().slice(0, 5) + ":00";
  const suggestedToNow = plan.rows
    .filter((r) => r.s <= nowStr)
    .reduce((a, r) => a + r.suggestedQty, 0);
  const pacingPct =
    suggestedToNow > 0 ? ((order.orderExecQty - suggestedToNow) / suggestedToNow) * 100 : 0;

  // Alerts
  const alerts: string[] = [];
  if (!(order.marketTurnover > 0 || order.marketVWAPInput > 0)) alerts.push("Missing market VWAP (turnover or manual)");
  if (order.currentVol === 0 && order.startVol === 0) alerts.push("Missing market volume");
  if (order.orderExecQty > order.orderQty) alerts.push("Executed > Order (check inputs)");
  const liveIdx = plan.rows.findIndex((r) => nowStr >= r.s && nowStr < r.e);
  const liveSlice = liveIdx >= 0 ? plan.rows[liveIdx] : null;
  if (liveSlice && typeof liveSlice.maxAllowed === "number" && liveSlice.suggestedQty >= liveSlice.maxAllowed) {
    alerts.push("Cap binding in live slice");
  }
  const impactWarn = plan.rows.some((r) => r.impactFlag);
  if (impactWarn) alerts.push("High impact slice(s) flagged (⚠︎)");

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

  return (
    <div className={`rounded-2xl shadow border ${t.border} bg-white overflow-hidden`}>
      {/* Header */}
      <div className={`px-4 py-3 border-b ${t.border} flex flex-wrap items-center gap-3 justify-between`}>
        <div className="flex items-center gap-3">
          <span className={`inline-flex items-center px-2.5 py-1 rounded-full text-xs font-semibold ${t.bgSoft} ${t.text}`}>{order.side}</span>
          <input
            className="text-base md:text-lg font-semibold border-b border-dashed focus:outline-none"
            value={order.name}
            onChange={(e) => onChange({ ...order, name: e.target.value })}
          />
          <div className="text-sm opacity-70">Local time: <span className="font-mono">{clock}</span></div>
        </div>
        <div className="flex gap-2">
          <button onClick={onDuplicate} className="px-3 py-2 rounded-xl border text-sm">Duplicate</button>
          <button onClick={onRemove} className="px-3 py-2 rounded-xl border text-sm">Remove</button>
        </div>
      </div>

      {/* HUD */}
      <div className="px-4 py-3 grid md:grid-cols-5 gap-3 items-end">
        <HeaderStat title="Planned (accum)" value={formatInt(totalPlanned)} />
        <HeaderStat title="Executed (accum)" value={formatInt(order.orderExecQty)} />
        <HeaderStat title="Completion" value={`${progress}%`} />
        <HeaderStat
          title="Pacing vs Plan"
          value={
            <span className={pacingPct < -5 ? "text-amber-600" : pacingPct > 5 ? "text-emerald-700" : ""}>
              {pacingPct >= 0 ? "+" : ""}
              {Number.isFinite(pacingPct) ? pacingPct.toFixed(1) : "—"}%
            </span>
          }
        />
        <HeaderStat
          title="Perf (bps)"
          value={<span className={perf > 0 ? "text-green-600" : perf < 0 ? "text-red-600" : ""}>{Number.isFinite(perf) ? perf.toFixed(1) : "—"}</span>}
        />
      </div>

      {/* Alerts + Market presets */}
      <div className="px-4 pb-2 flex flex-wrap items-center gap-2">
        {alerts.length === 0 ? (
          <span className="text-xs px-2.5 py-1 rounded-full bg-slate-100">All checks OK</span>
        ) : (
          alerts.map((a, i) => (
            <span key={i} className={`text-xs px-2.5 py-1 rounded-full border ${t.border} ${t.bgSoft} ${t.text}`}>{a}</span>
          ))
        )}
        <span className="ml-auto text-xs opacity-60">Market:</span>
        {(["Egypt", "Kuwait", "Qatar", "DFM", "ADX", "Saudi"] as MarketKey[]).map((m) => (
          <button
            key={m}
            onClick={() => applyMarketPreset(m, !!order.startFromNow)}
            className={`px-2.5 py-1 rounded-full border text-xs ${order.market === m ? "bg-slate-900 text-white" : "bg-white"}`}
          >
            {m}
          </button>
        ))}
        <label className="flex items-center gap-2 text-xs ml-2">
          <input
            type="checkbox"
            checked={!!order.startFromNow}
            onChange={(e) => applyMarketPreset(order.market || "Qatar", e.target.checked)}
          />
          Start from now
        </label>
      </div>

      {/* Inputs */}
      <div className="px-4 pb-4 grid md:grid-cols-3 gap-4">
        {/* Order */}
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
          <IntInput label="Order Qty (shares)" value={order.orderQty} onChange={(n) => onChange({ ...order, orderQty: n })} />
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
            Cap
            <select
              className="mt-1 w-full border rounded-xl p-2"
              value={order.capMode}
              onChange={(e) => onChange({ ...order, capMode: e.target.value as CapMode })}
            >
              <option value="PCT">Max % of Volume</option>
              <option value="NONE">No Volume Cap</option>
            </select>
          </label>
          {order.capMode === "PCT" && (
            <label className="text-sm">
              Max Participation %
              <input
                type="number"
                className="mt-1 w-full border rounded-xl p-2"
                value={order.maxPart}
                onChange={(e) => onChange({ ...order, maxPart: Math.max(0, parseFloat(e.target.value || "0")) })}
              />
            </label>
          )}
          <label className="text-sm">
            Reserve for Auction %
            <input
              type="number"
              className="mt-1 w-full border rounded-xl p-2"
              value={order.reserveAuctionPct}
              onChange={(e) => onChange({ ...order, reserveAuctionPct: Math.max(0, parseFloat(e.target.value || "0")) })}
            />
          </label>
          <label className="text-sm flex items-center gap-2">
            <input
              type="checkbox"
              checked={order.deferCompletion}
              onChange={(e) => onChange({ ...order, deferCompletion: e.target.checked })}
            />
            Do not complete before end
          </label>

          {/* Advanced options */}
          <details className="mt-2">
            <summary className="cursor-pointer text-sm font-semibold">Advanced Options</summary>
            <div className="grid grid-cols-2 gap-3 mt-2">
              <label className="text-sm">
                Min Clip
                <input
                  type="number"
                  className="mt-1 w-full border rounded-xl p-2"
                  value={order.minClip ?? 0}
                  onChange={(e) => onChange({ ...order, minClip: Math.max(0, parseInt(e.target.value || "0")) })}
                />
              </label>
              <label className="text-sm">
                Impact Guard %
                <input
                  type="number"
                  className="mt-1 w-full border rounded-xl p-2"
                  value={order.impactGuardPct ?? 25}
                  onChange={(e) => onChange({ ...order, impactGuardPct: Math.max(1, parseInt(e.target.value || "25")) })}
                />
              </label>
              <label className="text-sm">
                Market Pace
                <select
                  className="mt-1 w-full border rounded-xl p-2"
                  value={order.paceMode || "Normal"}
                  onChange={(e) => onChange({ ...order, paceMode: e.target.value as any })}
                >
                  <option value="Slow">Slow</option>
                  <option value="Normal">Normal</option>
                  <option value="Fast">Fast</option>
                </select>
              </label>
            </div>
          </details>
        </div>

        {/* Timing */}
        <div className="space-y-3">
          <h3 className="font-semibold">Timing (Local)</h3>
          <div className="grid grid-cols-2 gap-3">
            <label className="text-sm">
              Session Start
              <input
                type="time"
                className="mt-1 w-full border rounded-xl p-2"
                value={order.sessionStart}
                onChange={(e) => onChange({ ...order, sessionStart: e.target.value })}
              />
            </label>
            <label className="text-sm">
              Session End
              <input
                type="time"
                className="mt-1 w-full border rounded-xl p-2"
                value={order.sessionEnd}
                onChange={(e) => onChange({ ...order, sessionEnd: e.target.value })}
              />
            </label>
            <label className="text-sm">
              Auction Start
              <input
                type="time"
                className="mt-1 w-full border rounded-xl p-2"
                value={order.auctionStart}
                onChange={(e) => onChange({ ...order, auctionStart: e.target.value })}
              />
            </label>
            <label className="text-sm">
              Auction End
              <input
                type="time"
                className="mt-1 w-full border rounded-xl p-2"
                value={order.auctionEnd}
                onChange={(e) => onChange({ ...order, auctionEnd: e.target.value })}
              />
            </label>
            <label className="text-sm">
              TAL Start
              <input
                type="time"
                className="mt-1 w-full border rounded-xl p-2"
                value={order.talStart}
                onChange={(e) => onChange({ ...order, talStart: e.target.value })}
              />
            </label>
            <label className="text-sm">
              TAL End
              <input
                type="time"
                className="mt-1 w-full border rounded-xl p-2"
                value={order.talEnd}
                onChange={(e) => onChange({ ...order, talEnd: e.target.value })}
              />
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
            <label className="text-sm">
              Curve
              <select
                className="mt-1 w-full border rounded-xl p-2"
                value={order.curve}
                onChange={(e) => onChange({ ...order, curve: e.target.value as Curve })}
              >
                <option value="ucurve">U-curve</option>
                <option value="equal">Equal</option>
              </select>
            </label>
          </div>
        </div>

        {/* Volumes + VWAP */}
        <div className="space-y-3">
          <h3 className="font-semibold">Volumes & VWAP</h3>
          <div className="grid grid-cols-2 gap-3">
            <IntInput label="Start Vol (can be 0)" value={order.startVol} onChange={(n) => onChange({ ...order, startVol: n })} />
            <IntInput label="Current Vol (cum)" value={order.currentVol} onChange={(n) => onChange({ ...order, currentVol: n })} />
            <IntInput className="col-span-2" label="Expected Continuous Vol" value={order.expectedContVol} onChange={(n) => onChange({ ...order, expectedContVol: n })} />
            <IntInput className="col-span-2" label="Expected Auction Vol" value={order.expectedAuctionVol} onChange={(n) => onChange({ ...order, expectedAuctionVol: n })} />
          </div>
          <MoneyInput label="Market Turnover" value={order.marketTurnover} onNumberChange={(n) => onChange({ ...order, marketTurnover: n })} />
          <MoneyInput label="OR Enter Market VWAP" value={order.marketVWAPInput} onNumberChange={(n) => onChange({ ...order, marketVWAPInput: n })} />
          <IntInput label="Your Executed Qty" value={order.orderExecQty} onChange={(n) => onChange({ ...order, orderExecQty: n })} />
          <MoneyInput label="Your Executed Notional" value={order.orderExecNotional} onNumberChange={(n) => onChange({ ...order, orderExecNotional: n })} />
          <VWAPBox order={order} />
        </div>
      </div>

      {/* What-If Simulator */}
      <div className="px-4 pb-4">
        <WhatIfSimulator order={order} onChange={onChange} />
      </div>

      {/* Plan table */}
      <div className="px-4 pb-4">
        <div className="text-sm opacity-70 mb-2">Plan</div>
        <div className="overflow-x-auto rounded-xl border">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-white">
              <tr className="text-left border-b">
                <th className="py-2 pr-2">Interval</th>
                <th className="py-2 pr-2">Expected Mkt Vol</th>
                <th className="py-2 pr-2">Max Allowed</th>
                <th className="py-2 pr-2">Suggested Qty</th>
                <th className="py-2 pr-2">Flag</th>
              </tr>
            </thead>
            <tbody>
              {plan.rows.map((r) => {
                const cur = new Date().toTimeString().slice(0, 5) + ":00";
                const isLive = cur >= r.s && cur < r.e;
                return (
                  <tr key={r.interval} className={`border-b last:border-0 ${isLive ? `${t.bgSoft} animate-pulse` : ""}`}>
                    <td className={`py-2 pr-2 ${t.text}`}>{r.interval}</td>
                    <td className="py-2 pr-2">{formatInt(r.expMktVol)}</td>
                    <td className="py-2 pr-2">{typeof r.maxAllowed === "number" ? formatInt(r.maxAllowed) : r.maxAllowed}</td>
                    <td className="py-2 pr-2 font-semibold">{formatInt(r.suggestedQty)}</td>
                    <td className="py-2 pr-2">{r.impactFlag ? "⚠︎ impact" : ""}</td>
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
                <td className="py-2 pr-2"></td>
              </tr>
            </tbody>
            <tfoot>
              <tr className="border-t">
                <td className="py-2 pr-2 font-semibold">Totals</td>
                <td className="py-2 pr-2">
                  {formatInt(order.startVol + order.currentVol + order.expectedContVol + order.expectedAuctionVol)}
                </td>
                <td className="py-2 pr-2">—</td>
                <td className="py-2 pr-2 font-semibold">
                  {formatInt(totalPlanned)} (Remain {formatInt(remaining)})
                </td>
                <td className="py-2 pr-2"></td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>
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
      const marketVWAP = impliedMarketVWAP(o.marketTurnover, o.currentVol, o.marketVWAPInput);
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
  const progress = ag.qtyTotal > 0 ? Math.min(100, Math.round((ag.plannedTotal / ag.qtyTotal) * 100)) : 0;
  const orderVWAP = ag.execQty > 0 ? ag.execNotional / ag.execQty : 0;
  const marketVWAP = ag.marketVolTotal > 0 ? ag.marketTurnoverApprox / ag.marketVolTotal : 0;
  const perf = side ? performanceBps(side, orderVWAP, marketVWAP) : orderVWAP && marketVWAP ? ((orderVWAP - marketVWAP) / marketVWAP) * 10000 : 0;

  const color = perf > 0 ? "text-green-600" : perf < 0 ? "text-red-600" : "";
  const bg = tint === "emerald" ? "bg-emerald-50" : tint === "rose" ? "bg-rose-50" : "bg-slate-100";
  const bar = tint === "emerald" ? "bg-emerald-600" : tint === "rose" ? "bg-rose-600" : "bg-slate-600";

  return (
    <div className={`rounded-2xl p-4 ${bg} border`}>
      <div className="flex items-center justify-between">
        <div className="font-semibold">{title}</div>
        <div className="text-xs opacity-60">Planned {progress}%</div>
      </div>
      <div className="grid md:grid-cols-4 gap-3 text-sm mt-2">
        <HeaderStat title="Total Qty" value={formatInt(ag.qtyTotal)} />
        <HeaderStat title="Planned" value={formatInt(ag.plannedTotal)} />
        <HeaderStat title="Executed" value={formatInt(ag.execQty)} />
        <HeaderStat title="Remaining" value={formatInt(Math.max(0, ag.qtyTotal - ag.plannedTotal))} />
      </div>
      <div className="w-full h-2 rounded-full bg-white/60 overflow-hidden mt-2">
        <div className={`h-2 ${bar}`} style={{ width: `${progress}%` }} />
      </div>
      <div className="text-xs mt-2">
        Performance: <span className={color}>{Number.isFinite(perf) ? perf.toFixed(1) : "—"} bps</span>
      </div>
    </div>
  );
}

export default function App() {
  const [orders, setOrders] = useState<Order[]>([defaultOrder("BUY", 1), defaultOrder("SELL", 1)]);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const visible = selectedId ? orders.filter((o) => o.id === selectedId) : orders;
  const chips = [{ id: null as string | null, label: "ALL" }].concat(
    orders.map((o) => ({ id: o.id, label: o.name, side: o.side } as any))
  );

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

  // Dashboard aggregates (respect filter)
  const agAll = useMemo(() => aggregateOrders(visible), [visible]);
  const agBuy = useMemo(() => aggregateOrders(visible.filter((o) => o.side === "BUY")), [visible]);
  const agSell = useMemo(() => aggregateOrders(visible.filter((o) => o.side === "SELL")), [visible]);

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      {/* Sticky Dashboard */}
      <div className="sticky top-0 z-20 backdrop-blur bg-slate-50/80 border-b">
        <div className="max-w-7xl mx-auto p-4 grid gap-4">
          <div className="flex items-center justify-between">
            <h1 className="text-xl font-bold">Execution Planner</h1>
            <div className="flex gap-2">
              <button onClick={() => addOrder("BUY")} className="px-3 py-2 rounded-xl bg-emerald-600 text-white text-sm">+ Add BUY</button>
              <button onClick={() => addOrder("SELL")} className="px-3 py-2 rounded-xl bg-rose-600 text-white text-sm">+ Add SELL</button>
            </div>
          </div>

          {/* Summary */}
          <div className="grid md:grid-cols-3 gap-3">
            <SummaryCard title="ALL Orders" tint="slate" ag={agAll} />
            <SummaryCard title="BUY" tint="emerald" ag={agBuy} side="BUY" />
            <SummaryCard title="SELL" tint="rose" ag={agSell} side="SELL" />
          </div>

          {/* Chips Filter */}
          <div className="flex flex-wrap gap-2">
            {chips.map((c: any) => {
              const active = selectedId === c.id;
              const isBuy = c.side === "BUY";
              const isSell = c.side === "SELL";
              const color = active
                ? "bg-slate-900 text-white"
                : isBuy
                ? "bg-emerald-50 text-emerald-700"
                : isSell
                ? "bg-rose-50 text-rose-700"
                : "bg-white text-slate-700";
              const border = isBuy ? "border-emerald-200" : isSell ? "border-rose-200" : "border-slate-200";
              return (
                <button
                  key={String(c.id ?? "ALL")}
                  onClick={() => setSelectedId(c.id)}
                  className={`px-3 py-1.5 rounded-full text-xs border ${color} ${border}`}
                >
                  {c.label}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {/* Orders */}
      <div className="max-w-7xl mx-auto p-4 grid gap-5">
        {visible.map((o) => (
          <PlannerCard
            key={o.id}
            order={o}
            onChange={(n) => updateOrder(o.id, n)}
            onRemove={() => removeOrder(o.id)}
            onDuplicate={() => duplicateOrder(o.id)}
          />
        ))}
        {visible.length === 0 && <div className="text-sm text-slate-500">No orders selected.</div>}
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