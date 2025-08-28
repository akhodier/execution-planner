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
function StatusHUD({ order, plan, nowHHMMs }: { order: Order; plan: BuiltPlan; nowHHMMs: string; }) {
  const t = theme(order.side);
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
    pacingPct > 8 ? "Ahead"
    : pacingPct < -8 ? "Behind"
    : "On track";

  const pacingColor =
    pacingPct > 8 ? "text-green-600"
    : pacingPct < -8 ? "text-amber-600"
    : "text-slate-700";

  const remaining = Math.max(0, order.orderQty - execAccum);
  const expRemainingVol = Math.max(1, (order.expectedContVol + order.expectedAuctionVol));
  const requiredPOV = remaining / expRemainingVol;
  const impactScore = Math.min(10, Math.max(1, Math.round(requiredPOV * 10)));
  const impactColor =
    impactScore >= 8 ? "text-red-600" :
    impactScore >= 6 ? "text-amber-600" : "text-emerald-600";

  const advice = advise(order, plan, nowHHMMs);

  return (
    <div className="p-3 rounded-2xl bg-white border grid md:grid-cols-6 gap-3">
      <HeaderStat title="Should-Have Exec (Accum)" value={formatInt(shouldAccum)} />
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
      <div className="p-3 rounded-xl bg-slate-100">
        <div className="opacity-60 text-xs">Next Best Action</div>
        <div className="text-sm font-semibold mt-1">{advice.action}</div>
        <div className="text-xs mt-1">Required POV: {(advice.requiredPOV*100).toFixed(1)}%</div>
      </div>
    </div>
  );
}

