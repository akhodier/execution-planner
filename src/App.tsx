import React, { useEffect, useRef, useState } from "react";

/**
 * OTD / INLINE Multi-Order Execution Planner (No-Login)
 * - Sticky summary (ALL / BUY / SELL)
 * - Order-name chips to filter one or ALL
 * - BUY (green) / SELL (red) color themes
 * - VWAP inputs accept decimals while typing; format on blur
 * - Auto-recalculation on ANY input change
 * - Time-sliced OTD & INLINE with caps, auction handling
 * - Live-slice highlight, reminders, CSV export
 * - Execution Coach (participation tracking, cap heat, urgency, tips)
 */

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
  const weights: number[] = [];
  const mid = (n - 1) / 2;
  for (let i = 0; i < n; i++) {
    const x = Math.abs(i - mid) / (mid || 1);
    const w = 0.6 + 0.8 * (1 - x); // heavier center
    weights.push(w);
  }
  const sum = weights.reduce((a, b) => a + b, 0) || 1;
  return weights.map((w) => w / sum);
}

function equalWeights(n: number) {
  if (n <= 0) return [] as number[];
  return Array(n).fill(1 / n);
}

function toCSV(rows: any[]) {
  if (!rows.length) return "";
  const headers = Object.keys(rows[0]);
  const esc = (v: any) => {
    const s = String(v ?? "");
    if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  };
  const lines = [headers.join(",")].concat(
    rows.map((r) => headers.map((h) => esc(r[h])).join(","))
  );
  return lines.join("\n");
}

/* -------------------- Number & Money Inputs -------------------- */
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
  if (parts.length > 2) {
    const join = parts[0] + "." + parts.slice(1).join("");
    return join;
  }
  return cleaned;
}
function toNumberOrZero(v: string) {
  const n = parseFloat(v);
  return isNaN(n) ? 0 : n;
}

function useInterval(callback: () => void, delay: number | null) {
  const savedRef = useRef<() => void>();
  useEffect(() => {
    savedRef.current = callback;
  }, [callback]);
  useEffect(() => {
    if (delay === null) return;
    const id = setInterval(() => savedRef.current && savedRef.current(), delay);
    return () => clearInterval(id);
  }, [delay]);
}

/* -------------------- Types -------------------- */
export type ExecMode = "OTD" | "INLINE";
export type CapMode = "NONE" | "PCT";
export type Curve = "equal" | "ucurve";
export type Side = "BUY" | "SELL";

export type Order = {
  id: string;
  name: string;
  symbol: string;
  side: Side;
  orderQty: number;
  execMode: ExecMode;
  capMode: CapMode;
  maxPart: number;
  reserveAuctionPct: number;
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

  // VWAP monitoring
  marketTurnover: number; // currency
  marketVWAPInput: number; // manual VWAP if turnover unavailable
  orderExecQty: number;
  orderExecNotional: number;

  remindersOn: boolean;
  remindEveryMins: number;
};

function defaultOrder(side: Side = "BUY", idx = 1): Order {
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

    remindersOn: false,
    remindEveryMins: 15,
  };
}

/* -------------------- Planning Logic -------------------- */
type BuiltPlan = {
  rows: any[];
  contPlanned: number;
  auctionAllowed: number;
  auctionPlanned: number;
  talNote: string;
  // analytics
  capBindingPct: number;     // % slices where suggested hits cap
  impliedPartRate: number;   // planned vs expected total
  targetPartRate: number;    // desired participation for INLINE; implied for OTD
};

