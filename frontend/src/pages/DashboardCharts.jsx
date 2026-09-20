/*
 * The two recharts-backed visualisations from the Dashboard, split into
 * their own module.
 *
 * recharts (plus its d3 dependencies) is by far the heaviest thing the app
 * imports. While it lived in Dashboard.jsx it was pulled into the chunk
 * that loads on first paint, so every user paid for it before seeing
 * anything. Here it sits behind a lazy() boundary: the Dashboard renders
 * its KPI cards and lists immediately, and the charts stream in a moment
 * later.
 *
 * This file must stay the ONLY module that imports recharts — importing it
 * anywhere else would put it back in a shared chunk and undo the split.
 */
import {
  PieChart, Pie, Cell, AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid,
} from 'recharts';

const inr = (n) => `₹${Number(n || 0).toLocaleString('en-IN')}`;

// The seven standard sales stages have a fixed colour in the design system,
// and it wins over whatever is stored against the stage. The stored values
// predate the palette (#60A5FA, #818CF8, #EF4444 — near-misses of the real
// blue, violet and red), and three near-miss colours in a seven-segment
// donut is exactly the "random chart colours" the palette exists to stop.
// A stage NOT in this list is a stage someone created themselves, so its
// configured colour is honoured, and the ordered list catches the rest.
const STAGE_NAMED = {
  New: '#94A3B8',
  Qualification: '#3B82F6',
  'Needs Analysis': '#8B5CF6',
  Proposal: '#A78BFA',
  Negotiation: '#F59E0B',
  Won: '#10B981',
  Lost: '#F43F5E',
};
const STAGE_FALLBACK = ['#3B82F6', '#8B5CF6', '#A78BFA', '#14B8A6', '#F59E0B', '#10B981', '#F43F5E'];

// One tooltip treatment for both charts — dark slate, white text, compact.
const TOOLTIP_STYLE = {
  borderRadius: 8,
  border: 'none',
  background: '#17233C',
  color: '#FFFFFF',
  fontSize: 11,
  padding: '7px 9px',
  boxShadow: '0 4px 14px rgba(23, 35, 60, 0.15)',
};
const TOOLTIP_LABEL = { color: '#FFFFFF', fontWeight: 600, marginBottom: 2 };
const TOOLTIP_ITEM = { color: '#FFFFFF' };

// Pipeline-by-stage donut, using each stage's OWN colour from the pipeline
// configuration (module_pipeline_stages.color) rather than a fixed palette
// — a stage renamed or recoloured in Settings → Pipelines is reflected here
// automatically.
// `centreLabel` describes what the middle number counts. It defaults to
// "Total Deals" because this chart plots opportunities by pipeline stage —
// the previous hard-coded "Total Leads" was simply wrong, and contradicted
// the Total Leads KPI card directly above it on the Dashboard.
export function StageDonut({ stages = [], centreLabel = 'Total Deals' }) {
  const total = stages.reduce((s, x) => s + (x.c || 0), 0);
  const data = stages.filter((s) => s.c > 0);
  const colourOf = (s, i) => STAGE_NAMED[s.stage] || s.color || STAGE_FALLBACK[i % STAGE_FALLBACK.length];
  return (
    <div className="flex items-center gap-5 flex-wrap">
      <div className="relative w-[150px] h-[150px] shrink-0">
        {total === 0 ? (
          <div className="w-[150px] h-[150px] rounded-full border-[10px] flex items-center justify-center"
            style={{ borderColor: 'var(--color-line)' }}>
            <span className="text-[11px]" style={{ color: 'var(--color-faint)' }}>No deals</span>
          </div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              {/* No drop-shadow filter on the ring. The segments carry their
                  own colour and a 3° gap already separates them; a shadow
                  under an SVG arc mostly reads as the chart being slightly
                  out of focus. */}
              <Pie data={data} dataKey="c" nameKey="stage" innerRadius={50} outerRadius={73} paddingAngle={3}
                strokeWidth={0} cornerRadius={5}>
                {data.map((s, i) => <Cell key={i} fill={colourOf(s, i)} />)}
              </Pie>
              <Tooltip formatter={(v, n, p) => [`${v} deal(s) · ${inr(p.payload.total)}`, p.payload.stage]}
                contentStyle={TOOLTIP_STYLE} labelStyle={TOOLTIP_LABEL} itemStyle={TOOLTIP_ITEM} />
            </PieChart>
          </ResponsiveContainer>
        )}
        <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
          <span className="text-[23px] font-bold leading-none tabular-nums" style={{ color: 'var(--color-ink)', letterSpacing: '-0.02em' }}>{total}</span>
          <span className="text-[10px] mt-1" style={{ color: 'var(--color-faint)' }}>{centreLabel}</span>
        </div>
      </div>
      <div className="flex-1 min-w-[150px] space-y-[7px]">
        {stages.map((s, i) => (
          <div key={s.stage} className="flex items-center justify-between text-[12px] gap-2">
            <span className="flex items-center gap-2 min-w-0">
              <span className="w-2 h-2 rounded-full shrink-0" style={{ background: colourOf(s, i) }} />
              <span className="truncate" style={{ color: 'var(--color-ink)' }}>{s.stage}</span>
            </span>
            <span className="shrink-0 font-semibold tabular-nums" style={{ color: 'var(--color-ink)' }}>
              {s.c}{' '}
              {total > 0 && (
                <span className="text-[11px] font-normal" style={{ color: 'var(--color-faint)' }}>
                  ({Math.round((s.c / total) * 100)}%)
                </span>
              )}
            </span>
          </div>
        ))}
        {stages.length === 0 && <p className="text-[11px]" style={{ color: 'var(--color-faint)' }}>No pipeline configured.</p>}
      </div>
    </div>
  );
}

// Subscription revenue collected per month, last 6 months.
export function RevenueArea({ data = [] }) {
  return (
    <ResponsiveContainer width="100%" height={220}>
      <AreaChart data={data} margin={{ top: 8, right: 4, left: -8, bottom: 0 }}>
        <defs>
          {/* One colour, fading out. The previous version ran a gradient
              along the stroke and a drop-shadow under it; at 2px both are
              read as blur rather than as emphasis. */}
          <linearGradient id="revenueFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#6C4FF7" stopOpacity={0.18} />
            <stop offset="100%" stopColor="#6C4FF7" stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 6" stroke="#EEF0F5" vertical={false} />
        <XAxis dataKey="month" tick={{ fontSize: 10, fill: '#98A2B3' }} axisLine={false} tickLine={false} />
        <YAxis tick={{ fontSize: 10, fill: '#98A2B3' }} axisLine={false} tickLine={false}
          tickFormatter={(v) => `₹${v >= 1000 ? `${(v / 1000).toFixed(0)}K` : v}`} />
        <Tooltip formatter={(v) => [inr(v), 'Collected']} cursor={{ stroke: '#DDD6FE', strokeWidth: 1 }}
          contentStyle={TOOLTIP_STYLE} labelStyle={TOOLTIP_LABEL} itemStyle={TOOLTIP_ITEM} />
        <Area type="monotone" dataKey="revenue" stroke="#6C4FF7" strokeWidth={2.5} fill="url(#revenueFill)"
          dot={{ fill: '#FFFFFF', r: 3.5, strokeWidth: 2, stroke: '#6C4FF7' }}
          activeDot={{ r: 6, fill: '#6C4FF7', stroke: '#FFFFFF', strokeWidth: 2 }} />
      </AreaChart>
    </ResponsiveContainer>
  );
}
