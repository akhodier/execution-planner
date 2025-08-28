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

  // core
  orderQty: number;
  execMode: ExecMode;
  capMode: CapMode;
  maxPart: number; // %
  reserveAuctionPct: number; // %
  deferCompletion: boolean;

  // session timings
  sessionStart: string;
  sessionEnd: string;
  auctionStart: string;
  auctionEnd: string;
  talStart: string;
  talEnd: string;

  intervalMins: number;
  curve: Curve;

  // volumes
  startVol: number;
  currentVol: number; // cum market volume
  expectedContVol: number;
  expectedAuctionVol: number;

  // vwap
  marketTurnover: number; // currency
  marketVWAPInput: number; // manual VWAP
  orderExecQty: number; // executed qty (user input)
  orderExecNotional: number;

  // presets
  market?: MarketKey;

  // history
  snapshots: Snapshot[];

  // ui
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
  const hh = Math.floor(((total % (24 * 60)) + 24 * 60) % (24 * 60) / 60);
  const mm = ((total % 60) + 60) % 60;
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
   Planning
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

/* ============================================================
   Pacing Engine (accum target up to NOW)
============================================================ */
function targetAccumByNow(plan: BuiltPlan, sessionStart: string, now: string) {
  // Sum full past slices + proportional of live slice
  let accum = 0;
  for (const r of plan.rows) {
    if (now >= r.e) {
      accum += r.suggestedQty;
    } else if (withinSlice(now, r.s, r.e)) {
      const sliceLen = Math.max(1, minutesBetween(r.s, r.e));
      const elapsed = Math.max(0, minutesBetween(r.s, now));
      const ratio = Math.min(1, Math.max(0, elapsed / sliceLen));
      accum += Math.floor(r.suggestedQty * ratio);
      break;
    } else if (now < r.s) {
      break;
    }
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
  const [draft, setDraft] = useState(formatInt(value));
  useEffect(()=>setDraft(formatInt(value)),[value]);
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
          setDraft(formatInt(n));
          onChange(n);
        }}
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
   Market Phase & Alerts
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
   Status HUD (Simple View)
============================================================ */
function StatusHUD({ order, plan, nowHHMMs }: { order: Order; plan: BuiltPlan; nowHHMMs: string; }) {
  const t = theme(order.side);
  const totalPlanned = plan.contPlanned + plan.auctionPlanned;

  const shouldAccum = useMemo(() => targetAccumByNow(plan, order.sessionStart, nowHHMMs), [plan, order.sessionStart, nowHHMMs]);
  const execAccum = order.orderExecQty;
  const delta = execAccum - shouldAccum;

  const completion = order.orderQty > 0 ? Math.min(100, Math.round((execAccum / order.orderQty) * 100)) : 0;

  const marketVWAP =
    order.currentVol > 0
      ? order.marketTurnover > 0
        ? order.marketTurnover / order.currentVol
        : order.marketVWAPInput || 0
      : order.marketVWAPInput || 0;
  const orderVWAP = order.orderExecQty > 0 ? order.orderExecNotional / order.orderExecQty : 0;
  const slippage = performanceBps(order.side, orderVWAP, marketVWAP);

  const pacingPct = shouldAccum > 0 ? ((execAccum - shouldAccum) / shouldAccum) * 100 : 0;
  const pacingTag =
    pacingPct > 8 ? "Ahead of schedule"
    : pacingPct < -8 ? "Behind schedule"
    : "On track";

  const pacingColor =
    pacingPct > 8 ? "text-green-600"
    : pacingPct < -8 ? "text-amber-600"
    : "text-slate-700";

  // Impact Score (quick risk gauge)
  const remaining = Math.max(0, order.orderQty - execAccum);
  const expRemainingVol = Math.max(1, (order.expectedContVol + order.expectedAuctionVol));
  const requiredPOV = remaining / expRemainingVol; // rough POV needed
  const impactScore = Math.min(10, Math.max(1, Math.round(requiredPOV * 10)));
  const impactColor =
    impactScore >= 8 ? "text-red-600" :
    impactScore >= 6 ? "text-amber-600" : "text-emerald-600";

  return (
    <div className="p-3 rounded-2xl bg-white border grid md:grid-cols-5 gap-3">
      <HeaderStat title="Should-Have Executed (Accum)" value={formatInt(shouldAccum)} />
      <HeaderStat title="Executed (Accum)" value={formatInt(execAccum)} />
      <HeaderStat title="Delta" value={<span className={pacingColor}>{(delta>0?"+":"") + formatInt(delta)}</span>} />
      <HeaderStat title="Slippage (bps)" value={<span className={slippage>0?"text-green-600":slippage<0?"text-red-600":"text-slate-700"}>{Number.isFinite(slippage)? slippage.toFixed(1):"—"}</span>} />
      <div className="p-3 rounded-xl bg-slate-100">
        <div className="opacity-60 text-xs">Completion</div>
        <div className="w-full h-2 rounded-full bg-white overflow-hidden mt-1">
          <div className={`h-2 ${t.strong}`} style={{ width: `${completion}%` }} />
        </div>
        <div className="text-xs mt-1">{completion}% — <span className={pacingColor}>{pacingTag}</span></div>
        <div className={`text-xs mt-1 ${impactColor}`}>Impact Score: {impactScore}/10</div>
      </div>
    </div>
  );
}

