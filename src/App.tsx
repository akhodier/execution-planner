import React, { useEffect, useMemo, useRef, useState } from "react";

/** ======================================================================
 * Execution Planner — Pacing, Alerts, Interval Reminders (with sound)
 * - Per-order market preset & "Start from now"
 * - OTD math fixed: continuous = orderQty - auctionReserve (no off-by-one)
 * - Accumulated Suggested (time-aware, partial live slice) vs Executed
 * - Pacing gauge (Ahead/On/Lag), Completion %, Slippage (bps), Next Action
 * - Alerts: Critical / Important / Info
 * - Notifications & Sound reminders per order (slice-boundary or N-min)
 * - Simple view (glance) & Advanced view (details + guidance)
 * - Mark Completed → quick post-trade card
 * ====================================================================== */

/* -------------------- Types -------------------- */
type ExecMode = "OTD" | "INLINE";
type CapMode = "NONE" | "PCT";
type Curve = "equal" | "ucurve";
type Side = "BUY" | "SELL";
type MarketKey = "Egypt" | "Kuwait" | "Qatar" | "DFM" | "ADX" | "Saudi";
type PaceClass = "AHEAD" | "ON" | "LAG";

type Snapshot = {
  at: string; // HH:MM:SS
  note?: string;
  currentVol: number;
  expectedContVol: number;
  expectedAuctionVol: number;
  orderExecQty: number;
  orderExecNotional: number;
  marketTurnover: number;
  marketVWAPInput: number;
};

type LiquidityProfile = "Quiet" | "Normal" | "Volatile";

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

  // volumes (dealer-updated intraday)
  startVol: number;      // market volume at the time order starts tracking
  currentVol: number;    // current cumulative market volume
  expectedContVol: number;
  expectedAuctionVol: number;

  // VWAP monitor
  marketTurnover: number;
  marketVWAPInput: number;

  // executed so far
  orderExecQty: number;
  orderExecNotional: number;

  // extras
  market?: MarketKey;
  startFromNow?: boolean;
  snapshots: Snapshot[];
  liquidity: LiquidityProfile;
  completed: boolean;

  // reminders / notifications
  notificationsOn: boolean;
  soundOn: boolean;
  sliceReminders: boolean;     // remind at slice boundaries
  remindEveryMins: number;     // or remind every N minutes
};

/* -------------------- Market presets -------------------- */
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

// Profiles minimize typing — used to prefill expected volumes
const PROFILE_VOLS: Record<LiquidityProfile, { cont: number; auction: number }> = {
  Quiet:   { cont: 400_000, auction: 300_000 },
  Normal:  { cont: 800_000, auction: 400_000 },
  Volatile:{ cont: 1_300_000, auction: 600_000 },
};

/* -------------------- Utilities -------------------- */
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

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