function buildPlan(order: Order): BuiltPlan {
  const slices = timeSlices(order.sessionStart, order.sessionEnd, order.intervalMins);
  const weights =
    order.curve === "equal" ? equalWeights(slices.length) : uCurveWeights(slices.length);

  const contVolPerSlice = weights.map((w) => Math.floor(w * order.expectedContVol));
  const reserveAuctionQty = Math.floor((order.orderQty * order.reserveAuctionPct) / 100);

  const applyCap = (qty: number, sliceVol: number) => {
    if (order.capMode === "NONE") return Math.max(0, Math.floor(qty));
    const allowed = Math.floor((sliceVol * order.maxPart) / 100);
    return Math.max(0, Math.min(Math.floor(qty), allowed));
  };

  let rows: any[] = [];
  let auctionAllowed =
    order.capMode === "PCT"
      ? Math.floor((order.expectedAuctionVol * order.maxPart) / 100)
      : order.expectedAuctionVol;

  let capBindings = 0;

  if (order.execMode === "OTD") {
    const targetContinuousQty = Math.max(0, order.orderQty - reserveAuctionQty);
    let remainingForContinuous = targetContinuousQty;

    rows = slices.map((slice, i) => {
      const sliceVol = Math.max(0, contVolPerSlice[i]);
      const base = Math.floor(weights[i] * targetContinuousQty);
      let suggested = Math.min(base, remainingForContinuous);
      const preCap = suggested;
      suggested = applyCap(suggested, sliceVol);

      if (order.capMode === "PCT" && suggested === Math.floor((sliceVol * order.maxPart) / 100)) {
        if (preCap > suggested) capBindings++;
      }

      const isLastSlice = i === slices.length - 1;
      if (order.deferCompletion && !isLastSlice) {
        const minRemainder = Math.ceil(targetContinuousQty * 0.05);
        if (remainingForContinuous - suggested <= 0) {
          suggested = Math.max(0, remainingForContinuous - Math.max(0, minRemainder));
        }
      }

      suggested = Math.min(suggested, remainingForContinuous);
      remainingForContinuous -= suggested;

      return {
        interval: slice.label,
        s: slice.s,
        e: slice.e,
        expMktVol: sliceVol,
        maxAllowed:
          order.capMode === "PCT" ? Math.floor((sliceVol * order.maxPart) / 100) : "∞",
        suggestedQty: suggested,
        notes: order.capMode === "PCT" ? "Respects cap" : "No cap",
      };
    });

    const contPlanned = rows.reduce((a, r) => a + r.suggestedQty, 0);
    const auctionPlanned = Math.min(
      reserveAuctionQty + Math.max(0, targetContinuousQty - contPlanned),
      auctionAllowed
    );
    const talNote =
      auctionPlanned < reserveAuctionQty ? "Auction thin; carry to TAL" : "";

    // implied participation vs expected total volume
    const expectedTotal = order.currentVol + order.expectedContVol + order.expectedAuctionVol;
    const impliedPartRate = expectedTotal > 0 ? (contPlanned + auctionPlanned) / expectedTotal : 0;
    const targetPartRate = impliedPartRate; // OTD implied

    return {
      rows,
      contPlanned,
      auctionAllowed,
      auctionPlanned,
      talNote,
      capBindingPct: slices.length ? (capBindings / slices.length) * 100 : 0,
      impliedPartRate,
      targetPartRate,
    };
  }

  // INLINE mode
  const expectedTotalVol = order.currentVol + order.expectedContVol + order.expectedAuctionVol;
  const targetPartRate =
    expectedTotalVol > 0 ? Math.min(1, order.orderQty / expectedTotalVol) : 0;

  rows = slices.map((slice, i) => {
    const sliceVol = Math.max(0, contVolPerSlice[i]);
    const base = Math.floor(sliceVol * targetPartRate);
    const preCap = base;
    const suggested = applyCap(base, sliceVol);
    if (order.capMode === "PCT" && suggested === Math.floor((sliceVol * order.maxPart) / 100)) {
      if (preCap > suggested) capBindings++;
    }
    return {
      interval: slice.label,
      s: slice.s,
      e: slice.e,
      expMktVol: sliceVol,
      maxAllowed:
        order.capMode === "PCT" ? Math.floor((sliceVol * order.maxPart) / 100) : "∞",
      suggestedQty: suggested,
      notes: order.capMode === "PCT" ? "Inline + cap" : "Inline (no cap)",
    };
  });

  const contPlanned = rows.reduce((a, r) => a + r.suggestedQty, 0);
  let auctionPlanned =
    order.capMode === "PCT"
      ? Math.floor((order.expectedAuctionVol * targetPartRate * order.maxPart) / 100)
      : Math.floor(order.expectedAuctionVol * targetPartRate);

  let totalPlanned = contPlanned + auctionPlanned;
  if (totalPlanned > order.orderQty) {
    const excess = totalPlanned - order.orderQty;
    if (order.deferCompletion) {
      for (let i = rows.length - 1; i >= 0 && excess > 0; i--) {
        const trim = Math.min(excess, rows[i].suggestedQty);
        rows[i].suggestedQty -= trim;
      }
    } else {
      auctionPlanned = Math.max(0, auctionPlanned - excess);
    }
  }

  const talNote = order.deferCompletion
    ? "Completion deferred to auction if possible"
    : "";

  const impliedPartRate =
    expectedTotalVol > 0 ? (contPlanned + auctionPlanned) / expectedTotalVol : 0;

  return {
    rows,
    contPlanned,
    auctionAllowed,
    auctionPlanned,
    talNote,
    capBindingPct: slices.length ? (capBindings / slices.length) * 100 : 0,
    impliedPartRate,
    targetPartRate,
  };
}

