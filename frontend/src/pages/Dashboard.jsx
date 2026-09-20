import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Users, TrendingUp, CalendarClock, IndianRupee, Target, CheckCircle2, Trophy,
  AlertTriangle, Phone, PhoneCall, CheckSquare, Send, ArrowRight, Wallet,
  LifeBuoy, Medal, ChevronRight, ArrowUpRight, ArrowDownRight, StickyNote, Mail,
} from 'lucide-react';
import { api } from '../api';
// recharts is heavy, so the charts load as a separate chunk after the rest
// of the Dashboard has painted. See DashboardCharts.jsx.
const StageDonut = lazy(() => import('./DashboardCharts').then((m) => ({ default: m.StageDonut })));
const RevenueArea = lazy(() => import('./DashboardCharts').then((m) => ({ default: m.RevenueArea })));

// Holds the chart's footprint while its chunk arrives, so the cards around
// it don't jump once it renders.
function ChartFrame({ height, children }) {
  return (
    <Suspense
      fallback={(
        <div
          className="w-full rounded-xl bg-slate-100/70 dark:bg-slate-700/30 animate-pulse"
          style={{ height }}
          aria-busy="true"
        />
      )}
    >
      {children}
    </Suspense>
  );
}

import { friendlyError, Badge } from '../components/ui';
import { useAuth } from '../context/AuthContext';

const inr = (n) => `₹${Number(n || 0).toLocaleString('en-IN')}`;

// Compact money for places where the full figure would wrap — ₹44.9L rather
// than ₹44,90,543. Indian units (lakh/crore), because this is an Indian
// product and "4.5M" is not how anyone here reads a number.
function inrShort(n) {
  const v = Number(n || 0);
  if (v >= 10000000) return `₹${(v / 10000000).toFixed(2)}Cr`;
  if (v >= 100000) return `₹${(v / 100000).toFixed(2)}L`;
  if (v >= 1000) return `₹${(v / 1000).toFixed(1)}K`;
  return `₹${Math.round(v)}`;
}