/* ============================================================
   Planner Card (per order)
============================================================ */
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
  const [nowClock, setNowClock] = useState(nowHHMMSS());
  const nowShort = nowClock.slice(0,5);

  useInterval(() => setNowClock(nowHHMMSS()), 10000); // refresh pacing every 10s

  // Apply market preset to this order only
  function applyMarket(m: MarketKey) {
    const p = MARKET_PRESET[m];
    onChange({
      ...order,
      market: m,
      sessionStart: p.start,
      sessionEnd: p.end,
      auctionStart: p.auction,
      auctionEnd: p.auctionMatch,
      talStart: p.talStart,
      talEnd: p.talEnd,
    });
  }

  const plan = useMemo(() => buildPlan(order), [order]);
  const totalPlanned = plan.contPlanned + plan.auctionPlanned;

  // Phase banner
  const phase = getPhase(order, nowShort);
  const phaseBanner = (() => {
    if (phase === "PRE") return { msg: `PRE-OPEN — session starts ${order.sessionStart}`, cls: "bg-slate-100" };
    if (phase === "CONT") {
      const minsLeft = minutesBetween(nowShort, order.sessionEnd);
      if (minsLeft <= 10 && minsLeft >= 0) return { msg: `Continuous ends in ${minsLeft} min`, cls: "bg-amber-50" };
      return { msg: "Continuous trading", cls: "bg-slate-100" };
    }
    if (phase === "AUCTION") return { msg: "AUCTION period — focus auction allocation", cls: "bg-violet-50" };
    if (phase === "TAL") return { msg: "TAL — trade at last window", cls: "bg-blue-50" };
    return { msg: "Closed", cls: "bg-slate-100" };
  })();

  // Critical alert (toast) conditions
  const shouldAccum = targetAccumByNow(plan, order.sessionStart, nowShort);
  const pacingDev = shouldAccum > 0 ? ((order.orderExecQty - shouldAccum) / shouldAccum) * 100 : 0;

  const nextSlice = plan.rows.find((r) => nowShort <= r.s) || plan.rows.find((r)=>withinSlice(nowShort, r.s, r.e));
  const capImminent = nextSlice && typeof nextSlice.maxAllowed === "number" && nextSlice.suggestedQty >= nextSlice.maxAllowed;

  const [toast, setToast] = useState<string | null>(null);
  useEffect(() => {
    if (pacingDev < -15) {
      setToast("⚠️ Pacing behind >15% — increase next clip or raise participation.");
      const id = setTimeout(()=>setToast(null), 4000);
      return () => clearTimeout(id);
    }
    if (capImminent) {
      setToast("⚠️ Cap binding imminent on next slice — consider raising cap slightly (+2–3%).");
      const id = setTimeout(()=>setToast(null), 4000);
      return () => clearTimeout(id);
    }
  }, [pacingDev, capImminent]);

  // Inline data integrity alerts
  const dataBadges: string[] = [];
  const marketVWAPImplied = order.currentVol>0 && order.marketTurnover>0 ? (order.marketTurnover/order.currentVol) : 0;
  if (!(order.marketVWAPInput > 0 || marketVWAPImplied > 0)) dataBadges.push("Missing market VWAP (turnover or manual)");
  if (order.currentVol === 0) dataBadges.push("Missing market volume");

  // Simple vs Advanced UI
  const simple = order.simpleMode ?? true;

  // CSV (advanced users)
  function downloadCSV() {
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
    const headers = Object.keys(base[0] || {});
    const esc = (v: any) => {
      const s = String(v ?? "");
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const csv = [headers.join(",")]
      .concat(base.map((r) => headers.map((h) => esc((r as any)[h])).join(",")))
      .join("\n");

    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `${order.symbol}_${order.side}_${order.execMode}_plan.csv`;
    a.click(); URL.revokeObjectURL(url);
  }

  return (
    <div className={`rounded-2xl shadow border ${t.border} bg-white overflow-hidden`}>
      {/* Header */}
      <div className={`px-4 py-3 border-b ${t.border} flex items-center justify-between`}>
        <div className="flex items-center gap-3">
          <span className={`inline-flex items-center px-2.5 py-1 rounded-full text-xs font-semibold ${t.bgSoft} ${t.text}`}>
            {order.side}
          </span>
          <div className="text-sm opacity-70">
            Local time: <span className="font-mono">{nowClock}</span>
          </div>
        </div>
        <div className="flex gap-2">
          <button onClick={downloadCSV} className="px-3 py-2 rounded-xl bg-slate-900 text-white text-sm">Export CSV</button>
          <button onClick={onDuplicate} className="px-3 py-2 rounded-xl border text-sm">Duplicate</button>
          <button onClick={onRemove} className="px-3 py-2 rounded-xl border text-sm">Remove</button>
        </div>
      </div>

      {/* Market state banner */}
      <div className={`px-4 py-2 text-sm ${phaseBanner.cls} border-b ${t.border}`}>
        {phaseBanner.msg}
      </div>

      {/* Critical toast */}
      {toast && (
        <div className="m-3 p-3 rounded-xl border text-sm bg-amber-50">
          {toast}
        </div>
      )}

      {/* Market preset & quick toggles */}
      <div className="px-4 py-2 flex flex-wrap items-center gap-2 text-sm">
        <span className="opacity-70">Market:</span>
        {(["Egypt","Kuwait","Qatar","DFM","ADX","Saudi"] as MarketKey[]).map((m) => (
          <button
            key={m}
            onClick={() => applyMarket(m)}
            className={`px-3 py-1.5 rounded-full border ${order.market===m ? "bg-slate-900 text-white" : "bg-white"}`}
          >
            {m}
          </button>
        ))}
        <span className="mx-2 h-6 w-px bg-slate-200" />
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={!!order.simpleMode}
            onChange={(e) => onChange({ ...order, simpleMode: e.target.checked })}
          />
          Simple view
        </label>
        {dataBadges.map((b, i) => (
          <span key={i} className={`ml-2 text-xs px-2.5 py-1 rounded-full border ${t.border} ${t.bgSoft} ${t.text}`}>
            {b}
          </span>
        ))}
      </div>

      {/* Pacing HUD (always visible) */}
      <div className="px-4 pb-3">
        <StatusHUD order={order} plan={plan} nowHHMMs={nowShort} />
      </div>

      {/* SIMPLE view: minimal inputs */}
      {simple && (
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
            <IntInput label="Order Qty (shares)" value={order.orderQty} onChange={(n)=>onChange({ ...order, orderQty: n })} />
            <label className="text-sm">
              Mode
              <select
                className="mt-1 w-full border rounded-xl p-2"
                value={order.execMode}
                onChange={(e)=>onChange({ ...order, execMode: e.target.value as ExecMode })}
              >
                <option value="OTD">OTD</option>
                <option value="INLINE">Inline (POV)</option>
              </select>
            </label>
          </div>
          <div className="space-y-3">
            <h3 className="font-semibold">Timing</h3>
            <div className="grid grid-cols-2 gap-3">
              <label className="text-sm">
                Start
                <input type="time" className="mt-1 w-full border rounded-xl p-2" value={order.sessionStart}
                  onChange={(e)=>onChange({ ...order, sessionStart: e.target.value })}/>
              </label>
              <label className="text-sm">
                End
                <input type="time" className="mt-1 w-full border rounded-xl p-2" value={order.sessionEnd}
                  onChange={(e)=>onChange({ ...order, sessionEnd: e.target.value })}/>
              </label>
            </div>
          </div>
          <div className="space-y-3">
            <h3 className="font-semibold">Live</h3>
            <IntInput label="Current Market Vol (cum)" value={order.currentVol} onChange={(n)=>onChange({ ...order, currentVol: n })}/>
            <IntInput label="Your Executed Qty (cum)" value={order.orderExecQty} onChange={(n)=>onChange({ ...order, orderExecQty: n })}/>
          </div>
        </div>
      )}

      {/* ADVANCED view: full control */}
      {!simple && (
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
              <select className="mt-1 w-full border rounded-xl p-2" value={order.side}
                onChange={(e)=>onChange({ ...order, side: e.target.value as Side })}>
                <option value="BUY">BUY</option>
                <option value="SELL">SELL</option>
              </select>
            </label>
            <IntInput label="Order Qty (shares)" value={order.orderQty} onChange={(n)=>onChange({ ...order, orderQty: n })}/>
            <label className="text-sm">
              Execution Mode
              <select className="mt-1 w-full border rounded-xl p-2" value={order.execMode}
                onChange={(e)=>onChange({ ...order, execMode: e.target.value as ExecMode })}>
                <option value="OTD">OTD (time-sliced)</option>
                <option value="INLINE">Inline (POV)</option>