/* -------------------- Small Helpers -------------------- */
function nowHHMMSS() {
  const d = new Date();
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}
function withinSlice(current: string, s: string, e: string) {
  const toMin = (t: string) => {
    const parts = t.split(":");
    const hh = parseInt(parts[0] || "0", 10);
    const mm = parseInt(parts[1] || "0", 10);
    return hh * 60 + mm;
  };
  const cur = toMin(current);
  const cs = toMin(s);
  const ce = toMin(e);
  return cur >= cs && cur < ce;
}

function HeaderStat({
  title,
  value,
}: {
  title: string;
  value: React.ReactNode;
}) {
  return (
    <div className="p-3 rounded-xl bg-slate-100">
      <div className="opacity-60 text-xs">{title}</div>
      <div className="font-semibold">{value}</div>
    </div>
  );
}

// Integer input (formatted with commas)
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

// Decimal-friendly money input (formats on blur)
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
  useEffect(() => {
    setDraft(value === 0 ? "" : String(value));
  }, [value]);

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

// Direction-aware VWAP performance (BUY positive when order < market; SELL opposite)
function performanceBps(side: Side, orderVWAP: number, marketVWAP: number) {
  if (!marketVWAP || !orderVWAP) return 0;
  return side === "BUY"
    ? ((marketVWAP - orderVWAP) / marketVWAP) * 10000
    : ((orderVWAP - marketVWAP) / marketVWAP) * 10000;
}

/* -------------------- Coach logic (diagnostics → tips) -------------------- */
function coachTips(order: Order, plan: BuiltPlan) {
  const tips: string[] = [];

  // Liquidity regime
  const totalExpVol = order.currentVol + order.expectedContVol + order.expectedAuctionVol;
  const volRatio = totalExpVol > 0 ? order.orderQty / totalExpVol : 0;
  const liquidity =
    volRatio >= 0.35 ? "Heavy"
    : volRatio >= 0.15 ? "Normal"
    : "Thin";

  // Participation tracking
  const behind = plan.impliedPartRate < plan.targetPartRate * 0.9;
  const ahead  = plan.impliedPartRate > plan.targetPartRate * 1.1;

  // Cap binding heat
  if (order.capMode === "PCT") {
    if (plan.capBindingPct >= 40) {
      tips.push(`Cap binding on ${plan.capBindingPct.toFixed(0)}% of slices → consider raising cap to ${Math.min(50, order.maxPart + 5)}% for next 2 slices.`);
    } else if (plan.capBindingPct >= 15) {
      tips.push(`Cap binding noticeable (${plan.capBindingPct.toFixed(0)}%) → micro-raise cap by +2–3% where liquidity allows.`);
    }
  }

  // Urgency index
  const minsLeft = Math.max(1, minutesBetween(order.sessionStart, order.sessionEnd));
  const now = new Date();
  const nowHHMM = now.toTimeString().slice(0,5);
  const elapsed = Math.max(0, minutesBetween(order.sessionStart, nowHHMM));
  const timeFrac = Math.min(1, Math.max(0, elapsed / minsLeft));
  const remainingFrac = 1 - (plan.contPlanned + plan.auctionPlanned) / Math.max(1, order.orderQty);
  const urgency = 0.5*remainingFrac + 0.3*(plan.capBindingPct/100) + 0.2*(timeFrac);
  if (urgency > 0.7) tips.push(`High urgency → tighten to faster curve (front-load) and consider +${Math.min(5, 25 - order.reserveAuctionPct)}% auction reserve.`);
  else if (urgency > 0.45) tips.push(`Moderate urgency → keep curve, monitor cap hits; pre-commit part to auction if spreads widen.`);

  // Auction/TAL optimization
  if (order.expectedAuctionVol > 0) {
    const canDoAuction = plan.auctionAllowed;
    if (canDoAuction < Math.floor((order.orderQty * order.reserveAuctionPct) / 100)) {
      tips.push(`Auction capacity looks tight (allowed ${formatInt(canDoAuction)}). Consider shifting part of reserve to last two continuous slices or TAL.`);
    } else {
      tips.push(`Auction healthy. Ensure ≥ ${order.reserveAuctionPct}% held for auction; use TAL as safety valve if close imbalance spikes.`);
    }
  }

  // VWAP guardrails
  const marketVWAP =
    order.currentVol > 0
      ? (order.marketTurnover > 0 ? order.marketTurnover / order.currentVol : (order.marketVWAPInput || 0))
      : (order.marketVWAPInput || 0);
  const orderVWAP = order.orderExecQty > 0 ? order.orderExecNotional / order.orderExecQty : 0;
  const perf = performanceBps(order.side, orderVWAP, marketVWAP);
  if (Math.abs(perf) >= 25) {
    if (order.side === "BUY") {
      if (perf < 0) tips.push(`Underperforming VWAP by ${Math.abs(perf).toFixed(0)} bps → pause on spikes and favor passive in next slice.`);
      else tips.push(`Beating VWAP by ${perf.toFixed(0)} bps → can relax slightly or keep steady if liquidity thins.`);
    } else {
      if (perf < 0) tips.push(`Underperforming VWAP by ${Math.abs(perf).toFixed(0)} bps → avoid chasing; favor auction participation if spread widens.`);
      else tips.push(`Beating VWAP by ${perf.toFixed(0)} bps → consider clipping more in liquid moments.`);
    }
  }

  // Participation discipline (INLINE)
  if (order.execMode === "INLINE") {
    if (behind) tips.push(`Behind target participation (${(plan.impliedPartRate*100).toFixed(1)}% vs ${(plan.targetPartRate*100).toFixed(1)}%) → increase next two slices by +10–15%.`);
    if (ahead)  tips.push(`Ahead of target participation → ease for one slice unless liquidity is exceptional.`);
  }

  // Liquidity note
  tips.push(`Liquidity regime: ${liquidity}.`);

  return tips;
}