// "2h ago" / "Yesterday" / "12 Sep" — an activity feed without times reads
// as a list of nouns rather than a history, which is what made the old one
// feel arbitrary.
function relativeTime(value) {
  if (!value) return '';
  const then = new Date(String(value).replace(' ', 'T'));
  if (Number.isNaN(then.getTime())) return '';
  const mins = Math.round((Date.now() - then.getTime()) / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  if (days === 1) return 'Yesterday';
  if (days < 7) return `${days}d ago`;
  return then.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
}

// Counts a numeric KPI up from 0 on mount rather than popping in already at
// its final value — a small thing, but it's the difference between a
// dashboard that looks alive and one that looks like a printed report. Only
// touches values that are actually plain numbers (or a rupee/plain string
// wrapping one); anything else — "—", a percentage already formatted — is
// shown as-is on the first render and never animated, since counting up
// through text you can't parse would just flicker.
function useCountUp(value, duration = 900) {
  const [display, setDisplay] = useState(value);
  const prev = useRef();
  const frame = useRef();

  useEffect(() => {
    const match = typeof value === 'string' ? value.match(/^(₹?)([\d,]+(?:\.\d+)?)(%?)$/) : null;
    const numeric = typeof value === 'number' ? value : (match ? Number(match[2].replace(/,/g, '')) : null);
    if (numeric === null || Number.isNaN(numeric) || prev.current === value) { setDisplay(value); return; }
    prev.current = value;
    const prefix = match ? match[1] : '';
    const suffix = match ? match[3] : '';
    const decimals = (match && match[2].includes('.')) ? match[2].split('.')[1].length : 0;
    const start = performance.now();
    cancelAnimationFrame(frame.current);
    const tick = (now) => {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - (1 - t) ** 3; // ease-out cubic — fast start, gentle settle
      const current = numeric * eased;
      const formatted = decimals ? current.toFixed(decimals) : Math.round(current).toLocaleString('en-IN');
      setDisplay(`${prefix}${formatted}${suffix}`);
      if (t < 1) frame.current = requestAnimationFrame(tick);
    };
    frame.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  return display;
}

// ---------------------------------------------------------------------------
// The accent set. Every colour on this page comes from here — each entry is
// one accent from the palette with its own light surface, so "orange" always
// means the same orange on the same tint wherever it appears.
//
// The icon chip is a LIGHT tint with a coloured glyph, not a saturated
// gradient tile with a white glyph. Five gradient tiles in a row is the
// single thing that made the old KPI strip read as consumer rather than
// enterprise: it put the loudest element on the card next to the number it
// was supposed to be supporting.
// ---------------------------------------------------------------------------
const COLORS = {
  purple:  { c: '#6C4FF7', soft: '#F0EDFF', rgb: '108, 79, 247' },
  blue:    { c: '#3B82F6', soft: '#EFF6FF', rgb: '59, 130, 246' },
  teal:    { c: '#14B8A6', soft: '#ECFDF9', rgb: '20, 184, 166' },
  emerald: { c: '#10B981', soft: '#ECFDF5', rgb: '16, 185, 129' },
  amber:   { c: '#F59E0B', soft: '#FFFBEB', rgb: '245, 158, 11' },
  rose:    { c: '#F43F5E', soft: '#FFF1F2', rgb: '244, 63, 94' },
  violet:  { c: '#8B5CF6', soft: '#F5F3FF', rgb: '139, 92, 246' },
};
const TONE_TO_COLOR = { success: 'emerald', danger: 'rose', warning: 'amber', info: 'blue', special: 'purple', neutral: 'teal' };

// Trend deltas as a tinted pill rather than loose coloured text — green on a
// green surface for up, red on red for down. Same treatment everywhere a
// delta appears.
function TrendPill({ trend, sub }) {
  if (!trend && !sub) return null;
  if (!trend) return <span className="text-[11px] text-[var(--color-faint)]">{sub}</span>;
  const up = trend.dir !== 'down';
  return (
    <span className="inline-flex items-center gap-1 text-[11px] font-semibold px-1.5 py-px rounded-md"
      style={{
        color: up ? 'var(--color-success)' : 'var(--color-danger)',
        background: up ? 'var(--color-success-soft)' : 'var(--color-danger-soft)',
      }}>
      {up ? <ArrowUpRight className="w-3 h-3" /> : <ArrowDownRight className="w-3 h-3" />}
      {trend.text}
    </span>
  );
}

function KpiCard({ label, value, sub, trend, icon: Icon, color, tone, to, index = 0 }) {
  const p = color || COLORS[TONE_TO_COLOR[tone]] || COLORS.purple;
  const animated = useCountUp(value);
  const body = (
    <div
      className="dash-card dash-glow relative px-3.5 py-2.5 overflow-hidden h-full dash-enter group"
      style={{ '--accent-rgb': p.rgb, '--stagger': `${index * 50}ms` }}
    >
      {/* The micro-glow: one very soft radial in the card's accent, at 10%,
          with an explicit radius so it stays a highlight in the corner. Left
          to default to farthest-corner it grew with the card and tinted the
          whole surface, which is the opposite of "do not make it obvious". */}
      <div aria-hidden="true" className="dash-kpi-wash absolute inset-0 pointer-events-none" />

      <div className="relative flex items-start justify-between gap-2 mb-1.5">
        <div className="w-[30px] h-[30px] rounded-[10px] flex items-center justify-center shrink-0"
          style={{ background: p.soft, color: p.c }}>
          {Icon && <Icon className="w-4 h-4" strokeWidth={2} />}
        </div>
        {/* Only drawn when the card actually goes somewhere, so a card that
            can't be opened never advertises that it can. */}
        {to && (
          <ChevronRight className="w-4 h-4 shrink-0 transition-all group-hover:translate-x-0.5"
            style={{ color: 'var(--color-disabled)' }} />
        )}
      </div>
      <div className="relative text-[11.5px] font-medium leading-none" style={{ color: 'var(--color-muted)' }}>{label}</div>
      <div className="dash-figure relative text-[22px] font-bold mt-1 leading-none tabular-nums" style={{ fontFamily: 'var(--font-display)' }}>
        {animated}
      </div>
      {/* Rendered only when there is something to say. Every card in a given
          row either has a delta or doesn't, so the row stays level without
          reserving empty space on the cards that don't. */}
      {(trend || sub) && (
        <div className="relative mt-1.5 flex items-center">
          <TrendPill trend={trend} sub={sub} />
        </div>
      )}
    </div>
  );
  return to ? <Link to={to} className="block h-full">{body}</Link> : body;
}


// Formats a backend trend object for display. Deliberately returns null
// when the delta is zero or the backend couldn't compute an honest
// comparison — an empty space says less-but-true, where "0%" implies a
// measurement that didn't really happen.
function formatTrend(trend) {
  if (!trend || trend.delta === null || trend.delta === undefined) return null;
  const d = trend.delta;
  if (d === 0) return null;
  const sign = d > 0 ? '+' : '';
  const text = trend.unit === 'percent' ? `${sign}${d}% ${trend.label}` : `${sign}${d} ${trend.label}`;
  return { dir: d > 0 ? 'up' : 'down', text };
}

// One section header pattern, used by every section without exception:
// a 3×16px purple tick, then the title. Consistency here is most of what
// makes a page scan as a system rather than a stack of panels.
function SectionLabel({ children, action }) {
  return (
    <div className="flex items-center justify-between gap-3 mt-5 mb-2.5">
      <h2 className="text-[14px] font-bold flex items-center gap-2" style={{ color: 'var(--color-ink)' }}>
        <span className="w-[3px] h-4 rounded-[3px] shrink-0" style={{ background: 'var(--color-brand)' }} />
        {children}
      </h2>
      {action}
    </div>
  );
}

// Shared shell for every panel that isn't a KPI: title row, optional
// "view all", body, and — critically — a HEIGHT. Every list on this page
// is capped rather than free-running, so a CRM with 66 tasks due renders
// exactly as tall as one with 3. Without this the tallest list dictated
// the height of its whole grid row, which is what made the momentum panel
// stretch further down the page every time more records were added.
function Panel({ title, subtitle, icon: Icon, accent = COLORS.purple, count, action, height, index = 0, children }) {
  return (
    <div className="dash-card dash-glow relative overflow-hidden p-4 flex flex-col dash-enter"
      style={{ '--accent-rgb': accent.rgb, '--stagger': `${index * 60}ms`, height }}>
      <div className="flex items-center justify-between gap-2 shrink-0">
        <h3 className="flex items-center gap-2 min-w-0 text-[13px] font-semibold" style={{ color: 'var(--color-ink)' }}>
          {Icon && (
            <span className="w-7 h-7 rounded-[9px] flex items-center justify-center shrink-0"
              style={{ background: accent.soft, color: accent.c }}>
              <Icon className="w-[15px] h-[15px]" strokeWidth={2} />
            </span>
          )}
          <span className="truncate">{title}</span>
          {count > 0 && (
            <span className="text-[11px] font-semibold px-1.5 py-0.5 rounded-md shrink-0 tabular-nums"
              style={{ background: accent.soft, color: accent.c }}>{count}</span>
          )}
        </h3>
        {action}
      </div>
      {subtitle && <p className="text-[11px] mt-1 mb-2.5 shrink-0" style={{ color: 'var(--color-faint)' }}>{subtitle}</p>}
      {!subtitle && <div className="h-2.5 shrink-0" />}
      {children}
    </div>
  );
}

// The "view all" affordance in a panel header. Muted until hovered, so it
// never competes with the panel's own title.
function ViewAll({ to }) {
  return (
    <Link to={to}
      className="text-[11px] font-semibold shrink-0 flex items-center gap-0.5 transition-colors hover:text-[var(--color-brand)]"
      style={{ color: 'var(--color-muted)' }}>
      View all <ArrowRight className="w-3 h-3" />
    </Link>
  );
}

// The "and there are more of these" footer. Only rendered when the list was
// actually truncated, so a panel showing everything doesn't invite a click
// that changes nothing.
function MoreLink({ shown, total, to, noun }) {
  if (!total || total <= shown) return null;
  return (
    <Link to={to}
      className="mt-auto pt-2.5 shrink-0 flex items-center justify-between text-[11px] font-semibold -mx-4 px-4 transition-colors hover:text-[var(--color-brand)]"
      style={{ color: 'var(--color-muted)', borderTop: '1px solid var(--color-line-soft)' }}>
      <span>+ {total - shown} more {noun}</span>
      <span className="flex items-center gap-0.5" style={{ color: 'var(--color-brand)' }}>
        {total} total <ArrowRight className="w-3 h-3" />
      </span>
    </Link>
  );
}

const RELATED_LABEL = { leads: 'Lead', accounts: 'Account', contacts: 'Contact', opportunities: 'Opportunity', tickets: 'Ticket' };
// Priority is a status, so it uses the semantic colours and nothing else.
const PRIORITY_TONE = { Urgent: '#F43F5E', High: '#F97316', Medium: '#F59E0B', Low: '#3B82F6' };

// A single "what's on today" row. Now an inset tinted card rather than bare
// text on white — the same .dash-row treatment the activity feed uses, so
// every list on the page is visibly the same component.
function AgendaRow({ item, render, accent }) {
  const r = render(item);
  const initials = (r.title || '?').split(' ').filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
  const chipColor = r.dotTone || accent.c;
  const chipBg = r.dotTone ? `${r.dotTone}1A` : accent.soft;
  const body = (
    <div className="flex items-center gap-2.5 min-w-0 px-2.5 py-[7px]">
      <div className="w-[30px] h-[30px] rounded-[9px] flex items-center justify-center text-[10px] font-bold shrink-0"
        style={{ background: chipBg, color: chipColor }}>
        {r.icon ? <r.icon className="w-[15px] h-[15px]" strokeWidth={2} /> : initials}
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-[12px] font-semibold truncate leading-tight" style={{ color: 'var(--color-ink)' }}>{r.title}</div>
        {r.meta && <div className="text-[11px] truncate mt-0.5" style={{ color: 'var(--color-muted)' }}>{r.meta}</div>}
      </div>
      {r.time && (
        <span className="text-[11px] font-semibold shrink-0 px-1.5 py-0.5 rounded-md tabular-nums"
          style={{ background: 'var(--color-canvas)', color: 'var(--color-muted)' }}>{r.time}</span>
      )}
      {r.phone && (
        // A <button>, not a nested <a> — this row's own wrapper is already an
        // anchor when r.to is set, and an anchor inside an anchor is invalid
        // HTML (React warns on it, and click targeting near the boundary
        // gets unreliable in some browsers). window.location does the same
        // job a tel: link does.
        <button type="button" title="Call"
          onClick={(e) => { e.preventDefault(); e.stopPropagation(); window.location.href = `tel:${r.phone}`; }}
          className="w-7 h-7 rounded-[9px] flex items-center justify-center shrink-0 transition-opacity hover:opacity-80"
          style={{ background: 'var(--color-success-soft)', color: 'var(--color-success)' }}>
          <Phone className="w-3.5 h-3.5" strokeWidth={2} />
        </button>
      )}
    </div>
  );
  return r.to
    ? <Link to={r.to} className="dash-row block">{body}</Link>
    : <div className="dash-row">{body}</div>;
}

// Today's three lists. The cap is what actually fixes the runaway panel: the
// backend sends six, this shows five, and the footer says how many there
// really are and links to the list view that can show them all properly.
//
// AGENDA_HEIGHT is derived, not guessed: header (47) + five 48px rows (243)
// + the "view all" footer (36) + padding. Measured in a browser rather than
// eyeballed — at 296 the fifth row ended one pixel past the card and was
// silently hidden behind the footer, so a panel claiming five rows showed
// four.
const AGENDA_CAP = 5;
const AGENDA_HEIGHT = 368;
// The other two panel rows. Each row's cards share one height so the grid
// lines up; the numbers are measured against real content, not guessed.
const CHART_HEIGHT = 312;
const REPORT_HEIGHT = 300;

function AgendaCard({ title, icon, accent = COLORS.purple, items, total, render, empty, cta, viewAll, noun, index = 0 }) {
  const list = (items || []).slice(0, AGENDA_CAP);
  const realTotal = total ?? (items || []).length;
  return (
    <Panel title={title} icon={icon} accent={accent} count={realTotal} height={AGENDA_HEIGHT} index={index}
      action={list.length > 0 ? <ViewAll to={viewAll} /> : null}>
      {list.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center text-center gap-3 rounded-[10px]"
          style={{ background: 'var(--color-surface-soft)' }}>
          <span className="w-10 h-10 rounded-full flex items-center justify-center"
            style={{ background: 'var(--color-brand-soft)', color: 'var(--color-brand)' }}>
            <CheckCircle2 className="w-5 h-5" strokeWidth={2} />
          </span>
          <p className="text-[12px] px-4" style={{ color: 'var(--color-muted)' }}>{empty}</p>
          {cta && (
            <Link to={cta.to}
              className="text-[12px] font-semibold px-3.5 py-1.5 rounded-lg transition-colors"
              style={{ background: 'var(--color-brand)', color: '#FFFFFF' }}>
              {cta.label}
            </Link>
          )}
        </div>
      ) : (
        <>
          <div className="flex flex-col gap-1.5 overflow-hidden">
            {list.map((item, i) => <AgendaRow key={i} item={item} render={render} accent={accent} />)}
          </div>
          <MoreLink shown={list.length} total={realTotal} to={viewAll} noun={noun} />
        </>
      )}
    </Panel>
  );
}

// Named sources keep the same colour wherever they appear, so "Website" is
// always the same blue rather than whatever position it happened to sort
// into this week. Anything unnamed falls through to the ordered palette.
const SOURCE_COLOR = {
  Website: '#3B82F6', Partner: '#8B5CF6', LinkedIn: '#F43F7A',
  Referral: '#F59E0B', 'Facebook Ads': '#10B981', Facebook: '#10B981',
  Google: '#14B8A6', Instagram: '#F43F7A', 'Walk-in': '#6C4FF7',
};

function SourceBars({ sources }) {
  const top = (sources || []).slice(0, 5);
  const max = Math.max(1, ...top.map((s) => s.c));
  const palette = ['#3B82F6', '#8B5CF6', '#F43F7A', '#F59E0B', '#10B981', '#14B8A6', '#6C4FF7', '#EC4899'];
  // Bars start at 0 width and animate to their real width a frame after
  // mount — without this the CSS transition on width has nothing to
  // transition FROM and the bars just appear pre-filled.
  const [grown, setGrown] = useState(false);
  useEffect(() => { const id = requestAnimationFrame(() => setGrown(true)); return () => cancelAnimationFrame(id); }, []);
  return (
    <div className="space-y-3">
      {top.map((s, i) => {
        const color = SOURCE_COLOR[s.source] || palette[i % palette.length];
        return (
          <div key={s.source}>
            <div className="flex items-center justify-between text-[12px] mb-1.5">
              <span className="truncate font-medium" style={{ color: 'var(--color-ink)' }}>{s.source}</span>
              <span className="font-semibold shrink-0 tabular-nums" style={{ color: 'var(--color-ink)' }}>{s.c}</span>
            </div>
            <div className="h-[7px] rounded-full overflow-hidden" style={{ background: 'var(--color-canvas)' }}>
              <div className="dash-bar-fill h-full rounded-full"
                style={{
                  width: grown ? `${(s.c / max) * 100}%` : '0%',
                  background: color,
                  transitionDelay: `${i * 60}ms`,
                }} />
            </div>
          </div>
        );
      })}
      {top.length === 0 && <p className="text-[12px]" style={{ color: 'var(--color-muted)' }}>No leads yet.</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Collections — the one panel on this page that reports cash rather than
// forecast. Everything else counts deals that might close; this counts money
// that has actually arrived, which is usually the first question anyone
// running the business asks.
// ---------------------------------------------------------------------------
function CollectionsCard({ collections, index }) {
  const c = collections || {};
  const pct = c.collected_pct;
  const [grown, setGrown] = useState(false);
  useEffect(() => { const id = requestAnimationFrame(() => setGrown(true)); return () => cancelAnimationFrame(id); }, []);
  return (
    <Panel title="Collections" subtitle="Invoiced vs actually received" icon={Wallet} accent={COLORS.teal}
      height={REPORT_HEIGHT} index={index} action={<ViewAll to="/records/invoices" />}>
      {pct === null || pct === undefined ? (
        <div className="flex-1 flex items-center justify-center rounded-[10px]" style={{ background: 'var(--color-surface-soft)' }}>
          <p className="text-[12px]" style={{ color: 'var(--color-muted)' }}>No invoices raised yet.</p>
        </div>
      ) : (
        <>
          <div className="flex items-end justify-between gap-2">
            <div>
              <div className="dash-figure text-[23px] font-bold leading-none tabular-nums" style={{ fontFamily: 'var(--font-display)' }}>
                {inrShort(c.collected)}
              </div>
              <div className="text-[11px] mt-1.5" style={{ color: 'var(--color-muted)' }}>collected of {inrShort(c.invoiced)}</div>
            </div>
            <span className="text-[17px] font-bold tabular-nums shrink-0" style={{ color: 'var(--color-success)' }}>{pct}%</span>
          </div>

          {/* Track is a desaturated green rather than plain grey — the bar
              reads as "how far along" instead of as two unrelated colours. */}
          <div className="h-[7px] rounded-full overflow-hidden mt-3" style={{ background: '#EAF0EE' }}>
            <div className="dash-bar-fill h-full rounded-full"
              style={{ width: grown ? `${Math.min(100, pct)}%` : '0%', background: 'var(--color-success)' }} />
          </div>

          <div className="grid grid-cols-2 gap-2 mt-4">
            <div className="rounded-[10px] p-2.5" style={{ background: 'var(--color-canvas)' }}>
              <div className="text-[11px]" style={{ color: 'var(--color-muted)' }}>Outstanding</div>
              <div className="text-[14px] font-bold mt-1 tabular-nums" style={{ color: 'var(--color-ink)' }}>{inrShort(c.outstanding)}</div>
            </div>
            <div className="rounded-[10px] p-2.5"
              style={{ background: c.overdue_count ? 'var(--color-danger-soft)' : 'var(--color-canvas)' }}>
              <div className="text-[11px]" style={{ color: c.overdue_count ? 'var(--color-danger-strong)' : 'var(--color-muted)' }}>Overdue</div>
              <div className="text-[14px] font-bold mt-1 tabular-nums"
                style={{ color: c.overdue_count ? 'var(--color-danger-strong)' : 'var(--color-ink)' }}>
                {inrShort(c.overdue_amount)}
              </div>
            </div>
          </div>
          <p className="text-[11px] mt-2.5" style={{ color: 'var(--color-faint)' }}>
            {c.invoice_count} invoice{c.invoice_count === 1 ? '' : 's'}
            {c.overdue_count > 0 && <> · <span style={{ color: 'var(--color-danger-strong)' }}>{c.overdue_count} past due date</span></>}
          </p>
        </>
      )}
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// Who is closing business. Ranked by value rather than count — five small
// wins and one large one are not the same contribution, and ordering by
// count would say they were.
// ---------------------------------------------------------------------------
// Initials avatars, tinted from a small fixed set so the same person keeps
// the same colour between renders rather than shifting with their rank.
const AVATAR_TINT = [
  { bg: '#F0EDFF', fg: '#6C4FF7' }, { bg: '#EFF6FF', fg: '#3B82F6' },
  { bg: '#ECFDF9', fg: '#0F9F8F' }, { bg: '#FFF1F2', fg: '#E11D48' },
  { bg: '#FFFBEB', fg: '#D97706' },
];
function initialsOf(name) {
  return (name || '?').split(' ').filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
}

function LeaderboardCard({ leaderboard, index }) {
  const rows = leaderboard || [];
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <Panel title="Top performers" subtitle="Won deals by owner, all time" icon={Medal} accent={COLORS.purple}
      height={REPORT_HEIGHT} index={index} action={<ViewAll to="/records/opportunities" />}>
      {rows.length === 0 ? (
        <div className="flex-1 flex items-center justify-center rounded-[10px]" style={{ background: 'var(--color-surface-soft)' }}>
          <p className="text-[12px]" style={{ color: 'var(--color-muted)' }}>No deals won yet.</p>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {rows.map((r, i) => {
            const tint = AVATAR_TINT[i % AVATAR_TINT.length];
            return (
              <div key={`${r.name}-${i}`} className="flex items-center gap-2">
                <span className="w-[18px] text-[11px] font-bold shrink-0 text-center rounded-[5px] tabular-nums"
                  style={{ background: '#FFF8E7', color: '#B7791F' }}>{i + 1}</span>
                <span className="w-7 h-7 rounded-full flex items-center justify-center text-[10px] font-bold shrink-0"
                  style={{ background: tint.bg, color: tint.fg }}>{initialsOf(r.name)}</span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="text-[12px] font-semibold truncate" style={{ color: 'var(--color-ink)' }}>{r.name}</span>
                    <span className="text-[12px] font-semibold shrink-0 tabular-nums" style={{ color: 'var(--color-ink)' }}>{inrShort(r.value)}</span>
                  </div>
                  <div className="h-[5px] rounded-full overflow-hidden mt-1.5" style={{ background: 'var(--color-canvas)' }}>
                    <div className="h-full rounded-full"
                      style={{ width: `${(r.value / max) * 100}%`, background: 'var(--color-brand)' }} />
                  </div>
                </div>
                <span className="text-[11px] shrink-0 tabular-nums w-11 text-right" style={{ color: 'var(--color-muted)' }}>{r.won} won</span>
              </div>
            );
          })}
        </div>
      )}
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// Open support load, worst-first. Resolved and closed tickets are excluded
// entirely — this panel is about what is still on someone's plate.
// ---------------------------------------------------------------------------
// Same priority colours as the task rows — priority means one thing on this
// page, so it looks like one thing.
const TICKET_TONE = { ...PRIORITY_TONE, Unset: '#94A3B8' };

function SupportCard({ ticketLoad, index }) {
  const rows = ticketLoad || [];
  const total = rows.reduce((s, r) => s + r.c, 0);
  return (
    <Panel title="Support load" subtitle="Open tickets by priority" icon={LifeBuoy} accent={COLORS.rose}
      height={REPORT_HEIGHT} index={index} action={<ViewAll to="/records/tickets" />}>
      {total === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center gap-2 text-center rounded-[10px]"
          style={{ background: 'var(--color-surface-soft)' }}>
          <CheckCircle2 className="w-7 h-7" style={{ color: 'var(--color-success)' }} />
          <p className="text-[12px]" style={{ color: 'var(--color-muted)' }}>No open tickets. Queue is clear.</p>
        </div>
      ) : (
        <>
          <div className="flex items-end gap-2 mb-3">
            <span className="dash-figure text-[23px] font-bold leading-none tabular-nums" style={{ fontFamily: 'var(--font-display)' }}>{total}</span>
            <span className="text-[11px] mb-0.5" style={{ color: 'var(--color-muted)' }}>open right now</span>
          </div>
          {/* One proportional bar rather than four separate ones — the split
              between priorities is the point, and a single stacked bar shows
              that in one glance. */}
          <div className="flex h-2 rounded-full overflow-hidden mb-4">
            {rows.map((r) => (
              <div key={r.priority} style={{ width: `${(r.c / total) * 100}%`, background: TICKET_TONE[r.priority] || '#94A3B8' }} />
            ))}
          </div>
          <div className="flex flex-col gap-2">
            {rows.map((r) => (
              <div key={r.priority} className="flex items-center justify-between text-[12px]">
                <span className="flex items-center gap-2 min-w-0">
                  <span className="w-2 h-2 rounded-full shrink-0" style={{ background: TICKET_TONE[r.priority] || '#94A3B8' }} />
                  <span className="truncate" style={{ color: 'var(--color-ink)' }}>{r.priority}</span>
                </span>
                <span className="font-semibold shrink-0 tabular-nums" style={{ color: 'var(--color-ink)' }}>{r.c}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </Panel>
  );
}

// Each activity type gets one icon and one colour pair, and keeps them
// everywhere. A call is always green, a meeting always purple — so the feed
// can be read by colour before any of the text is.
const ACTIVITY_STYLE = {
  call:    { icon: PhoneCall,     c: '#10B981', soft: '#ECFDF5' },
  meeting: { icon: CalendarClock, c: '#6C4FF7', soft: '#F0EDFF' },
  task:    { icon: CheckSquare,   c: '#3B82F6', soft: '#EFF6FF' },
  note:    { icon: StickyNote,    c: '#14B8A6', soft: '#ECFDF9' },
  email:   { icon: Mail,          c: '#F59E0B', soft: '#FFFBEB' },
};
const ACTIVITY_FALLBACK = { icon: Send, c: '#6C4FF7', soft: '#F0EDFF' };
const ACTIVITY_CAP = 8;

// The feed. Previously this was a plain white block with flat text rows,
// which is the one thing on the page that looked unfinished: an activity
// list is the most "CRM" component on a dashboard and it was carrying the
// least design. Each row is now an inset tinted card with a coloured type
// chip, a clear title, its record, and a timestamp.
function RecentActivity({ activities }) {
  const all = activities || [];
  const [filter, setFilter] = useState('all');
  const types = useMemo(() => ['all', ...new Set(all.map((a) => a.type))], [all]);
  const filtered = (filter === 'all' ? all : all.filter((a) => a.type === filter)).slice(0, ACTIVITY_CAP);
  return (
    <div className="dash-card dash-glow p-3 dash-enter" style={{ '--accent-rgb': COLORS.purple.rgb, '--stagger': '100ms' }}>
      <div className="flex items-center justify-between flex-wrap gap-2 px-1 pt-1 pb-2.5">
        <h3 className="flex items-center gap-2 text-[13px] font-semibold" style={{ color: 'var(--color-ink)' }}>
          <span className="w-7 h-7 rounded-[9px] flex items-center justify-center shrink-0"
            style={{ background: 'var(--color-brand-soft)', color: 'var(--color-brand)' }}>
            <Send className="w-[15px] h-[15px]" strokeWidth={2} />
          </span>
          Latest activity
        </h3>
        <div className="flex items-center gap-1.5">
          {types.map((t) => (
            <button key={t} onClick={() => setFilter(t)} data-active={filter === t}
              className="dash-pill text-[11px] font-semibold px-2.5 py-1 capitalize">
              {t}
            </button>
          ))}
          <ViewAll to="/records/tasks" />
        </div>
      </div>
      <div className="grid sm:grid-cols-2 gap-1.5">
        {filtered.map((a) => {
          const s = ACTIVITY_STYLE[a.type] || ACTIVITY_FALLBACK;
          const Icon = s.icon;
          const to = a.related_module && a.related_record_id
            ? `/records/${a.related_module}/${a.related_record_id}`
            : null;
          const inner = (
            <div className="flex items-center gap-2.5 px-2.5 py-[7px] min-w-0">
              <div className="w-[30px] h-[30px] rounded-[9px] flex items-center justify-center shrink-0"
                style={{ background: s.soft, color: s.c }}>
                <Icon className="w-4 h-4" strokeWidth={2} />
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-[12px] font-semibold truncate leading-tight" style={{ color: 'var(--color-ink)' }}>
                  {a.title || 'Untitled'}
                </div>
                <div className="text-[11px] mt-0.5 flex items-center gap-1.5 truncate" style={{ color: 'var(--color-muted)' }}>
                  <span className="capitalize">{a.type}</span>
                  {a.related_module && <>·<span className="truncate">{RELATED_LABEL[a.related_module] || a.related_module}</span></>}
                </div>
              </div>
              <span className="text-[11px] shrink-0 tabular-nums" style={{ color: 'var(--color-faint)' }}>
                {relativeTime(a.activity_date)}
              </span>
            </div>
          );
          return to
            ? <Link key={`${a.type}-${a.id}`} to={to} className="dash-row block">{inner}</Link>
            : <div key={`${a.type}-${a.id}`} className="dash-row">{inner}</div>;
        })}
        {filtered.length === 0 && (
          <p className="text-[12px] py-4 text-center sm:col-span-2" style={{ color: 'var(--color-muted)' }}>Nothing logged yet.</p>
        )}
      </div>
    </div>
  );
}

// A single horizontal strip, never a wrapping block. Each item links to the
// module it's actually about — the previous version sent every one of them
// to /leads regardless of what it said, so "3 subscriptions renewing" opened
// the leads list. On a narrow screen this scrolls sideways rather than
// stacking into four rows that push the whole dashboard down.
const SEVERITY_STYLE = {
  high: { bg: 'var(--color-danger-soft)', fg: 'var(--color-danger-strong)', label: 'High' },
  medium: { bg: 'var(--color-warning-soft)', fg: 'var(--color-warning-strong)', label: 'Medium' },
};

function AttentionBar({ items }) {
  if (!items || items.length === 0) return null;
  return (
    <div className="rounded-xl px-3 flex items-center gap-3 mt-3 dash-enter"
      style={{ background: '#FFFCF3', border: '1px solid #F3E8C1', minHeight: 46 }}>
      <div className="flex items-center gap-2 shrink-0">
        <AlertTriangle className="w-4 h-4 shrink-0" style={{ color: 'var(--color-warning)' }} strokeWidth={2} />
        <span className="text-[12px] font-bold hidden sm:block" style={{ color: 'var(--color-ink)' }}>Needs attention</span>
      </div>
      <div className="flex items-center gap-2 flex-1 min-w-0 overflow-x-auto thin-scroll py-2">
        {items.map((a, i) => {
          const s = SEVERITY_STYLE[a.severity] || SEVERITY_STYLE.medium;
          return (
            <Link key={i} to={a.link || '/'}
              className="group inline-flex items-center gap-2 pl-1.5 pr-2 py-1 rounded-full shrink-0 whitespace-nowrap transition-colors"
              style={{ background: '#FFFFFF', border: '1px solid var(--color-line)' }}>
              <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full"
                style={{ background: s.bg, color: s.fg }}>{s.label}</span>
              <span className="text-[11.5px]" style={{ color: 'var(--color-ink)' }}>{a.text}</span>
              <ChevronRight className="w-3 h-3 transition-transform group-hover:translate-x-0.5"
                style={{ color: 'var(--color-disabled)' }} />
            </Link>
          );
        })}
      </div>
    </div>
  );
}

function CrmDashboardSection({ data }) {
  const c = data.cards;
  const counts = data.agenda_counts || {};
  return (
    <>
      <AttentionBar items={data.attention} />

      <SectionLabel>Pipeline at a glance</SectionLabel>
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3.5">
        <KpiCard index={0} label="Total Leads" value={c.total_leads} trend={formatTrend(data.trends?.total_leads)} icon={Users} color={COLORS.purple} to="/leads" />
        <KpiCard index={1} label="Pipeline Value" value={inr(c.pipeline_value)} trend={formatTrend(data.trends?.pipeline_value)} icon={Target} color={COLORS.teal} to="/records/opportunities" />
        <KpiCard index={2} label="Open Opportunities" value={c.open_opportunities} trend={formatTrend(data.trends?.open_opportunities)} icon={TrendingUp} color={COLORS.amber} to="/records/opportunities" />
        <KpiCard index={3} label="Won This Month" value={inr(c.won_revenue_month)} sub={`${c.lost_this_month} lost this month`} icon={Trophy} color={COLORS.emerald} to="/records/opportunities" />
        <KpiCard index={4} label="Follow-ups Due" value={c.followups_due_today} sub={`${c.followups_overdue} overdue`} icon={CalendarClock} color={COLORS.rose} to="/leads" />
      </div>

      <SectionLabel>On today</SectionLabel>
      <div className="grid md:grid-cols-3 gap-3.5">
        <AgendaCard index={0} title="Follow-ups" icon={CalendarClock} accent={COLORS.purple}
          items={data.agenda?.follow_ups} total={counts.follow_ups} noun="today" viewAll="/leads"
          render={(f) => ({ title: f.title, phone: f.mobile, meta: f.mobile || f.status, to: `/leads/${f.id}` })}
          empty="No follow-ups scheduled for today."
          cta={{ to: '/leads', label: 'View all leads' }} />
        <AgendaCard index={1} title="Meetings" icon={Users} accent={COLORS.blue}
          items={data.agenda?.meetings} total={counts.meetings} noun="today" viewAll="/records/meetings"
          render={(m) => ({
            title: m.title,
            icon: CalendarClock,
            meta: m.related_module ? (RELATED_LABEL[m.related_module] || m.related_module) : 'Meeting',
            time: m.start_datetime ? String(m.start_datetime).slice(11, 16) : '',
            // Always openable now. Previously a meeting with no linked
            // record rendered as a dead row you could click forever.
            to: `/records/meetings/${m.id}`,
          })}
          empty="Nothing in the diary today."
          cta={{ to: '/records/meetings', label: 'Schedule a meeting' }} />
        <AgendaCard index={2} title="Tasks due" icon={CheckSquare} accent={COLORS.purple}
          items={data.agenda?.tasks_due} total={counts.tasks_due} noun="due" viewAll="/records/tasks"
          render={(t) => ({
            title: t.title,
            meta: t.priority ? `${t.priority} priority` : null,
            dotTone: PRIORITY_TONE[t.priority],
            // Tasks were the one list on this page that went nowhere.
            to: `/records/tasks/${t.id}`,
          })}
          empty="No tasks due."
          cta={{ to: '/records/tasks', label: 'Create a task' }} />
      </div>

      {data.performance && (
        <>
          <SectionLabel>Performance</SectionLabel>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3.5">
            {/* Every one of these now opens the deals list — a number you
                can't drill into is a dead end, which is what these four
                were. */}
            <KpiCard index={0} label="Deals won" value={data.performance.won} icon={Trophy} color={COLORS.emerald} to="/records/opportunities" />
            <KpiCard index={1} label="Deals lost" value={data.performance.lost} icon={AlertTriangle} color={COLORS.rose} to="/records/opportunities" />
            <KpiCard index={2} label="Win rate" value={data.performance.win_rate === null ? '—' : `${data.performance.win_rate}%`}
              icon={TrendingUp} color={COLORS.purple} to="/records/opportunities" />
            <KpiCard index={3} label="Avg deal size" value={inr(data.performance.avg_deal_size)} icon={IndianRupee} color={COLORS.blue} to="/records/opportunities" />
          </div>
          {data.performance.win_rate === null && (
            <p className="text-[11px] mt-2" style={{ color: 'var(--color-muted)' }}>No deals have closed yet, so a win rate can't be calculated.</p>
          )}
        </>
      )}

      <SectionLabel>Where things stand</SectionLabel>
      <div className="grid lg:grid-cols-3 gap-3.5">
        <Panel title="Pipeline by Stage" subtitle="Deal count and value per stage" height={CHART_HEIGHT} index={0}
          accent={COLORS.blue} action={<ViewAll to="/records/opportunities/kanban" />}>
          <div className="flex-1 min-h-0 overflow-hidden">
            <ChartFrame height={168}>
              <StageDonut stages={data.opportunities_by_stage} />
            </ChartFrame>
          </div>
        </Panel>

        <Panel title="Monthly Revenue Trend" subtitle="Payments collected, last 6 months" height={CHART_HEIGHT} index={1}
          accent={COLORS.purple} action={<ViewAll to="/records/subscriptions" />}>
          <div className="flex-1 min-h-0">
            <ChartFrame height={220}>
              <RevenueArea data={data.revenue_by_month} />
            </ChartFrame>
          </div>
        </Panel>

        <Panel title="Leads by Source" subtitle="Top 5 sources by lead count" height={CHART_HEIGHT} index={2}
          accent={COLORS.rose} action={<ViewAll to="/leads" />}>
          <SourceBars sources={data.leads_by_source} />
        </Panel>
      </div>

      <SectionLabel>Money &amp; workload</SectionLabel>
      <div className="grid lg:grid-cols-3 gap-3.5">
        <CollectionsCard collections={data.collections} index={0} />
        <LeaderboardCard leaderboard={data.leaderboard} index={1} />
        <SupportCard ticketLoad={data.ticket_load} index={2} />
      </div>

      <SectionLabel>Latest activity</SectionLabel>
      <RecentActivity activities={data.recent_activities} />

      {/* Page end. A deliberate closing strip rather than the content simply
          stopping — and, being full width and outside every grid, it is the
          one element on the page that cannot be stretched taller by a CRM
          with more records in it. */}
      <div className="dash-enter rounded-[14px] mt-4 mb-1 px-5 text-white relative overflow-hidden flex items-center gap-4 flex-wrap"
        style={{
          background: 'linear-gradient(100deg, #5137D9, #6C4FF7, #8B5CF6)',
          minHeight: 56,
          '--stagger': '140ms',
        }}>
        <div className="absolute inset-0 opacity-[0.08]" style={{
          backgroundImage: 'radial-gradient(circle at 2px 2px, white 1px, transparent 0)', backgroundSize: '22px 22px',
        }} />
        <div aria-hidden="true" className="absolute -top-16 -right-10 w-56 h-56 rounded-full pointer-events-none animate-[dash-drift_9s_ease-in-out_infinite]"
          style={{ background: 'radial-gradient(circle, rgba(255,255,255,.16), transparent 70%)' }} />
        <div aria-hidden="true" className="absolute -bottom-24 left-1/3 w-64 h-64 rounded-full pointer-events-none animate-[dash-drift_11s_ease-in-out_infinite_reverse]"
          style={{ background: 'radial-gradient(circle, rgba(255,255,255,.12), transparent 70%)' }} />
        <div className="relative w-8 h-8 rounded-[10px] flex items-center justify-center shrink-0" style={{ background: 'rgba(255,255,255,.16)' }}>
          <Send className="w-4 h-4" strokeWidth={2} />
        </div>
        <div className="relative min-w-0 flex-1 py-3">
          <h3 className="font-bold text-[13px]" style={{ fontFamily: 'var(--font-display)' }}>Keep the momentum going</h3>
          <p className="text-white/75 text-[11px] mt-0.5">More conversations. More opportunities. A greater tomorrow.</p>
        </div>
        <div className="relative flex gap-2 shrink-0 py-3">
          <Link to="/leads" className="text-[12px] font-semibold px-3 py-1.5 rounded-lg transition-colors"
            style={{ background: 'rgba(255,255,255,0.12)', border: '1px solid rgba(255,255,255,0.25)' }}>Work my leads</Link>
          <Link to="/records/opportunities/kanban" className="text-[12px] font-semibold px-3 py-1.5 rounded-lg transition-opacity hover:opacity-90"
            style={{ background: '#FFFFFF', color: '#5137D9' }}>Open pipeline</Link>
        </div>
      </div>
    </>
  );
}

export default function Dashboard() {
  const { user } = useAuth();
  const [crmData, setCrmData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    api.dashboardCrm().then(setCrmData).catch((e) => setError(friendlyError(e, 'Could not load the dashboard.')));
  }, []);

  if (error) {
    return (
      <div className="max-w-[1600px] mx-auto p-8 text-center">
        <p className="t-section mb-1">{error.message}</p>
        <button onClick={() => window.location.reload()} className="btn btn-primary mx-auto mt-3">Retry</button>
      </div>
    );
  }
  if (!crmData) return <div className="p-8 text-slate-400">Loading…</div>;

  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  const today = new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

  return (
    <div className="relative max-w-[1600px] mx-auto rounded-3xl -m-4 sm:-m-6 p-4 sm:p-6"
      style={{ background: 'radial-gradient(ellipse 1400px 500px at top, var(--color-brand-soft), transparent 60%)' }}>

      {/* ===== Background treatment =====
          Three layers, all decorative, all behind the content:

          1. A fine dot grid — gives the canvas texture so white cards read
             as sitting ON something rather than floating in a void. Kept
             very low contrast; at normal viewing distance you register it
             as "not flat" rather than consciously seeing dots.
          2. Two soft colour blooms in the brand hues, top-right and
             bottom-left, so the page has warmth and a sense of depth.
          3. A large outline watermark of the brand mark, bottom-right.

          Every layer is `pointer-events-none` and sits at a negative
          z-index so it can never intercept a click or overlap text — a
          watermark that interferes with the UI is worse than no watermark.
          All of it is also `aria-hidden`, since none of it carries meaning
          for a screen reader. */}
      <div aria-hidden="true" className="absolute inset-0 -z-10 overflow-hidden rounded-3xl pointer-events-none">
        <div className="absolute inset-0 opacity-[0.5]" style={{
          backgroundImage: 'radial-gradient(circle at 1px 1px, rgba(79,70,229,0.07) 1px, transparent 0)',
          backgroundSize: '26px 26px',
        }} />
        <div className="absolute -top-24 -right-24 w-[460px] h-[460px] rounded-full" style={{
          background: 'radial-gradient(circle, rgba(124,58,237,0.10), transparent 68%)',
        }} />
        <div className="absolute -bottom-32 -left-20 w-[420px] h-[420px] rounded-full" style={{
          background: 'radial-gradient(circle, rgba(37,99,235,0.09), transparent 68%)',
        }} />
        <svg viewBox="0 0 200 200" className="absolute bottom-6 right-8 w-[260px] h-[260px] opacity-[0.035]">
          <path d="M100 18 L168 56 L168 132 L100 170 L32 132 L32 56 Z" fill="none" stroke="#4F46E5" strokeWidth="5" />
          <path d="M100 54 L136 74 L136 114 L100 134 L64 114 L64 74 Z" fill="none" stroke="#4F46E5" strokeWidth="5" />
          <circle cx="100" cy="94" r="13" fill="#4F46E5" />
        </svg>
      </div>

      <div className="dash-enter rounded-2xl px-5 py-4 relative overflow-hidden flex items-center"
        style={{
          background: 'linear-gradient(110deg, #F0EDFF 0%, #F7F8FC 55%, #FFFFFF 100%)',
          border: '1px solid var(--color-line)',
          minHeight: 96,
        }}>
        {/* Soft depth wash behind the content — a flat pastel panel is what
            made this strip read as empty. Sits behind everything and is
            pointer-events-none so it can never interfere. */}
        <div aria-hidden="true" className="absolute inset-0 pointer-events-none"
          style={{ background: 'radial-gradient(circle 420px at 78% 20%, rgba(129,140,248,0.2), transparent 70%)' }} />
        <div aria-hidden="true" className="absolute -top-20 -left-16 w-64 h-64 rounded-full pointer-events-none animate-[dash-drift_10s_ease-in-out_infinite]"
          style={{ background: 'radial-gradient(circle, rgba(124,58,237,0.10), transparent 70%)' }} />

        <div className="relative flex items-center justify-between flex-wrap gap-4 w-full">
          <div className="min-w-0">
            <h1 className="dash-figure font-display text-[21px] font-bold leading-tight" style={{ fontFamily: 'var(--font-display)' }}>
              {greeting}, {user?.full_name?.split(' ')[0] || user?.username || 'there'}
            </h1>
            <p className="text-[12.5px] mt-1" style={{ color: 'var(--color-muted)' }}>
              Here's what's happening with your CRM today.
            </p>
          </div>

          {/* Illustration and quote sit side by side in their own flex zone
              rather than one being absolutely positioned over the other. */}
          <div className="hidden lg:flex items-center gap-3 shrink-0 ml-auto">
            <svg aria-hidden="true" viewBox="0 0 170 96" className="w-[110px] h-[62px] shrink-0">
              <ellipse cx="85" cy="88" rx="72" ry="7" fill="#C7D2FE" opacity="0.35" />
              <path d="M0 88 L42 34 L64 58 L96 16 L170 88 Z" fill="#DDE3FF" />
              <path d="M52 88 L96 16 L140 88 Z" fill="#C7D2FE" />
              <path d="M83 31 L96 16 L109 31 L101 27 L96 32 L91 27 Z" fill="#FFFFFF" />
              <rect x="95" y="6" width="1.8" height="22" rx="0.9" fill="#4338CA" />
              <path d="M96.8 6 L114 11.5 L96.8 17 Z" fill="#4F46E5" />
              <circle cx="34" cy="26" r="3" fill="#A5B4FC" opacity="0.8" />
              <circle cx="146" cy="34" r="2.2" fill="#A5B4FC" opacity="0.7" />
            </svg>
            <p className="text-[11px] italic leading-snug max-w-[140px]" style={{ color: 'var(--color-muted)' }}>
              "Small steps today, big results tomorrow."
            </p>
          </div>

          <div className="flex items-center gap-2 rounded-[10px] px-3 py-2 shrink-0"
            style={{ background: '#FFFFFF', border: '1px solid var(--color-line)' }}>
            <span className="w-6 h-6 rounded-md flex items-center justify-center shrink-0"
              style={{ background: 'var(--color-brand-soft)', color: 'var(--color-brand)' }}>
              <CalendarClock className="w-3.5 h-3.5" strokeWidth={2} />
            </span>
            <span className="text-[13px] font-semibold" style={{ color: 'var(--color-ink)' }}>{today}</span>
          </div>
        </div>
      </div>

      <CrmDashboardSection data={crmData} />
    </div>
  );
}