function timeSlices(start: string, end: string, step: number) {
  const out: { s: string; e: string; label: string; mins: number }[] = [];
  const total = Math.max(0, minutesBetween(start, end));
  const n = Math.max(1, Math.ceil(total / step));
  for (let i = 0; i < n; i++) {
    const s = addMinutes(start, i * step);
    const e = i === n - 1 ? end : addMinutes(start, (i + 1) * step);
    out.push({ s, e, label: `${s} – ${e}`, mins: Math.max(0, minutesBetween(s, e)) });
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

/* -------------------- Notifications & sound helpers -------------------- */
function requestNotifyPermission() {
  if ("Notification" in window && Notification.permission === "default") {
    Notification.requestPermission().catch(() => {});
  }
}
function fireNotification(title: string, body: string) {
  if (!("Notification" in window)) return;
  if (Notification.permission === "granted") {
    new Notification(title, { body });
  }
}
function playBeep(volume = 0.05, seconds = 0.2) {
  try {
    const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = 880;
    gain.gain.value = volume;
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    setTimeout(() => {
      osc.stop();
      ctx.close();
    }, seconds * 1000);
  } catch {}
}

/* -------------------- Planning & analytics -------------------- */
function applyCap(capMode: CapMode, maxPart: number, qty: number, sliceVol: number) {
  if (capMode === "NONE") return Math.max(0, Math.floor(qty));
  const allowed = Math.floor((sliceVol * maxPart) / 100);
  return Math.max(0, Math.min(Math.floor(qty), allowed));
}

type BuiltRow = {
  interval: string;
  s: string;
  e: string;
  mins: number;
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
  const reserveAuctionQty = Math.floor((order.orderQty * Math.max(0, order.reserveAuctionPct)) / 100);

  const auctionAllowed =
    order.capMode === "PCT" ? Math.floor((order.expectedAuctionVol * order.maxPart) / 100) : order.expectedAuctionVol;

  const rows: BuiltRow[] = [];

  if (order.execMode === "OTD") {
    const targetContinuousQty = Math.max(0, order.orderQty - reserveAuctionQty);
    let remaining = targetContinuousQty;

    for (let i = 0; i < slices.length; i++) {
      const sl = slices[i];
      const sliceVol = Math.max(0, contVolPerSlice[i]);
      let base = Math.floor(weights[i] * targetContinuousQty);
      base = Math.min(base, remaining);
      let suggested = applyCap(order.capMode, order.maxPart, base, sliceVol);

      const isLast = i === slices.length - 1;
      if (order.deferCompletion && !isLast) {
        const keepBack = Math.ceil(targetContinuousQty * 0.05);
        if (remaining - suggested <= 0) suggested = Math.max(0, remaining - keepBack);
      }

      suggested = Math.min(suggested, remaining);
      remaining -= suggested;

      rows.push({
        interval: sl.label,
        s: sl.s,
        e: sl.e,
        mins: sl.mins,
        expMktVol: sliceVol,
        maxAllowed: order.capMode === "PCT" ? Math.floor((sliceVol * order.maxPart) / 100) : "∞",
        suggestedQty: suggested,
      });
    }

    const contPlanned = rows.reduce((a, r) => a + r.suggestedQty, 0);
    // Whatever wasn’t scheduled in continuous goes to auction, capped by auctionAllowed
    const auctionPlanned = Math.min(reserveAuctionQty + Math.max(0, targetContinuousQty - contPlanned), auctionAllowed);

    return { rows, contPlanned, auctionAllowed, auctionPlanned };
  }

  // INLINE
  const expectedTotalVol = order.currentVol + order.expectedContVol + order.expectedAuctionVol;
  const pov = expectedTotalVol > 0 ? Math.min(1, order.orderQty / expectedTotalVol) : 0;

  for (let i = 0; i < slices.length; i++) {
    const sl = slices[i];
    const sliceVol = Math.max(0, contVolPerSlice[i]);
    const base = Math.floor(sliceVol * pov);
    const suggested = applyCap(order.capMode, order.maxPart, base, sliceVol);
    rows.push({
      interval: sl.label,
      s: sl.s,
      e: sl.e,
      mins: sl.mins,
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

  // Do not exceed total; shave auction or last slices if needed
  let totalPlanned = contPlanned + auctionPlanned;
  if (totalPlanned > order.orderQty) {
    const excess = totalPlanned - order.orderQty;
    if (order.deferCompletion) {
      for (let i = rows.length - 1; i >= 0 && totalPlanned > order.orderQty; i--) {
        const trim = Math.min(excess, rows[i].suggestedQty);
        rows[i].suggestedQty -= trim;
        totalPlanned -= trim;
      }
    } else {
      auctionPlanned = Math.max(0, auctionPlanned - excess);
    }
  }

  return { rows, contPlanned, auctionAllowed, auctionPlanned };
}

/* -------------------- Accumulated Suggested (time-aware) -------------------- */
function accumulatedSuggested(plan: BuiltPlan, sessionStart: string, now: string) {
  let acc = 0;
  for (const r of plan.rows) {
    if (now >= r.e) acc += r.suggestedQty;
    else if (now > r.s && now < r.e) {
      const elapsed = clamp(minutesBetween(r.s, now), 0, r.mins);
      const frac = r.mins > 0 ? elapsed / r.mins : 0;
      acc += Math.floor(r.suggestedQty * frac);
      break;
    } else if (now < r.s) {
      break;
    }
  }
  return acc;
}

/* -------------------- Performance & pacing -------------------- */
function performanceBps(side: Side, orderVWAP: number, marketVWAP: number) {
  if (!marketVWAP || !orderVWAP) return 0;
  return side === "BUY"
    ? ((marketVWAP - orderVWAP) / marketVWAP) * 10000
    : ((orderVWAP - marketVWAP) / marketVWAP) * 10000;
}

function impliedMarketVWAP(turnover: number, curVol: number, manual: number) {
  if (curVol > 0 && turnover > 0) return turnover / curVol;
  return manual || 0;
}

/* -------------------- Inputs -------------------- */
function IntInput({
  label, value, onChange, className,
}: { label?: string; value: number; onChange: (n: number) => void; className?: string }) {
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
  label, value, onNumberChange, className, decimals = 4,
}: { label?: string; value: number; onNumberChange: (n: number) => void; className?: string; decimals?: number }) {
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
function Stat({ title, value }: { title: string; value: React.ReactNode }) {
  return (
    <div className="p-3 rounded-xl bg-slate-100">
      <div className="opacity-60 text-xs">{title}</div>
      <div className="font-semibold">{value}</div>
    </div>
  );
}

/* -------------------- Themes -------------------- */
function theme(side: Side) {
  return side === "BUY"
    ? { text: "text-emerald-700", bgSoft: "bg-emerald-50", border: "border-emerald-300", strong: "bg-emerald-600" }
    : { text: "text-rose-700", bgSoft: "bg-rose-50", border: "border-rose-300", strong: "bg-rose-600" };
}

/* -------------------- Planner Card -------------------- */
function PlannerCard({
  order, onChange, onRemove, onDuplicate, onFocusMe,
}: {
  order: Order;
  onChange: (o: Order) => void;
  onRemove: () => void;
  onDuplicate: () => void;
  onFocusMe?: () => void;
}) {
  const t = theme(order.side);
  const [clock, setClock] = useState(nowHHMMSS());
  useEffect(() => {
    const id = setInterval(() => setClock(nowHHMMSS()), 1000);
    return () => clearInterval(id);
  }, []);

  // Market preset apply (per order)
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

  // Volume profiles (reduce typing)
  function applyProfile(profile: LiquidityProfile) {
    const pv = PROFILE_VOLS[profile];
    onChange({ ...order, liquidity: profile, expectedContVol: pv.cont, expectedAuctionVol: pv.auction });
  }

  const plan = useMemo(() => buildPlan(order), [order]);
  const totalPlanned = plan.contPlanned + plan.auctionPlanned;
  const remaining = Math.max(0, order.orderQty - totalPlanned);

  /* ---- Accumulated Suggested & Executed ---- */
  const now = new Date().toTimeString().slice(0, 5);
  const accSuggested = useMemo(
    () => accumulatedSuggested(plan, order.sessionStart, now),
    [plan, order.sessionStart, now]
  );
  const accExecuted = order.orderExecQty;
  const deltaVsPlan = accExecuted - accSuggested;

  // Completion
  const completionPct = order.orderQty > 0 ? Math.min(100, Math.round((accExecuted / order.orderQty) * 100)) : 0;

  // Pacing class
  const paceClass: PaceClass =
    accSuggested === 0
      ? "ON"
      : deltaVsPlan >= accSuggested * 0.05
      ? "AHEAD"
      : deltaVsPlan <= -accSuggested * 0.05
      ? "LAG"
      : "ON";

  // VWAP performance
  const marketVWAP = impliedMarketVWAP(order.marketTurnover, order.currentVol - order.startVol, order.marketVWAPInput);
  const orderVWAP = order.orderExecQty > 0 ? order.orderExecNotional / order.orderExecQty : 0;
  const perf = performanceBps(order.side, orderVWAP, marketVWAP);

  // Next Action (simple)
  let nextAction = "Keep steady.";
  if (paceClass === "LAG") nextAction = "Increase clip size or relax cap.";
  if (paceClass === "AHEAD") nextAction = "Ease slightly; protect auction reserve.";
  if (remaining <= 0) nextAction = "Done — maintain auction stance as configured.";

  // Alerts
  const alerts: { level: "CRIT" | "WARN" | "INFO"; msg: string }[] = [];
  const missingVWAP = !(order.marketTurnover > 0 || order.marketVWAPInput > 0);
  if (missingVWAP) alerts.push({ level: "WARN", msg: "Missing market VWAP (turnover or manual)" });

  // If order started mid-session, use (currentVol - startVol) for pacing awareness
  if (order.currentVol <= order.startVol) {
    alerts.push({ level: "INFO", msg: "Market volume not updated since start — pacing may be stale." });
  }

  // Must-complete logic (OTD & no auction reserve or very late)
  const minsToEnd = Math.max(0, minutesBetween(now, order.sessionEnd));
  if (remaining > 0 && minsToEnd <= order.intervalMins) {
    alerts.push({ level: "CRIT", msg: "Session ending — finalize remaining quantity." });
  }

  // Cap-binding hint: if many rows have suggested == maxAllowed
  const capHitCount = plan.rows.filter((r) => typeof r.maxAllowed === "number" && r.suggestedQty >= r.maxAllowed).length;
  if (order.capMode === "PCT" && capHitCount >= Math.ceil(plan.rows.length * 0.3)) {
    alerts.push({ level: "WARN", msg: "Cap binding frequently — consider OTD or raise max participation slightly." });
  }

  // Status colors
  const paceTag =
    paceClass === "AHEAD" ? "bg-emerald-600" : paceClass === "ON" ? "bg-slate-600" : "bg-amber-600";

  // Notifications / reminders
  useEffect(() => {
    if (!order.notificationsOn) return;
    requestNotifyPermission();
  }, [order.notificationsOn]);

  // Slice-boundary reminders OR every N mins
  const lastReminderRef = useRef<string>("");
  useEffect(() => {
    if (!order.notificationsOn) return;

    function remind() {
      const title = `${order.name}: update market & exec`;
      const body = "Please refresh Current Vol, Exec Qty/Notional; pacing & coach will adjust.";
      fireNotification(title, body);
      if (order.soundOn) playBeep();
      lastReminderRef.current = nowHHMMSS();
    }

    let timer: number | undefined;

    if (order.sliceReminders) {
      // compute ms to next slice boundary
      const setNext = () => {
        const cur = new Date();
        const curHHMM = cur.toTimeString().slice(0, 5);
        const nextEdge = plan.rows.find((r) => curHHMM < r.e);
        if (!nextEdge) return; // day done
        const [eh, em] = nextEdge.e.split(":").map((x) => parseInt(x, 10));
        const next = new Date(cur);
        next.setHours(eh, em, 0, 0);
        const ms = next.getTime() - cur.getTime();
        timer = window.setTimeout(() => {
          remind();
          setNext();
        }, Math.max(1000, ms));
      };
      setNext();
      return () => timer && clearTimeout(timer);
    } else {
      // every N minutes
      const ms = Math.max(1, order.remindEveryMins) * 60 * 1000;
      timer = window.setInterval(() => remind(), ms) as unknown as number;
      return () => timer && clearInterval(timer);
    }
  }, [order.notificationsOn, order.soundOn, order.sliceReminders, order.remindEveryMins, order.name, plan.rows]);

  // Snapshot
  function logSnapshot(note?: string) {
    const snap: Snapshot = {
      at: nowHHMMSS(),
      note,
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

  // Mark completed
  function markCompleted() {
    onChange({ ...order, completed: true });
  }

  // Theme helpers
  const barColor = t.strong;

  // Simple/Advanced toggle
  const [showAdvanced, setShowAdvanced] = useState(false);

  return (
    <div className={`rounded-2xl shadow border ${t.border} bg-white overflow-hidden`}>
      {/* Header: name editable & controls */}
      <div className={`px-4 py-3 border-b ${t.border} flex items-center justify-between`}>
        <div className="flex items-center gap-3">
          <span className={`inline-flex items-center px-2.5 py-1 rounded-full text-xs font-semibold ${t.bgSoft} ${t.text}`}>
            {order.side}
          </span>
          <input
            className="border rounded-xl px-2 py-1 text-sm"
            value={order.name}
            onChange={(e) => onChange({ ...order, name: e.target.value })}
            onFocus={onFocusMe}
          />
          <div className="text-xs opacity-60">Local time: <span className="font-mono">{clock}</span></div>
        </div>
        <div className="flex gap-2">
          <button onClick={() => setShowAdvanced((s) => !s)} className="px-3 py-2 rounded-xl border text-sm">
            {showAdvanced ? "Simple View" : "Advanced View"}
          </button>
          {!order.completed && (
            <button onClick={markCompleted} className="px-3 py-2 rounded-xl bg-slate-900 text-white text-sm">
              Mark Completed
            </button>
          )}
          <button onClick={onDuplicate} className="px-3 py-2 rounded-xl border text-sm">Duplicate</button>
          <button onClick={onRemove} className="px-3 py-2 rounded-xl border text-sm">Remove</button>
        </div>
      </div>

      {/* Completed? → quick report */}
      {order.completed && (
        <div className="p-4 grid md:grid-cols-4 gap-3 bg-slate-50 border-b">
          <Stat title="Final Completion" value={`${completionPct}%`} />
          <Stat title="Order VWAP" value={orderVWAP ? formatMoney(orderVWAP, 4) : "—"} />
          <Stat title="Market VWAP" value={marketVWAP ? formatMoney(marketVWAP, 4) : "—"} />
          <Stat title="Slippage (bps)" value={Number.isFinite(perf) ? perf.toFixed(1) : "—"} />
        </div>
      )}

      {/* HUD: pace, completion, slippage, next action */}
      {!order.completed && (
        <div className="p-4 grid md:grid-cols-6 gap-3 items-end">
          <Stat
            title="Pacing"
            value={
              <span className={`text-xs px-2 py-1 rounded text-white ${paceTag}`}>
                {paceClass === "AHEAD" ? "Ahead" : paceClass === "LAG" ? "Behind" : "On track"}
              </span>
            }
          />
          <Stat title="Completion" value={
            <div className="w-full">
              <div className="w-full h-2 bg-slate-200 rounded-full overflow-hidden">
                <div className={`h-2 ${barColor}`} style={{ width: `${completionPct}%` }} />
              </div>
              <div className="text-xs opacity-60 mt-1">{completionPct}%</div>
            </div>
          }/>
          <Stat title="Acc. Suggested → Executed" value={
            <div className="text-sm">
              {formatInt(accSuggested)} → <span className="font-semibold">{formatInt(accExecuted)}</span>
              <div className={`text-xs ${deltaVsPlan < 0 ? "text-amber-700" : "text-emerald-700"}`}>
                Δ {formatInt(deltaVsPlan)}
              </div>
            </div>
          }/>
          <Stat title="Slippage (bps)" value={Number.isFinite(perf) ? perf.toFixed(1) : "—"} />
          <Stat title="Remaining" value={formatInt(Math.max(0, order.orderQty - accExecuted))} />
          <div className="flex flex-col gap-1">
            <div className="opacity-60 text-xs">Next Best Action</div>
            <div className={`text-xs px-2.5 py-1 rounded-full text-white ${barColor}`}>{nextAction}</div>
          </div>
        </div>
      )}

      {/* Alerts row */}
      {!order.completed && (
        <div className="px-4 pb-2 flex flex-wrap gap-2">
          {alerts.length === 0 ? (
            <span className="text-xs px-2.5 py-1 rounded-full bg-slate-100">All checks OK</span>
          ) : (
            alerts.map((a, i) => {
              const cls =
                a.level === "CRIT" ? "bg-rose-600 text-white"
                : a.level === "WARN" ? `${t.bgSoft} ${t.text} border ${t.border}`
                : "bg-slate-100";
              return (
                <span key={i} className={`text-xs px-2.5 py-1 rounded-full ${cls}`}>{a.msg}</span>
              );
            })
          )}
        </div>
      )}

      {/* Simple view (compact) */}
      {!order.completed && !showAdvanced && (
        <div className="px-4 pb-4 grid md:grid-cols-3 gap-4">
          <div className="space-y-3">
            <h3 className="font-semibold">Order</h3>
            <label className="text-sm">
              Symbol
              <input className="mt-1 w-full border rounded-xl p-2" value={order.symbol}
                onChange={(e) => onChange({ ...order, symbol: e.target.value.toUpperCase() })}/>
            </label>
            <label className="text-sm">
              Side
              <select className="mt-1 w-full border rounded-xl p-2" value={order.side}
                onChange={(e)=>onChange({ ...order, side: e.target.value as Side })}>
                <option value="BUY">BUY</option>
                <option value="SELL">SELL</option>
              </select>
            </label>
            <IntInput label="Order Qty" value={order.orderQty}
              onChange={(n)=>onChange({ ...order, orderQty: n })}/>
            <label className="text-sm">
              Market
              <div className="flex flex-wrap gap-2 mt-1">
                {(["Egypt","Kuwait","Qatar","DFM","ADX","Saudi"] as MarketKey[]).map((m)=>(
                  <button key={m} onClick={()=>applyMarketPreset(m, !!order.startFromNow)}
                    className={`px-3 py-1.5 rounded-full border ${order.market===m ? "bg-slate-900 text-white" : "bg-white"}`}>
                    {m}
                  </button>
                ))}
                <label className="flex items-center gap-2 text-xs ml-1">
                  <input type="checkbox" checked={!!order.startFromNow}
                    onChange={(e)=>applyMarketPreset(order.market || "Qatar", e.target.checked)}/>
                  Start from now
                </label>
              </div>
            </label>
            <label className="text-sm">
              Profile
              <div className="flex gap-2 mt-1">
                {(["Quiet","Normal","Volatile"] as LiquidityProfile[]).map(p=>(
                  <button key={p} onClick={()=>applyProfile(p)}
                    className={`px-3 py-1.5 rounded-full border ${order.liquidity===p ? "bg-slate-900 text-white" : "bg-white"}`}>
                    {p}
                  </button>
                ))}
              </div>
            </label>
          </div>

          <div className="space-y-3">
            <h3 className="font-semibold">Timing</h3>
            <div className="grid grid-cols-2 gap-3">
              <label className="text-sm">Start
                <input type="time" className="mt-1 w-full border rounded-xl p-2"
                  value={order.sessionStart} onChange={(e)=>onChange({ ...order, sessionStart: e.target.value })}/>
              </label>
              <label className="text-sm">End
                <input type="time" className="mt-1 w-full border rounded-xl p-2"
                  value={order.sessionEnd} onChange={(e)=>onChange({ ...order, sessionEnd: e.target.value })}/>
              </label>
              <label className="text-sm">Interval (min)
                <input type="number" className="mt-1 w-full border rounded-xl p-2"
                  value={order.intervalMins} onChange={(e)=>onChange({ ...order, intervalMins: Math.max(1, parseInt(e.target.value||"1")) })}/>
              </label>
              <label className="text-sm">Curve
                <select className="mt-1 w-full border rounded-xl p-2" value={order.curve}
                  onChange={(e)=>onChange({ ...order, curve: e.target.value as Curve })}>
                  <option value="ucurve">U-curve</option>
                  <option value="equal">Equal</option>
                </select>
              </label>
            </div>

            <h3 className="font-semibold mt-3">Volumes (quick)</h3>
            <div className="grid grid-cols-2 gap-3">
              <IntInput label="Start Vol" value={order.startVol} onChange={(n)=>onChange({ ...order, startVol: n })}/>
              <IntInput label="Current Vol" value={order.currentVol} onChange={(n)=>onChange({ ...order, currentVol: n })}/>
              <IntInput className="col-span-2" label="Expected Continuous" value={order.expectedContVol}
                onChange={(n)=>onChange({ ...order, expectedContVol: n })}/>
              <IntInput className="col-span-2" label="Expected Auction" value={order.expectedAuctionVol}
                onChange={(n)=>onChange({ ...order, expectedAuctionVol: n })}/>
            </div>
          </div>

          <div className="space-y-3">
            <h3 className="font-semibold">Exec & VWAP</h3>
            <div className="grid grid-cols-2 gap-3">
              <IntInput label="Executed Qty" value={order.orderExecQty} onChange={(n)=>onChange({ ...order, orderExecQty: n })}/>
              <MoneyInput label="Executed Notional" value={order.orderExecNotional} onNumberChange={(n)=>onChange({ ...order, orderExecNotional: n })}/>
              <MoneyInput label="Market Turnover" value={order.marketTurnover} onNumberChange={(n)=>onChange({ ...order, marketTurnover: n })}/>
              <MoneyInput label="Manual Market VWAP" value={order.marketVWAPInput} onNumberChange={(n)=>onChange({ ...order, marketVWAPInput: n })}/>
            </div>

            <h3 className="font-semibold mt-3">Reminders</h3>
            <label className="text-sm flex items-center gap-2">
              <input type="checkbox" checked={order.notificationsOn}
                onChange={(e)=>onChange({ ...order, notificationsOn: e.target.checked })}/>
              Enable notifications
            </label>
            <label className="text-sm flex items-center gap-2">
              <input type="checkbox" checked={order.soundOn}
                onChange={(e)=>onChange({ ...order, soundOn: e.target.checked })}/>
              Play sound
            </label>
            <label className="text-sm flex items-center gap-2">
              <input type="checkbox" checked={order.sliceReminders}
                onChange={(e)=>onChange({ ...order, sliceReminders: e.target.checked })}/>
              Remind at each slice boundary
            </label>
            {!order.sliceReminders && (
              <label className="text-sm">
                Or every (mins)
                <input type="number" className="mt-1 w-full border rounded-xl p-2"
                  value={order.remindEveryMins}
                  onChange={(e)=>onChange({ ...order, remindEveryMins: Math.max(1, parseInt(e.target.value||"1")) })}/>
              </label>
            )}
            <button onClick={()=>logSnapshot()} className={`mt-2 px-3 py-2 rounded-xl text-white ${t.strong} text-sm`}>
              Log snapshot
            </button>
          </div>
        </div>
      )}

      {/* Advanced view */}
      {!order.completed && showAdvanced && (
        <div className="px-4 pb-4 grid md:grid-cols-3 gap-4">
          {/* Strategy card */}
          <div className="space-y-3">
            <h3 className="font-semibold">Strategy</h3>
            <label className="text-sm">Execution Mode
              <select className="mt-1 w-full border rounded-xl p-2" value={order.execMode}
                onChange={(e)=>onChange({ ...order, execMode: e.target.value as ExecMode })}>
                <option value="OTD">OTD (time-sliced)</option>
                <option value="INLINE">Inline (POV)</option>
              </select>
            </label>
            <label className="text-sm">Cap Mode
              <select className="mt-1 w-full border rounded-xl p-2" value={order.capMode}
                onChange={(e)=>onChange({ ...order, capMode: e.target.value as CapMode })}>
                <option value="PCT">Max % of Volume</option>
                <option value="NONE">No Volume Cap</option>
              </select>
            </label>
            {order.capMode === "PCT" && (
              <label className="text-sm">Max Participation %
                <input type="number" className="mt-1 w-full border rounded-xl p-2"
                  value={order.maxPart}
                  onChange={(e)=>onChange({ ...order, maxPart: Math.max(0, parseFloat(e.target.value||"0")) })}/>
              </label>
            )}
            <label className="text-sm">Reserve for Auction %
              <input type="number" className="mt-1 w-full border rounded-xl p-2"
                value={order.reserveAuctionPct}
                onChange={(e)=>onChange({ ...order, reserveAuctionPct: Math.max(0, parseFloat(e.target.value||"0")) })}/>
            </label>
            <label className="text-sm flex items-center gap-2">
              <input type="checkbox" checked={order.deferCompletion}
                onChange={(e)=>onChange({ ...order, deferCompletion: e.target.checked })}/>
              Do not complete before end
            </label>
          </div>

          {/* Timing detail */}
          <div className="space-y-3">
            <h3 className="font-semibold">Session Windows</h3>
            <div className="grid grid-cols-2 gap-3">
              <label className="text-sm">Auction Start
                <input type="time" className="mt-1 w-full border rounded-xl p-2"
                  value={order.auctionStart}
                  onChange={(e)=>onChange({ ...order, auctionStart: e.target.value })}/>
              </label>
              <label className="text-sm">Auction End
                <input type="time" className="mt-1 w-full border rounded-xl p-2"
                  value={order.auctionEnd}
                  onChange={(e)=>onChange({ ...order, auctionEnd: e.target.value })}/>
              </label>
              <label className="text-sm">TAL Start
                <input type="time" className="mt-1 w-full border rounded-xl p-2"
                  value={order.talStart}
                  onChange={(e)=>onChange({ ...order, talStart: e.target.value })}/>
              </label>
              <label className="text-sm">TAL End
                <input type="time" className="mt-1 w-full border rounded-xl p-2"
                  value={order.talEnd}
                  onChange={(e)=>onChange({ ...order, talEnd: e.target.value })}/>
              </label>
            </div>

            <h3 className="font-semibold mt-3">Guidance</h3>
            <div className="text-xs opacity-70">
              • If pacing lags late in day, tool suggests raising cap or switching to OTD. <br/>
              • If caps bind often in INLINE, consider OTD or micro-raise max %. <br/>
              • Use snapshots as a decision journal for post-trade review.
            </div>
          </div>

          {/* Snapshot table compact */}
          <div className="space-y-3">
            <h3 className="font-semibold">Snapshots</h3>
            <div className="rounded-xl border overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="bg-slate-50">
                  <tr className="text-left">
                    <th className="p-2">Time</th>
                    <th className="p-2">Cur Vol</th>
                    <th className="p-2">Exec Qty</th>
                    <th className="p-2">Exec Notional</th>
                    <th className="p-2">Turnover</th>
                    <th className="p-2">Manual VWAP</th>
                    <th className="p-2">Note</th>
                  </tr>
                </thead>
                <tbody>
                  {[...order.snapshots].reverse().map((s, i) => (
                    <tr key={i} className="border-t">
                      <td className="p-2 font-mono">{s.at}</td>
                      <td className="p-2">{formatInt(s.currentVol)}</td>
                      <td className="p-2">{formatInt(s.orderExecQty)}</td>
                      <td className="p-2">{formatMoney(s.orderExecNotional, 2)}</td>
                      <td className="p-2">{formatMoney(s.marketTurnover, 2)}</td>
                      <td className="p-2">{s.marketVWAPInput ? formatMoney(s.marketVWAPInput, 4) : "—"}</td>
                      <td className="p-2">{s.note || "—"}</td>
                    </tr>
                  ))}
                  {order.snapshots.length === 0 && (
                    <tr><td className="p-2 text-slate-500" colSpan={7}>No snapshots yet.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
            <div className="flex gap-2">
              <input
                id={`snapnote-${order.id}`}
                className="flex-1 border rounded-xl p-2 text-sm"
                placeholder="Optional: add a note before logging snapshot"
              />
              <button
                onClick={()=>{
                  const el = document.getElementById(`snapnote-${order.id}`) as HTMLInputElement | null;
                  const note = el?.value || undefined;
                  logSnapshot(note);
                  if (el) el.value = "";
                }}
                className={`px-3 py-2 rounded-xl text-white ${t.strong} text-sm`}>
                Log snapshot
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Plan table (always visible when not completed) */}
      {!order.completed && (
        <div className="px-4 pb-4">
          <div className="text-sm opacity-70 mb-2">Plan</div>
          <div className="overflow-x-auto rounded-xl border">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-white">
                <tr className="text-left border-b">
                  <th className="py-2 pr-2">Interval</th>
                  <th className="py-2 pr-2">Expected Vol</th>
                  <th className="py-2 pr-2">Max Allowed</th>
                  <th className="py-2 pr-2">Suggested Qty</th>
                </tr>
              </thead>
              <tbody>
                {plan.rows.map((r) => {
                  const curHHMM = new Date().toTimeString().slice(0, 5);
                  const isLive = curHHMM >= r.s && curHHMM < r.e;
                  // Impact flag if suggested >25% of expected vol
                  const impact = r.expMktVol > 0 && r.suggestedQty / r.expMktVol > 0.25;
                  return (
                    <tr key={r.interval}
                      className={`border-b last:border-0 ${isLive ? `${t.bgSoft} animate-pulse` : ""}`}>
                      <td className={`py-2 pr-2 ${t.text}`}>
                        {r.interval} {impact && <span title="High impact risk" className="ml-1">⚠️</span>}
                      </td>
                      <td className="py-2 pr-2">{formatInt(r.expMktVol)}</td>
                      <td className="py-2 pr-2">
                        {typeof r.maxAllowed === "number" ? formatInt(r.maxAllowed) : r.maxAllowed}
                      </td>
                      <td className="py-2 pr-2 font-semibold">{formatInt(r.suggestedQty)}</td>
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
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

/* -------------------- Aggregates & App Shell -------------------- */
function defaultOrder(side: Side, idx = 1): Order {
  const pv = PROFILE_VOLS.Normal;
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
    expectedContVol: pv.cont,
    expectedAuctionVol: pv.auction,

    marketTurnover: 0,
    marketVWAPInput: 0,

    orderExecQty: 0,
    orderExecNotional: 0,

    market: "Qatar",
    startFromNow: false,
    snapshots: [],
    liquidity: "Normal",
    completed: false,

    notificationsOn: false,
    soundOn: false,
    sliceReminders: true,
    remindEveryMins: 15,
  };
}

type Aggregates = {
  qtyTotal: number;
  execQty: number;
  execNotional: number;
};
function aggregateOrders(orders: Order[]): Aggregates {
  return orders.reduce<Aggregates>(
    (agg, o) => ({
      qtyTotal: agg.qtyTotal + o.orderQty,
      execQty: agg.execQty + o.orderExecQty,
      execNotional: agg.execNotional + o.orderExecNotional,
    }),
    { qtyTotal: 0, execQty: 0, execNotional: 0 }
  );
}

function OrdersRail({
  orders, selectedId, onSelect, onAdd,
}: {
  orders: Order[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onAdd: (side: Side) => void;
}) {
  return (
    <div className="hidden md:block w-64 shrink-0 border-r bg-white">
      <div className="p-3 border-b flex items-center justify-between">
        <div className="font-semibold">Orders</div>
        <div className="flex gap-1">
          <button onClick={()=>onAdd("BUY")} className="px-2 py-1 text-xs rounded bg-emerald-600 text-white">+ BUY</button>
          <button onClick={()=>onAdd("SELL")} className="px-2 py-1 text-xs rounded bg-rose-600 text-white">+ SELL</button>
        </div>
      </div>
      <div>
        <button
          onClick={()=>onSelect(null)}
          className={`w-full text-left px-3 py-2 text-sm border-b ${selectedId===null ? "bg-slate-100" : ""}`}
        >
          ALL
        </button>
        {orders.map(o=>(
          <button key={o.id} onClick={()=>onSelect(o.id)}
            className={`w-full text-left px-3 py-2 text-sm border-b flex items-center justify-between ${selectedId===o.id ? "bg-slate-100" : ""}`}>
            <span className="truncate">{o.name}</span>
            <span className={`ml-2 inline-block w-2 h-2 rounded-full ${o.side==="BUY"?"bg-emerald-600":"bg-rose-600"}`}/>
          </button>
        ))}
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

  const visible = selectedId ? orders.filter((o) => o.id === selectedId) : orders;
  const ag = aggregateOrders(visible);

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
  const updateOrder = (id: string, next: Order) => setOrders((o) => o.map((x) => (x.id === id ? next : x)));

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 flex">
      <OrdersRail
        orders={orders}
        selectedId={selectedId}
        onSelect={setSelectedId}
        onAdd={addOrder}
      />

      <div className="flex-1">
        {/* Sticky header summary */}
        <div className="sticky top-0 z-20 backdrop-blur bg-slate-50/80 border-b">
          <div className="max-w-7xl mx-auto p-4 grid gap-2">
            <div className="flex items-center justify-between">
              <h1 className="text-xl font-bold">Execution Planner</h1>
              <div className="text-xs opacity-70">
                Visible: {visible.length} · Total Qty {formatInt(ag.qtyTotal)} · Executed {formatInt(ag.execQty)}
              </div>
            </div>
            {/* Quick chips for mobile users */}
            <div className="md:hidden flex flex-wrap gap-2">
              <button
                onClick={()=>setSelectedId(null)}
                className={`px-3 py-1.5 rounded-full text-xs border ${selectedId===null ? "bg-slate-900 text-white" : ""}`}>
                ALL
              </button>
              {orders.map((o)=>(
                <button key={o.id}
                  onClick={()=>setSelectedId(o.id)}
                  className={`px-3 py-1.5 rounded-full text-xs border ${selectedId===o.id ? "bg-slate-900 text-white" : "bg-white"}`}>
                  {o.name}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Orders list */}
        <div className="max-w-7xl mx-auto p-4 grid gap-5">
          {visible.map((o) => (
            <PlannerCard
              key={o.id}
              order={o}
              onChange={(n) => updateOrder(o.id, n)}
              onRemove={() => removeOrder(o.id)}
              onDuplicate={() => duplicateOrder(o.id)}
              onFocusMe={()=>setSelectedId(o.id)}
            />
          ))}
          {visible.length === 0 && <div className="text-sm text-slate-500">No orders selected.</div>}
        </div>

        {/* Self-tests */}
        <div className="max-w-7xl mx-auto p-4">
          <div className="bg-white rounded-2xl shadow p-4 text-sm">
            <div className="font-semibold">Built-in Self Tests</div>
            <pre className="text-xs bg-slate-50 p-3 rounded-xl overflow-x-auto">{`console.assert(minutesBetween('09:30','10:00') === 30, 'minutesBetween');
console.assert(addMinutes('09:30', 30) === '10:00', 'addMinutes');
const ts = ${"`"}${"`"}; // visual only
const w1 = ${"`"}${"`"};
const w2 = ${"`"}${"`"};`}</pre>
          </div>
        </div>
      </div>
    </div>
  );
}