/* -------------------- VWAP widget -------------------- */
function VWAPBox({ order }: { order: Order }) {
  const marketVWAP =
    order.currentVol > 0
      ? order.marketTurnover > 0
        ? order.marketTurnover / order.currentVol
        : order.marketVWAPInput || 0
      : order.marketVWAPInput || 0;

  const orderVWAP =
    order.orderExecQty > 0 ? order.orderExecNotional / order.orderExecQty : 0;

  const perf = performanceBps(order.side, orderVWAP, marketVWAP);
  const tag = Number.isFinite(perf) ? `${perf.toFixed(1)} bps` : "—";
  const color = perf > 0 ? "text-green-600" : perf < 0 ? "text-red-600" : "";

  return (
    <div className="grid md:grid-cols-4 gap-3 text-sm mt-2">
      <HeaderStat
        title="Market VWAP"
        value={marketVWAP ? formatMoney(marketVWAP, 4) : "—"}
      />
      <HeaderStat
        title="Order VWAP"
        value={orderVWAP ? formatMoney(orderVWAP, 4) : "—"}
      />
      <HeaderStat
        title="Performance (bps)"
        value={<span className={color}>{tag}</span>}
      />
      <HeaderStat title="Executed Qty" value={formatInt(order.orderExecQty)} />
    </div>
  );
}

/* -------------------- Themed Planner Card -------------------- */
function sideTheme(side: Side) {
  return side === "BUY"
    ? {
        text: "text-emerald-700",
        bgSoft: "bg-emerald-50",
        border: "border-emerald-300",
        strong: "bg-emerald-600",
      }
    : {
        text: "text-rose-700",
        bgSoft: "bg-rose-50",
        border: "border-rose-300",
        strong: "bg-rose-600",
      };
}