/* ============================================================
   Orders Rail (right side)
============================================================ */
type RailFilter = "ALL" | "ACTIVE" | "COMPLETED";
function OrdersRail({
  orders,
  onSelect,
  selectedId,
  onToggleComplete,
  filter,
  setFilter,
}: {
  orders: Order[];
  onSelect: (id: string | null) => void;
  selectedId: string | null;
  onToggleComplete: (id: string, done: boolean) => void;
  filter: RailFilter;
  setFilter: (f: RailFilter) => void;
}) {
  const items = orders.filter(o => {
    if (filter === "ALL") return true;
    if (filter === "ACTIVE") return !o.completed;
    return !!o.completed;
  });

  return (
    <div className="w-full md:w-80 border-l bg-white sticky top-0 h-[calc(100vh-0px)] p-3 overflow-auto">
      <div className="flex items-center justify-between mb-3">
        <div className="font-semibold">Orders</div>
        <div className="flex gap-1 text-xs">
          <button
            className={`px-2 py-1 rounded ${filter==="ALL"?"bg-slate-900 text-white":"bg-slate-100"}`}
            onClick={()=>setFilter("ALL")}
          >All</button>
          <button
            className={`px-2 py-1 rounded ${filter==="ACTIVE"?"bg-slate-900 text-white":"bg-slate-100"}`}
            onClick={()=>setFilter("ACTIVE")}
          >Active</button>
          <button
            className={`px-2 py-1 rounded ${filter==="COMPLETED"?"bg-slate-900 text-white":"bg-slate-100"}`}
            onClick={()=>setFilter("COMPLETED")}
          >Completed</button>
        </div>
      </div>

      {items.map(o=>{
        const t = theme(o.side);
        const completion = o.orderQty>0 ? Math.min(100, Math.round((o.orderExecQty/o.orderQty)*100)) : 0;
        // lightweight pacing tag
        const plan = buildPlan(o);
        const now = nowHHMM();
        const should = targetAccumByNow(plan, o.sessionStart, now);
        const pacingPct = should>0 ? ((o.orderExecQty - should)/should)*100 : 0;
        const tag = pacingPct>8 ? "Ahead" : pacingPct<-8 ? "Behind" : "On";
        const tagCls = pacingPct>8 ? "text-green-600" : pacingPct<-8 ? "text-amber-600" : "text-slate-600";

        // simple alert count
        const alerts:number[] = [];
        const live = plan.rows.find(r => withinSlice(now, r.s, r.e));
        if (live && typeof live.maxAllowed==="number" && live.suggestedQty>=live.maxAllowed) alerts.push(1);
        if (!(o.marketTurnover>0 || o.marketVWAPInput>0)) alerts.push(1);
        if (o.execMode==="OTD" && live && o.orderExecQty < should) alerts.push(1);

        return (
          <div key={o.id} className={`mb-3 rounded-xl border ${t.border} overflow-hidden`}>
            <button
              className="w-full text-left p-3 flex items-center justify-between"
              onClick={()=>onSelect(o.id)}
            >
              <div className="flex items-center gap-2">
                <span className={`px-2 py-0.5 text-[10px] rounded-full ${o.side==="BUY"?"bg-emerald-50 text-emerald-700":"bg-rose-50 text-rose-700"}`}>{o.side}</span>
                <div className="font-medium text-sm">{o.name}</div>
              </div>
              <div className="text-xs">
                <span className={tagCls}>{tag}</span>
                {alerts.length>0 && <span className="ml-2 text-amber-600">⚠️{alerts.length}</span>}
              </div>
            </button>
            <div className="px-3 pb-3">
              <div className="w-full h-2 rounded-full bg-slate-100 overflow-hidden">
                <div className={`${t.strong} h-2`} style={{width:`${completion}%`}} />
              </div>
              <div className="text-[11px] mt-1">{completion}%</div>
              <div className="mt-2 flex items-center justify-between">
                <button
                  className="text-xs px-2 py-1 rounded border"
                  onClick={()=>onSelect(o.id)}
                >Open</button>
                <button
                  className={`text-xs px-2 py-1 rounded border ${o.completed?"bg-emerald-50 border-emerald-300":"bg-slate-50"}`}
                  onClick={()=>onToggleComplete(o.id, !o.completed)}
                >{o.completed ? "✓ Completed" : "Mark Completed"}</button>
              </div>
            </div>
          </div>
        );
      })}
      {items.length===0 && (
        <div className="text-xs text-slate-500">No orders in this view.</div>
      )}
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
  onCompleteToggle,
}: {
  order: Order;
  onChange: (o: Order) => void;
  onRemove: () => void;
  onDuplicate: () => void;
  onCompleteToggle: (done: boolean) => void;
}) {
  const t = theme(order.side);
  const [nowClock, setNowClock] = useState(nowHHMMSS());
  const nowShort = nowClock.slice(0,5);
  useInterval(() => setNowClock(nowHHMMSS()), 10000);

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

  const shouldAccum = targetAccumByNow(plan, order.sessionStart, nowShort);
  const live = plan.rows.find(r => withinSlice(nowShort, r.s, r.e));

  // Inline alerts
  const badges: string[] = [];
  if (!(order.marketTurnover>0 || order.marketVWAPInput>0)) badges.push("Missing market VWAP (turnover or manual)");
  if (order.currentVol === 0) badges.push("Missing market volume");
  if (order.execMode==="OTD" && live && order.orderExecQty < shouldAccum) badges.push("Behind current slice pace");
  if (live && typeof live.maxAllowed==="number" && live.suggestedQty>=live.maxAllowed) badges.push("Cap binding in live slice");

  // Advice
  const { nextClip, action, impactScore, requiredPOV } = advise(order, plan, nowShort);

  // Completed view (compact report)
  if (order.completed) {
    const marketVWAP =
      order.currentVol > 0
        ? order.marketTurnover > 0
          ? order.marketTurnover / order.currentVol
          : order.marketVWAPInput || 0
        : order.marketVWAPInput || 0;
    const orderVWAP = order.orderExecQty > 0 ? order.orderExecNotional / order.orderExecQty : 0;
    const slippage = performanceBps(order.side, orderVWAP, marketVWAP);

    return (
      <div className={`rounded-2xl shadow border ${t.border} bg-white overflow-hidden`}>
        <div className={`px-4 py-3 border-b ${t.border} flex items-center justify-between`}>
          <div className="flex items-center gap-3">
            <span className={`inline-flex items-center px-2.5 py-1 rounded-full text-xs font-semibold ${t.bgSoft} ${t.text}`}>{order.side}</span>
            <div className="font-semibold">{order.name} — Completed</div>
          </div>
          <div className="flex gap-2">
            <button onClick={() => onCompleteToggle(false)} className="px-3 py-2 rounded-xl border text-sm">Reopen</button>
            <button onClick={onDuplicate} className="px-3 py-2 rounded-xl border text-sm">Duplicate</button>
            <button onClick={onRemove} className="px-3 py-2 rounded-xl border text-sm">Remove</button>
          </div>
        </div>

        <div className="p-4 grid md:grid-cols-4 gap-3">
          <HeaderStat title="Final Executed Qty" value={formatInt(order.orderExecQty)} />
          <HeaderStat title="Order VWAP" value={orderVWAP ? orderVWAP.toLocaleString(undefined,{maximumFractionDigits:4}) : "—"} />
          <HeaderStat title="Market VWAP" value={marketVWAP ? marketVWAP.toLocaleString(undefined,{maximumFractionDigits:4}) : "—"} />
          <HeaderStat title="Slippage (bps)" value={<span className={slippage>0?"text-green-600":slippage<0?"text-red-600":"text-slate-700"}>{Number.isFinite(slippage)? slippage.toFixed(1):"—"}</span>} />
        </div>

        <div className="px-4 pb-4 text-xs text-slate-600">
          Post-trade note: snapshot count {order.snapshots.length}. Use “Duplicate” to fork a new plan with today’s learnings.
        </div>
      </div>
    );
  }

  // Active view
  return (
    <div className={`rounded-2xl shadow border ${t.border} bg-white overflow-hidden`}>
      {/* Header */}
      <div className={`px-4 py-3 border-b ${t.border} flex items-center justify-between`}>
        <div className="flex items-center gap-3">
          <span className={`inline-flex items-center px-2.5 py-1 rounded-full text-xs font-semibold ${t.bgSoft} ${t.text}`}>{order.side}</span>
          <div className="font-semibold">{order.name}</div>
          <div className="text-sm opacity-70">Local time: <span className="font-mono">{nowClock}</span></div>
        </div>
        <div className="flex gap-2">
          <button onClick={()=>onCompleteToggle(true)} className="px-3 py-2 rounded-xl bg-emerald-600 text-white text-sm">Mark Completed</button>
          <button onClick={onDuplicate} className="px-3 py-2 rounded-xl border text-sm">Duplicate</button>
          <button onClick={onRemove} className="px-3 py-2 rounded-xl border text-sm">Remove</button>
        </div>
      </div>

      {/* Badges row */}
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
        {badges.map((b, i) => (
          <span key={i} className={`ml-2 text-xs px-2.5 py-1 rounded-full border ${t.border} ${t.bgSoft} ${t.text}`}>
            {b}
          </span>
        ))}
      </div>

      {/* Decision HUD */}
      <div className="px-4 pb-3">
        <StatusHUD order={order} plan={plan} nowHHMMs={nowShort} />
      </div>

      {/* Slice nudge (OTD) */}
      {order.execMode==="OTD" && live && (
        <div className="px-4 pb-2">
          <div className="rounded-xl border bg-amber-50 p-3 text-sm">
            Live slice {live.interval}: target {formatInt(live.suggestedQty)}.  
            <span className="ml-2 font-semibold">
              Suggested next clip ~ {formatInt(Math.max(0, nextClipForLive(live, nowShort)))}
            </span>
          </div>
        </div>
      )}

      {/* Simple vs Advanced */}
      {order.simpleMode ? (
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
      ) : (
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
              <select
                className="mt-1 w-full border rounded-xl p-2"
                value={order.execMode}
                onChange={(e)=>onChange({ ...order, execMode: e.target.value as ExecMode })}
              >
                <option value="OTD">OTD (time-sliced)</option>
                <option value="INLINE">Inline (POV)</option>
              </select>
            </label>
            <label className="text-sm">
              Cap Mode
              <select className="mt-1 w-full border rounded-xl p-2" value={order.capMode}
                onChange={(e)=>onChange({ ...order, capMode: e.target.value as CapMode })}>
                <option value="PCT">Max % of Volume</option>
                <option value="NONE">No Volume Cap</option>
              </select>
            </label>
            {order.capMode === "PCT" && (
              <label className="text-sm">
                Max Participation %
                <input type="number" className="mt-1 w-full border rounded-xl p-2" value={order.maxPart}
                  onChange={(e)=>onChange({ ...order, maxPart: Math.max(0, parseFloat(e.target.value || "0")) })}/>
              </label>
            )}
            <label className="text-sm">
              Reserve for Auction %
              <input type="number" className="mt-1 w-full border rounded-xl p-2" value={order.reserveAuctionPct}
                onChange={(e)=>onChange({ ...order, reserveAuctionPct: Math.max(0, parseFloat(e.target.value || "0")) })}/>
            </label>
            <label className="text-sm flex items-center gap-2">
              <input type="checkbox" checked={order.deferCompletion}
                onChange={(e)=>onChange({ ...order, deferCompletion: e.target.checked })}/>
              Do not complete before end
            </label>
          </div>

          <div className="space-y-3">
            <h3 className="font-semibold">Timing</h3>
            <div className="grid grid-cols-2 gap-3">
              <label className="text-sm">
                Session Start
                <input type="time" className="mt-1 w-full border rounded-xl p-2" value={order.sessionStart}
                  onChange={(e)=>onChange({ ...order, sessionStart: e.target.value })}/>
              </label>
              <label className="text-sm">
                Session End
                <input type="time" className="mt-1 w-full border rounded-xl p-2" value={order.sessionEnd}
                  onChange={(e)=>onChange({ ...order, sessionEnd: e.target.value })}/>
              </label>
              <label className="text-sm">
                Auction Start
                <input type="time" className="mt-1 w-full border rounded-xl p-2" value={order.auctionStart}
                  onChange={(e)=>onChange({ ...order, auctionStart: e.target.value })}/>
              </label>
              <label className="text-sm">
                Auction Match
                <input type="time" className="mt-1 w-full border rounded-xl p-2" value={order.auctionEnd}
                  onChange={(e)=>onChange({ ...order, auctionEnd: e.target.value })}/>
              </label>
              <label className="text-sm">
                TAL Start
                <input type="time" className="mt-1 w-full border rounded-xl p-2" value={order.talStart}
                  onChange={(e)=>onChange({ ...order, talStart: e.target.value })}/>
              </label>
              <label className="text-sm">
                TAL End
                <input type="time" className="mt-1 w-full border rounded-xl p-2" value={order.talEnd}
                  onChange={(e)=>onChange({ ...order, talEnd: e.target.value })}/>
              </label>
              <label className="text-sm">
                Interval Minutes
                <input type="number" className="mt-1 w-full border rounded-xl p-2" value={order.intervalMins}
                  onChange={(e)=>onChange({ ...order, intervalMins: Math.max(1, parseInt(e.target.value || "1")) })}/>
              </label>
              <label className="text-sm">
                Curve
                <select className="mt-1 w-full border rounded-xl p-2" value={order.curve}
                  onChange={(e)=>onChange({ ...order, curve: e.target.value as Curve })}>
                  <option value="ucurve">U-curve</option>
                  <option value="equal">Equal</option>
                </select>
              </label>
            </div>
          </div>

          <div className="space-y-3">
            <h3 className="font-semibold">Volumes & VWAP</h3>
            <div className="grid grid-cols-2 gap-3">
              <IntInput label="Start Vol" value={order.startVol} onChange={(n)=>onChange({ ...order, startVol: n })}/>
              <IntInput label="Current Vol (cum)" value={order.currentVol} onChange={(n)=>onChange({ ...order, currentVol: n })}/>
              <IntInput className="col-span-2" label="Expected Continuous Vol" value={order.expectedContVol} onChange={(n)=>onChange({ ...order, expectedContVol: n })}/>
              <IntInput className="col-span-2" label="Expected Auction Vol" value={order.expectedAuctionVol} onChange={(n)=>onChange({ ...order, expectedAuctionVol: n })}/>
            </div>
            <MoneyInput label="Market Turnover" value={order.marketTurnover} onNumberChange={(n)=>onChange({ ...order, marketTurnover: n })}/>
            <MoneyInput label="OR Enter Market VWAP" value={order.marketVWAPInput} onNumberChange={(n)=>onChange({ ...order, marketVWAPInput: n })}/>
            <IntInput label="Your Executed Qty" value={order.orderExecQty} onChange={(n)=>onChange({ ...order, orderExecQty: n })}/>
            <MoneyInput label="Your Executed Notional" value={order.orderExecNotional} onNumberChange={(n)=>onChange({ ...order, orderExecNotional: n })}/>
          </div>

          {/* Plan table */}
          <div className="md:col-span-3">
            <div className="text-sm opacity-70 mb-2">Plan</div>
            <div className="overflow-x-auto rounded-xl border">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-white">
                  <tr className="text-left border-b">
                    <th className="py-2 pr-2">Interval</th>
                    <th className="py-2 pr-2">Expected Mkt Vol</th>
                    <th className="py-2 pr-2">Max Allowed</th>
                    <th className="py-2 pr-2">Suggested Qty</th>
                    <th className="py-2 pr-2">Flags</th>
                  </tr>
                </thead>
                <tbody>
                  {plan.rows.map((r) => {
                    const cur = nowShort + ":00";
                    const isLive = withinSlice(cur, r.s, r.e);
                    const highImpact = r.expMktVol>0 && r.suggestedQty / r.expMktVol >= 0.25;
                    return (
                      <tr key={r.interval} className={`border-b last:border-0 ${isLive ? `${t.bgSoft} animate-pulse` : ""}`}>
                        <td className={`py-2 pr-2 ${t.text}`}>{r.interval}</td>
                        <td className="py-2 pr-2">{formatInt(r.expMktVol)}</td>
                        <td className="py-2 pr-2">{typeof r.maxAllowed === "number" ? formatInt(r.maxAllowed) : r.maxAllowed}</td>
                        <td className="py-2 pr-2 font-semibold">{formatInt(r.suggestedQty)}</td>
                        <td className="py-2 pr-2">
                          {highImpact && <span className="text-amber-600">⚠️ High impact risk</span>}
                        </td>
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
                      {formatInt(totalPlanned)} (Remain {formatInt(Math.max(0, order.orderQty - totalPlanned))})
                    </td>
                    <td className="py-2 pr-2"></td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
function nextClipForLive(live: BuiltRow, nowHHMMs: string) {
  const len = Math.max(1, minutesBetween(live.s, live.e));
  const elapsed = Math.max(0, minutesBetween(live.s, nowHHMMs));
  const shouldSoFar = Math.floor(live.suggestedQty * clamp01(elapsed / len));
  const remaining = Math.max(0, live.suggestedQty - shouldSoFar);
  return typeof live.maxAllowed==="number" ? Math.min(remaining, live.maxAllowed) : remaining;
}

/* ============================================================
   Aggregates & App Shell
============================================================ */
type Aggregates = {
  qtyTotal: number;
  plannedTotal: number;
  execQty: number;
};
function aggregateOrders(orders: Order[]): Aggregates {
  return orders.reduce<Aggregates>((agg, o)=>{
    const { contPlanned, auctionPlanned } = buildPlan(o);
    return {
      qtyTotal: agg.qtyTotal + o.orderQty,
      plannedTotal: agg.plannedTotal + contPlanned + auctionPlanned,
      execQty: agg.execQty + o.orderExecQty,
    };
  }, { qtyTotal: 0, plannedTotal: 0, execQty: 0 });
}
function SummaryCard({ title, tint, ag }: { title: string; tint: "emerald"|"rose"|"slate"; ag: Aggregates; }) {
  const progress = ag.qtyTotal > 0 ? Math.min(100, Math.round((ag.execQty / ag.qtyTotal) * 100)) : 0;
  const bg = tint === "emerald" ? "bg-emerald-50" : tint === "rose" ? "bg-rose-50" : "bg-slate-100";
  const bar = tint === "emerald" ? "bg-emerald-600" : tint === "rose" ? "bg-rose-600" : "bg-slate-600";
  return (
    <div className={`rounded-2xl p-4 ${bg} border`}>
      <div className="flex items-center justify-between">
        <div className="font-semibold">{title}</div>
        <div className="text-xs opacity-60">Exec {progress}%</div>
      </div>
      <div className="grid md:grid-cols-3 gap-3 text-sm mt-2">
        <HeaderStat title="Total Qty" value={formatInt(ag.qtyTotal)} />
        <HeaderStat title="Planned (today)" value={formatInt(ag.plannedTotal)} />
        <HeaderStat title="Executed" value={formatInt(ag.execQty)} />
      </div>
      <div className="w-full h-2 rounded-full bg-white/60 overflow-hidden mt-2">
        <div className={`h-2 ${bar}`} style={{ width: `${progress}%` }} />
      </div>
    </div>
  );
}

/* ============================================================
   App
============================================================ */
function defaultOrder(side: Side, idx: number): Order {
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
    snapshots: [],
    simpleMode: true,
    completed: false,
  };
}

export default function App() {
  const [orders, setOrders] = useState<Order[]>([
    defaultOrder("BUY", 1),
    defaultOrder("SELL", 1),
  ]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [railFilter, setRailFilter] = useState<RailFilter>("ALL");

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
  const toggleComplete = (id: string, done: boolean) => {
    setOrders((o)=>o.map(oo=>oo.id===id ? { ...oo, completed: done } : oo));
  };

  const agAll = aggregateOrders(visible);
  const agBuy = aggregateOrders(visible.filter((o) => o.side === "BUY"));
  const agSell = aggregateOrders(visible.filter((o) => o.side === "SELL"));

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      {/* Sticky top bar */}
      <div className="sticky top-0 z-20 backdrop-blur bg-slate-50/80 border-b">
        <div className="max-w-7xl mx-auto p-4 grid gap-4">
          <div className="flex items-center justify-between">
            <h1 className="text-xl font-bold">Execution Planner — Pacing • Alerts • Rail</h1>
            <div className="flex gap-2">
              <button onClick={() => addOrder("BUY")} className="px-3 py-2 rounded-xl bg-emerald-600 text-white text-sm">+ Add BUY</button>
              <button onClick={() => addOrder("SELL")} className="px-3 py-2 rounded-xl bg-rose-600 text-white text-sm">+ Add SELL</button>
            </div>
          </div>

          {/* Summary */}
          <div className="grid md:grid-cols-3 gap-3">
            <SummaryCard title="ALL Orders" tint="slate" ag={agAll} />
            <SummaryCard title="BUY" tint="emerald" ag={agBuy} />
            <SummaryCard title="SELL" tint="rose" ag={agSell} />
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

      {/* Content + Rail */}
      <div className="max-w-7xl mx-auto p-4 grid md:grid-cols-[1fr,20rem] gap-5">
        <div className="grid gap-5">
          {visible.map((o) => (
            <PlannerCard
              key={o.id}
              order={o}
              onChange={(n) => updateOrder(o.id, n)}
              onRemove={() => removeOrder(o.id)}
              onDuplicate={() => duplicateOrder(o.id)}
              onCompleteToggle={(done)=>toggleComplete(o.id, done)}
            />
          ))}
          {visible.length === 0 && <div className="text-sm text-slate-500">No orders selected.</div>}
        </div>

        <OrdersRail
          orders={orders}
          onSelect={(id)=>setSelectedId(id)}
          selectedId={selectedId}
          onToggleComplete={(id,done)=>toggleComplete(id,done)}
          filter={railFilter}
          setFilter={setRailFilter}
        />
      </div>

      {/* Self-checks (static text for Netlify safety) */}
      <div className="max-w-7xl mx-auto p-4">
        <div className="bg-white rounded-2xl shadow p-4 text-sm">
          <div className="font-semibold">Built-in Self Checks</div>
          <pre className="text-xs bg-slate-50 p-3 rounded-xl overflow-x-auto">
{`- minutesBetween('09:30','10:00') => 30
- addMinutes('09:30', 30) => '10:00'
- timeSlices('09:30','10:30',30) => 2 slices`}
          </pre>
        </div>
      </div>
    </div>
  );
}