function ColorPlannerCard({
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
  const theme = sideTheme(order.side);
  const [clock, setClock] = useState(nowHHMMSS());
  useInterval(() => setClock(nowHHMMSS()), 1000);

  // Recompute plan every render so ANY change refreshes outputs
  const plan = buildPlan(order);
  const totalPlanned = plan.contPlanned + plan.auctionPlanned;
  const remaining = Math.max(0, order.orderQty - totalPlanned);
  const progress =
    order.orderQty > 0
      ? Math.min(100, Math.round((totalPlanned / order.orderQty) * 100))
      : 0;

  const liveIndex = plan.rows.findIndex((r: any) =>
    withinSlice(new Date().toTimeString().slice(0, 5) + ":00", r.s, r.e)
  );
  const liveRef = useRef<HTMLTableRowElement | null>(null);

  const [showLiveOnly, setShowLiveOnly] = useState(false);
  const visibleRows =
    !showLiveOnly || liveIndex < 0
      ? plan.rows
      : plan.rows.filter((_: any, i: number) => i >= liveIndex && i <= liveIndex + 2);

  // Reminders
  const [toast, setToast] = useState<string | null>(null);
  useInterval(
    () => {
      if (!order.remindersOn) return;
      setToast("Time to update current volume / executed qty & expectations");
      setTimeout(() => setToast(null), 3500);
    },
    order.remindEveryMins > 0 && order.remindersOn
      ? order.remindEveryMins * 60 * 1000
      : null
  );

  // CSV
  const csvData = (() => {
    const base = plan.rows.map((r: any) => ({
      Interval: r.interval,
      "Expected Market Vol": r.expMktVol,
      "Max Allowed": r.maxAllowed,
      "Suggested Qty": r.suggestedQty,
      Notes: r.notes,
    }));
    base.push({
      Interval: "Auction",
      "Expected Market Vol": order.expectedAuctionVol,
      "Max Allowed": plan.auctionAllowed,
      "Suggested Qty": plan.auctionPlanned,
      Notes: plan.talNote || "",
    });
    base.push({
      Interval: "Totals",
      "Expected Market Vol":
        order.startVol +
        order.currentVol +
        order.expectedContVol +
        order.expectedAuctionVol,
      "Max Allowed": "—",
      "Suggested Qty": totalPlanned,
      Notes: `Remaining unfilled: ${formatInt(remaining)}`,
    });
    return toCSV(base);
  })();

  function downloadCSV() {
    const blob = new Blob([csvData], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${order.symbol}_${order.side}_${order.execMode}_plan.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // Execution Coach
  const tips = coachTips(order, plan);

  return (
    <div className={`rounded-2xl shadow border ${theme.border} bg-white overflow-hidden`}>
      <div className={`px-4 py-3 border-b ${theme.border} flex items-center justify-between`}>
        <div className="flex items-center gap-3">
          <span className={`inline-flex items-center px-2.5 py-1 rounded-full text-xs font-semibold ${theme.bgSoft} ${theme.text}`}>
            {order.side}
          </span>
          <div className="text-sm opacity-70">
            Local time (CLT): <span className="font-mono">{clock}</span>
          </div>
        </div>
        <div className="flex gap-2">
          <button onClick={downloadCSV} className="px-3 py-2 rounded-xl bg-slate-900 text-white text-sm">
            Export CSV
          </button>
          <button onClick={onDuplicate} className="px-3 py-2 rounded-xl border text-sm">
            Duplicate
          </button>
          <button onClick={onRemove} className="px-3 py-2 rounded-xl border text-sm">
            Remove
          </button>
        </div>
      </div>

      <div className="p-4 grid md:grid-cols-6 gap-3 items-end">
        <HeaderStat
          title="Name"
          value={
            <input
              className="border rounded-xl px-2 py-1 w-full"
              value={order.name}
              onChange={(e) => onChange({ ...order, name: e.target.value })}
            />
          }
        />
        <HeaderStat title="Symbol" value={<span className="font-mono">{order.symbol}</span>} />
        <HeaderStat title="Mode" value={order.execMode} />
        <HeaderStat title="Cap" value={order.capMode === "PCT" ? `${order.maxPart}%` : "No cap"} />
        <HeaderStat title="Order Qty" value={formatInt(order.orderQty)} />
        <div className="flex flex-col gap-1">
          <div className="text-xs opacity-60">Progress</div>
          <div className="w-full h-2 rounded-full bg-slate-200 overflow-hidden">
            <div className={`h-2 ${theme.strong}`} style={{ width: `${progress}%` }} />
          </div>
          <div className="text-xs opacity-60">
            {progress}% planned · Remaining {formatInt(remaining)}
          </div>
        </div>
      </div>

      {/* Diagnostics strip */}
      <div className="px-4 grid md:grid-cols-4 gap-3">
        <HeaderStat
          title="Cap Binding"
          value={`${plan.capBindingPct.toFixed(0)}% of slices`}
        />
        <HeaderStat
          title="Implied Participation"
          value={`${(plan.impliedPartRate * 100).toFixed(1)}%`}
        />
        <HeaderStat
          title="Target Participation"
          value={`${(plan.targetPartRate * 100).toFixed(1)}%`}
        />
        <HeaderStat
          title="Auction Planned"
          value={`${formatInt(plan.auctionPlanned)} / allowed ${formatInt(plan.auctionAllowed)}`}
        />
      </div>

      {/* Coach tips */}
      <div className="px-4 mt-2">
        <div className="text-xs opacity-60 mb-1">Execution Coach</div>
        <div className="flex flex-wrap gap-2">
          {tips.map((t, i) => (
            <span
              key={i}
              className={`text-xs px-2.5 py-1 rounded-full border ${theme.border} ${theme.bgSoft} ${theme.text}`}
            >
              {t}
            </span>
          ))}
          {tips.length === 0 && (
            <span className="text-xs px-2.5 py-1 rounded-full border bg-slate-50">
              No special actions suggested.
            </span>
          )}
        </div>
      </div>

      {/* Inputs & VWAP */}
      <div className="px-4 pb-4 grid md:grid-cols-3 gap-4 mt-3">
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
          <IntInput
            label="Order Qty (shares)"
            value={order.orderQty}
            onChange={(n) => onChange({ ...order, orderQty: n })}
          />

          <label className="text-sm">
            Execution Mode
            <select
              className="mt-1 w-full border rounded-xl p-2"
              value={order.execMode}
              onChange={(e) => onChange({ ...order, execMode: e.target.value as ExecMode })}
            >
              <option value="OTD">OTD (time-sliced)</option>
              <option value="INLINE">Inline with Volume</option>
            </select>
          </label>

          <label className="text-sm">
            Cap Mode
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
                onChange={(e) =>
                  onChange({
                    ...order,
                    maxPart: Math.max(0, parseFloat(e.target.value || "0")),
                  })
                }
              />
            </label>
          )}

          <label className="text-sm">
            Reserve for Auction %
            <input
              type="number"
              className="mt-1 w-full border rounded-xl p-2"
              value={order.reserveAuctionPct}
              onChange={(e) =>
                onChange({
                  ...order,
                  reserveAuctionPct: Math.max(0, parseFloat(e.target.value || "0")),
                })
              }
            />
          </label>

          <label className="text-sm flex items-center gap-2 mt-2">
            <input
              type="checkbox"
              checked={order.deferCompletion}
              onChange={(e) => onChange({ ...order, deferCompletion: e.target.checked })}
            />
            <span>Do not complete before end / keep for auction</span>
          </label>

          <div className="grid grid-cols-2 gap-3 mt-2">
            <label className="text-sm">
              Reminders
              <select
                className="mt-1 w-full border rounded-xl p-2"
                value={order.remindersOn ? "on" : "off"}
                onChange={(e) => onChange({ ...order, remindersOn: e.target.value === "on" })}
              >
                <option value="off">Off</option>
                <option value="on">On</option>
              </select>
            </label>
            <label className="text-sm">
              Every (mins)
              <input
                type="number"
                className="mt-1 w-full border rounded-xl p-2"
                value={order.remindEveryMins}
                onChange={(e) =>
                  onChange({
                    ...order,
                    remindEveryMins: Math.max(1, parseInt(e.target.value || "1")),
                  })
                }
              />
            </label>
          </div>
        </div>

        <div className="space-y-3">
          <h3 className="font-semibold">Timing (CLT)</h3>
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
                onChange={(e) =>
                  onChange({
                    ...order,
                    intervalMins: Math.max(1, parseInt(e.target.value || "1")),
                  })
                }
              />
            </label>
            <label className="text-sm">
              Curve
              <select
                className="mt-1 w-full border rounded-xl p-2"
                value={order.curve}
                onChange={(e) => onChange({ ...order, curve: e.target.value as Curve })}
              >
                <option value="ucurve">U-curve (mid heavier)</option>
                <option value="equal">Equal</option>
              </select>
            </label>
          </div>

          <h3 className="font-semibold mt-4">Market Volume</h3>
          <div className="grid grid-cols-2 gap-3">
            <IntInput
              label="Start Volume (can be 0)"
              value={order.startVol}
              onChange={(n) => onChange({ ...order, startVol: n })}
            />
            <IntInput
              label="Current Volume (cum)"
              value={order.currentVol}
              onChange={(n) => onChange({ ...order, currentVol: n })}
            />
            <IntInput
              className="col-span-2"
              label="Expected Additional Volume (continuous)"
              value={order.expectedContVol}
              onChange={(n) => onChange({ ...order, expectedContVol: n })}
            />
            <IntInput
              className="col-span-2"
              label="Expected Auction Volume"
              value={order.expectedAuctionVol}
              onChange={(n) => onChange({ ...order, expectedAuctionVol: n })}
            />
          </div>
        </div>

        <div className="space-y-3">
          <h3 className="font-semibold">VWAP / Turnover Monitoring</h3>
          <MoneyInput
            label="Market Turnover (EGP)"
            value={order.marketTurnover}
            onNumberChange={(n) => onChange({ ...order, marketTurnover: n })}
          />
          <MoneyInput
            label="OR Enter Market VWAP manually"
            value={order.marketVWAPInput}
            onNumberChange={(n) => onChange({ ...order, marketVWAPInput: n })}
          />
          <IntInput
            label="Your Executed Qty (shares)"
            value={order.orderExecQty}
            onChange={(n) => onChange({ ...order, orderExecQty: n })}
          />
          <MoneyInput
            label="Your Executed Notional (EGP)"
            value={order.orderExecNotional}
            onNumberChange={(n) => onChange({ ...order, orderExecNotional: n })}
          />
          <VWAPBox order={order} />
        </div>
      </div>

      {/* Plan table */}
      <div className="px-4 pb-4">
        <div className="flex items-center justify-between mb-2">
          <div className="text-sm opacity-70">Plan</div>
          <div className="flex items-center gap-3">
            <label className="text-xs flex items-center gap-1">
              <input
                type="checkbox"
                checked={showLiveOnly}
                onChange={(e) => setShowLiveOnly(e.target.checked)}
              />
              Live slice only
            </label>
            {liveIndex >= 0 && (
              <button
                onClick={() =>
                  liveRef.current?.scrollIntoView({ behavior: "smooth", block: "center" })
                }
                className={`px-2.5 py-1.5 rounded-lg text-xs text-white ${theme.strong}`}
              >
                Jump to Live Slice
              </button>
            )}
          </div>
        </div>

        <div className="overflow-x-auto rounded-xl border">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-white">
              <tr className="text-left border-b">
                <th className="py-2 pr-2">Interval</th>
                <th className="py-2 pr-2">Expected Mkt Vol</th>
                <th className="py-2 pr-2">Max Allowed</th>
                <th className="py-2 pr-2">Suggested Qty</th>
                <th className="py-2 pr-2">Notes</th>
              </tr>
            </thead>
            <tbody>
              {visibleRows.map((r: any, idx: number) => {
                const i = showLiveOnly ? liveIndex + idx : idx;
                const isLive = i === liveIndex;
                return (
                  <tr
                    key={`${r.interval}-${idx}`}
                    ref={isLive ? liveRef : undefined}
                    className={`border-b last:border-0 ${isLive ? `${theme.bgSoft} animate-pulse` : ""}`}
                  >
                    <td className={`py-2 pr-2 ${theme.text}`}>{r.interval}</td>
                    <td className="py-2 pr-2">{formatInt(r.expMktVol)}</td>
                    <td className="py-2 pr-2">
                      {typeof r.maxAllowed === "number" ? formatInt(r.maxAllowed) : r.maxAllowed}
                    </td>
                    <td className="py-2 pr-2 font-semibold">{formatInt(r.suggestedQty)}</td>
                    <td className="py-2 pr-2">{r.notes}</td>
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
                <td className="py-2 pr-2">{plan.talNote}</td>
              </tr>
            </tbody>
            <tfoot>
              <tr className="border-t">
                <td className="py-2 pr-2 font-semibold">Totals</td>
                <td className="py-2 pr-2">
                  {formatInt(
                    order.startVol +
                      order.currentVol +
                      order.expectedContVol +
                      order.expectedAuctionVol
                  )}
                </td>
                <td className="py-2 pr-2">—</td>
                <td className="py-2 pr-2 font-semibold">{formatInt(totalPlanned)}</td>
                <td className="py-2 pr-2">Remaining unfilled: {formatInt(remaining)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>
    </div>
  );
}

/* -------------------- Top Summary & Chips Filter -------------------- */
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
      const plan = buildPlan(o);
      const planned = plan.contPlanned + plan.auctionPlanned;
      const marketVWAP =
        o.currentVol > 0
          ? o.marketTurnover > 0
            ? o.marketTurnover / o.currentVol
            : o.marketVWAPInput || 0
          : o.marketVWAPInput || 0;
      const turnoverApprox =
        o.marketTurnover > 0 ? o.marketTurnover : marketVWAP * o.currentVol;
      return {
        qtyTotal: agg.qtyTotal + o.orderQty,
        plannedTotal: agg.plannedTotal + planned,
        execQty: agg.execQty + o.orderExecQty,
        execNotional: agg.execNotional + o.orderExecNotional,
        marketTurnoverApprox: agg.marketTurnoverApprox + turnoverApprox,
        marketVolTotal: agg.marketVolTotal + o.currentVol,
      };
    },
    {
      qtyTotal: 0,
      plannedTotal: 0,
      execQty: 0,
      execNotional: 0,
      marketTurnoverApprox: 0,
      marketVolTotal: 0,
    }
  );
}

function SummaryBlock({
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
  const progress =
    ag.qtyTotal > 0
      ? Math.min(100, Math.round((ag.plannedTotal / ag.qtyTotal) * 100))
      : 0;
  const orderVWAP = ag.execQty > 0 ? ag.execNotional / ag.execQty : 0;
  const marketVWAP =
    ag.marketVolTotal > 0 ? ag.marketTurnoverApprox / ag.marketVolTotal : 0;

  let perf = 0;
  if (side) {
    perf = performanceBps(side, orderVWAP, marketVWAP);
  } else {
    // For ALL, show neutral diff Order - Market
    perf =
      orderVWAP && marketVWAP ? ((orderVWAP - marketVWAP) / marketVWAP) * 10000 : 0;
  }

  const color = perf > 0 ? "text-green-600" : perf < 0 ? "text-red-600" : "";

  const bg =
    tint === "emerald"
      ? "bg-emerald-50"
      : tint === "rose"
      ? "bg-rose-50"
      : "bg-slate-100";
  const bar =
    tint === "emerald"
      ? "bg-emerald-600"
      : tint === "rose"
      ? "bg-rose-600"
      : "bg-slate-600";

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
        <HeaderStat
          title="Remaining"
          value={formatInt(Math.max(0, ag.qtyTotal - ag.plannedTotal))}
        />
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
  const [orders, setOrders] = useState<Order[]>([
    defaultOrder("BUY", 1),
    defaultOrder("SELL", 1),
  ]);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const visibleOrders = selectedId ? orders.filter((o) => o.id === selectedId) : orders;

  // chips
  const chips = [{ id: null as string | null, label: "ALL" }].concat(
    orders.map((o) => ({ id: o.id, label: o.name, side: o.side } as any))
  );

  const addOrder = (side: Side) =>
    setOrders((o) => [...o, defaultOrder(side, o.length + 1)]);
  const removeOrder = (id: string) => {
    setOrders((o) => o.filter((x) => x.id !== id));
    if (selectedId === id) setSelectedId(null);
  };
  const duplicateOrder = (id: string) =>
    setOrders((o) => {
      const src = o.find((x) => x.id === id);
      if (!src) return o;
      const copy = {
        ...src,
        id: Math.random().toString(36).slice(2, 9),
        name: src.name + " (copy)",
      };
      return [...o, copy];
    });
  const updateOrder = (id: string, next: Order) =>
    setOrders((o) => o.map((x) => (x.id === id ? next : x)));

  // aggregates (filter-aware)
  const allAgg = aggregateOrders(visibleOrders);
  const buyAgg = aggregateOrders(visibleOrders.filter((o) => o.side === "BUY"));
  const sellAgg = aggregateOrders(visibleOrders.filter((o) => o.side === "SELL"));

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      {/* Sticky summary */}
      <div className="sticky top-0 z-20 backdrop-blur bg-slate-50/80 border-b">
        <div className="max-w-7xl mx-auto p-4 grid gap-4">
          <div className="flex items-center justify-between">
            <h1 className="text-xl font-bold">OTD / INLINE Execution Planner</h1>
            <div className="flex gap-2">
              <button
                onClick={() => addOrder("BUY")}
                className="px-3 py-2 rounded-xl bg-emerald-600 text-white text-sm"
              >
                + Add BUY
              </button>
              <button
                onClick={() => addOrder("SELL")}
                className="px-3 py-2 rounded-xl bg-rose-600 text-white text-sm"
              >
                + Add SELL
              </button>
            </div>
          </div>

          <div className="grid md:grid-cols-3 gap-3">
            <SummaryBlock title="ALL Orders" tint="slate" ag={allAgg} />
            <SummaryBlock title="BUY" tint="emerald" ag={buyAgg} side="BUY" />
            <SummaryBlock title="SELL" tint="rose" ag={sellAgg} side="SELL" />
          </div>

          {/* Chips filter bar */}
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
              const border = isBuy
                ? "border-emerald-200"
                : isSell
                ? "border-rose-200"
                : "border-slate-200";
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

      {/* Cards list */}
      <div className="max-w-7xl mx-auto p-4 grid gap-5">
        {visibleOrders.map((o) => (
          <ColorPlannerCard
            key={o.id}
            order={o}
            onChange={(n) => updateOrder(o.id, n)}
            onRemove={() => removeOrder(o.id)}
            onDuplicate={() => duplicateOrder(o.id)}
          />
        ))}
        {visibleOrders.length === 0 && (
          <div className="text-sm text-slate-500">No orders selected.</div>
        )}
      </div>

      {/* Self-tests (console) */}
      <div className="max-w-7xl mx-auto p-4">
        <div className="bg-white rounded-2xl shadow p-4 text-sm">
          <div className="font-semibold">Built-in Self Tests</div>
          <pre className="text-xs bg-slate-50 p-3 rounded-xl overflow-x-auto">{`console.assert(minutesBetween('09:30','10:00') === 30, 'minutesBetween failed');
console.assert(addMinutes('09:30', 30) === '10:00', 'addMinutes failed');
const ts = timeSlices('09:30','10:30',30); console.assert(ts.length===2 && ts[0].s==='09:30' && ts[1].e==='10:30', 'timeSlices failed');
const w1 = equalWeights(4); console.assert(Math.abs(w1.reduce((a,b)=>a+b,0)-1) < 1e-9, 'equalWeights sum');
const w2 = uCurveWeights(5); console.assert(Math.abs(w2.reduce((a,b)=>a+b,0)-1) < 1e-9, 'uCurveWeights sum');
console.assert(/[",\\n]/.test('a,b'), 'toCSV regex check');
console.assert(toCSV([{A:'a',B:'b'},{A:'1',B:'2'}]).includes('A,B'), 'toCSV header');`}</pre>
        </div>
      </div>
    </div>
  );
}
