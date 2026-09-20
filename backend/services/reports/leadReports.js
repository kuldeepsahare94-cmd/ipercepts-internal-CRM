// ============================================================================
// Leads — where the money starts.
// ============================================================================
// These answer the questions a sales manager asks about the top of the
// funnel: where are leads coming from, which sources are worth paying for,
// who is sitting on them, and how many are going stale.

const h = require('./helpers');

// A lead counts as converted once the conversion wrote an opportunity back
// onto it (routes/leads.js sets converted_opportunity_id / converted_at).
// Status text alone is not reliable — anyone can rename a status.
const CONVERTED = '(l.converted_opportunity_id IS NOT NULL OR l.converted_account_id IS NOT NULL)';

module.exports = [
  {
    key: 'lead-source-performance',
    label: 'Lead Source Performance',
    category: 'Leads',
    module: 'leads',
    description: 'Which sources produce leads, and which of those leads actually convert. The volume column tells you where leads come from; the conversion column tells you which sources deserve more budget.',
    dated: true,
    dateLabel: 'Lead created',
    palette: 'fuchsia',
    chart: {
      type: 'composed',
      x: 'source',
      series: [
        { key: 'leads', label: 'Leads', type: 'bar', format: 'number' },
        { key: 'converted', label: 'Converted', type: 'bar', format: 'number' },
        { key: 'conversion_rate', label: 'Conversion %', type: 'line', axis: 'right', format: 'percent' },
      ],
    },
    columns: [
      { key: 'source', label: 'Source' },
      { key: 'leads', label: 'Leads', format: 'number' },
      { key: 'converted', label: 'Converted', format: 'number' },
      { key: 'conversion_rate', label: 'Conversion %', format: 'percent' },
      { key: 'pipeline_value', label: 'Pipeline Value', format: 'currency' },
    ],
    run(db, { from, to }) {
      const d = h.dateRange('l.created_at', from, to);
      const rows = db.prepare(`
        SELECT COALESCE(NULLIF(TRIM(l.source), ''), 'Not specified') AS source,
               COUNT(*) AS leads,
               SUM(CASE WHEN ${CONVERTED} THEN 1 ELSE 0 END) AS converted,
               COALESCE(SUM(o.amount), 0) AS pipeline_value
        FROM leads l
        LEFT JOIN opportunities o ON o.id = l.converted_opportunity_id
        WHERE 1=1${d.clause}
        GROUP BY source
        ORDER BY leads DESC
      `).all(...d.params);
      return rows.map((r) => ({ ...r, conversion_rate: h.percent(r.converted, r.leads) }));
    },
    summary(rows) {
      const leads = rows.reduce((s, r) => s + r.leads, 0);
      const conv = rows.reduce((s, r) => s + r.converted, 0);
      return [
        { label: 'Total Leads', value: leads, format: 'number' },
        { label: 'Converted', value: conv, format: 'number' },
        { label: 'Conversion Rate', value: h.percent(conv, leads), format: 'percent' },
        { label: 'Sources', value: rows.length, format: 'number' },
      ];
    },
  },

  {
    key: 'lead-status-breakdown',
    label: 'Lead Status Breakdown',
    category: 'Leads',
    module: 'leads',
    description: 'How the open lead base is distributed across statuses. A pile-up in one status is usually a process problem, not a demand problem.',
    dated: true,
    dateLabel: 'Lead created',
    palette: 'violet',
    chart: { type: 'donut', x: 'status', series: [{ key: 'leads', label: 'Leads', format: 'number' }] },
    columns: [
      { key: 'status', label: 'Status' },
      { key: 'leads', label: 'Leads', format: 'number' },
      { key: 'share', label: 'Share', format: 'percent' },
    ],
    run(db, { from, to }) {
      const d = h.dateRange('created_at', from, to);
      const rows = db.prepare(`
        SELECT COALESCE(NULLIF(TRIM(status), ''), 'No status') AS status, COUNT(*) AS leads
        FROM leads WHERE 1=1${d.clause} GROUP BY status ORDER BY leads DESC
      `).all(...d.params);
      const total = rows.reduce((s, r) => s + r.leads, 0);
      return rows.map((r) => ({ ...r, share: h.percent(r.leads, total) }));
    },
  },

  {
    key: 'lead-trend',
    label: 'Lead Volume & Conversion Trend',
    category: 'Leads',
    module: 'leads',
    description: 'New leads per month against the number that went on to convert. Diverging lines mean lead quality is changing, not just lead volume.',
    palette: 'indigo',
    chart: {
      type: 'composed',
      x: 'label',
      series: [
        { key: 'leads', label: 'New Leads', type: 'area', format: 'number' },
        { key: 'converted', label: 'Converted', type: 'line', format: 'number' },
        { key: 'conversion_rate', label: 'Conversion %', type: 'line', axis: 'right', format: 'percent' },
      ],
    },
    columns: [
      { key: 'label', label: 'Month' },
      { key: 'leads', label: 'New Leads', format: 'number' },
      { key: 'converted', label: 'Converted', format: 'number' },
      { key: 'conversion_rate', label: 'Conversion %', format: 'percent' },
    ],
    run(db) {
      const months = h.monthSeries(12);
      const rows = db.prepare(`
        SELECT strftime('%Y-%m', l.created_at) AS month,
               COUNT(*) AS leads,
               SUM(CASE WHEN ${CONVERTED} THEN 1 ELSE 0 END) AS converted
        FROM leads l
        WHERE l.created_at >= date('now', '-13 months')
        GROUP BY month
      `).all();
      return h.fillMonths(rows, months, { leads: 0, converted: 0 })
        .map((r) => ({ ...r, conversion_rate: h.percent(r.converted, r.leads) }));
    },
  },

  {
    key: 'lead-owner-performance',
    label: 'Lead Ownership & Conversion',
    category: 'Leads',
    module: 'leads',
    description: 'Leads held per person and how many they convert. Read the two columns together — a high count with a low conversion rate is a capacity problem.',
    dated: true,
    dateLabel: 'Lead created',
    palette: 'teal',
    chart: {
      type: 'groupedBar',
      x: 'owner',
      series: [
        { key: 'leads', label: 'Leads', format: 'number' },
        { key: 'converted', label: 'Converted', format: 'number' },
      ],
    },
    columns: [
      { key: 'owner', label: 'Owner' },
      { key: 'leads', label: 'Leads', format: 'number' },
      { key: 'converted', label: 'Converted', format: 'number' },
      { key: 'conversion_rate', label: 'Conversion %', format: 'percent' },
    ],
    run(db, { from, to }) {
      const d = h.dateRange('l.created_at', from, to);
      const rows = db.prepare(`
        SELECT COALESCE(NULLIF(TRIM(l.assigned_counselor), ''), 'Unassigned') AS owner,
               COUNT(*) AS leads,
               SUM(CASE WHEN ${CONVERTED} THEN 1 ELSE 0 END) AS converted
        FROM leads l WHERE 1=1${d.clause}
        GROUP BY owner ORDER BY leads DESC
      `).all(...d.params);
      return rows.map((r) => ({ ...r, conversion_rate: h.percent(r.converted, r.leads) }));
    },
  },

  {
    key: 'lead-ageing',
    label: 'Lead Ageing (Untouched Leads)',
    category: 'Leads',
    module: 'leads',
    description: 'How long open leads have been sitting since they were created. Everything to the right of 30 days is, in practice, a lead nobody is working.',
    palette: 'orange',
    chart: { type: 'bar', x: 'label', series: [{ key: 'count', label: 'Open Leads', format: 'number' }] },
    columns: [
      { key: 'label', label: 'Age' },
      { key: 'count', label: 'Open Leads', format: 'number' },
    ],
    run(db) {
      const ages = db.prepare(`
        SELECT ${h.DAYS_BETWEEN('created_at', "datetime('now')")} AS days
        FROM leads l WHERE NOT ${CONVERTED}
      `).all().map((r) => r.days);
      return h.bucketAges(ages);
    },
    summary(rows) {
      const total = rows.reduce((s, r) => s + r.count, 0);
      const stale = rows.filter((r) => ['31–60 days', '61–90 days', '90+ days'].includes(r.label))
        .reduce((s, r) => s + r.count, 0);
      return [
        { label: 'Open Leads', value: total, format: 'number' },
        { label: 'Older Than 30 Days', value: stale, format: 'number' },
        { label: 'Share Stale', value: h.percent(stale, total), format: 'percent' },
      ];
    },
  },

  {
    key: 'lead-geography',
    label: 'Leads by City',
    category: 'Leads',
    module: 'leads',
    description: 'Where leads are coming from geographically. Useful for deciding where field visits, regional pricing or local campaigns are worth running.',
    dated: true,
    dateLabel: 'Lead created',
    palette: 'cyan',
    chart: { type: 'bar', x: 'city', series: [{ key: 'leads', label: 'Leads', format: 'number' }] },
    columns: [
      { key: 'city', label: 'City' },
      { key: 'leads', label: 'Leads', format: 'number' },
      { key: 'converted', label: 'Converted', format: 'number' },
      { key: 'conversion_rate', label: 'Conversion %', format: 'percent' },
    ],
    run(db, { from, to }) {
      const d = h.dateRange('l.created_at', from, to);
      const rows = db.prepare(`
        SELECT COALESCE(NULLIF(TRIM(l.city), ''), 'Not specified') AS city,
               COUNT(*) AS leads,
               SUM(CASE WHEN ${CONVERTED} THEN 1 ELSE 0 END) AS converted
        FROM leads l WHERE 1=1${d.clause}
        GROUP BY city ORDER BY leads DESC LIMIT 25
      `).all(...d.params);
      return rows.map((r) => ({ ...r, conversion_rate: h.percent(r.converted, r.leads) }));
    },
  },

  {
    key: 'campaign-performance',
    label: 'Campaign Performance',
    category: 'Leads',
    module: 'leads',
    description: 'Leads and converted pipeline value attributed to each campaign. This is the report to open before renewing ad spend.',
    dated: true,
    dateLabel: 'Lead created',
    palette: 'rose',
    chart: {
      type: 'composed',
      x: 'campaign',
      series: [
        { key: 'leads', label: 'Leads', type: 'bar', format: 'number' },
        { key: 'pipeline_value', label: 'Pipeline Value', type: 'line', axis: 'right', format: 'currency' },
      ],
    },
    columns: [
      { key: 'campaign', label: 'Campaign' },
      { key: 'leads', label: 'Leads', format: 'number' },
      { key: 'converted', label: 'Converted', format: 'number' },
      { key: 'conversion_rate', label: 'Conversion %', format: 'percent' },
      { key: 'pipeline_value', label: 'Pipeline Value', format: 'currency' },
    ],
    run(db, { from, to }) {
      const d = h.dateRange('l.created_at', from, to);
      const rows = db.prepare(`
        SELECT COALESCE(NULLIF(TRIM(l.campaign), ''), 'No campaign') AS campaign,
               COUNT(*) AS leads,
               SUM(CASE WHEN ${CONVERTED} THEN 1 ELSE 0 END) AS converted,
               COALESCE(SUM(o.amount), 0) AS pipeline_value
        FROM leads l
        LEFT JOIN opportunities o ON o.id = l.converted_opportunity_id
        WHERE 1=1${d.clause}
        GROUP BY campaign ORDER BY leads DESC
      `).all(...d.params);
      return rows.map((r) => ({ ...r, conversion_rate: h.percent(r.converted, r.leads) }));
    },
  },

  {
    key: 'lead-rating-mix',
    label: 'Lead Rating & Score Mix',
    category: 'Leads',
    module: 'leads',
    description: 'The quality mix of the lead base by rating, with the average score in each band. If almost everything is one rating, the rating is not being used.',
    dated: true,
    dateLabel: 'Lead created',
    palette: 'amber',
    chart: { type: 'pie', x: 'rating', series: [{ key: 'leads', label: 'Leads', format: 'number' }] },
    columns: [
      { key: 'rating', label: 'Rating' },
      { key: 'leads', label: 'Leads', format: 'number' },
      { key: 'avg_score', label: 'Avg Score', format: 'number' },
      { key: 'share', label: 'Share', format: 'percent' },
    ],
    run(db, { from, to }) {
      const d = h.dateRange('created_at', from, to);
      const rows = db.prepare(`
        SELECT COALESCE(NULLIF(TRIM(lead_rating), ''), 'Unrated') AS rating,
               COUNT(*) AS leads,
               ROUND(AVG(COALESCE(lead_score, 0)), 1) AS avg_score
        FROM leads WHERE 1=1${d.clause} GROUP BY rating ORDER BY leads DESC
      `).all(...d.params);
      const total = rows.reduce((s, r) => s + r.leads, 0);
      return rows.map((r) => ({ ...r, share: h.percent(r.leads, total) }));
    },
  },

  {
    key: 'lead-detail',
    label: 'Lead Register (Detailed)',
    category: 'Leads',
    module: 'leads',
    description: 'The underlying lead list behind every other lead report — one row per lead, ready to export and work through.',
    dated: true,
    dateLabel: 'Lead created',
    palette: 'slate',
    chart: null,
    filters: [
      { key: 'status', label: 'Status', type: 'select', source: { table: 'leads', column: 'status' } },
      { key: 'source', label: 'Source', type: 'select', source: { table: 'leads', column: 'source' } },
    ],
    columns: [
      { key: 'name', label: 'Lead Name' },
      { key: 'account_name', label: 'Company' },
      { key: 'mobile', label: 'Mobile' },
      { key: 'email', label: 'Email' },
      { key: 'city', label: 'City' },
      { key: 'source', label: 'Source' },
      { key: 'status', label: 'Status', format: 'status' },
      { key: 'owner', label: 'Owner' },
      { key: 'created_at', label: 'Created', format: 'date' },
      { key: 'age_days', label: 'Age (days)', format: 'number' },
      { key: 'converted', label: 'Converted' },
    ],
    run(db, { from, to, filters = {} }) {
      const d = h.dateRange('l.created_at', from, to);
      const params = [...d.params];
      let where = `WHERE 1=1${d.clause}`;
      if (filters.status) { where += ' AND l.status = ?'; params.push(filters.status); }
      if (filters.source) { where += ' AND l.source = ?'; params.push(filters.source); }
      return db.prepare(`
        SELECT l.student_name AS name, l.account_name, l.mobile, l.email, l.city, l.source, l.status,
               COALESCE(NULLIF(TRIM(l.assigned_counselor), ''), 'Unassigned') AS owner,
               l.created_at,
               CAST(${h.DAYS_BETWEEN('l.created_at', "datetime('now')")} AS INTEGER) AS age_days,
               CASE WHEN ${CONVERTED} THEN 'Yes' ELSE 'No' END AS converted
        FROM leads l ${where}
        ORDER BY l.created_at DESC
        LIMIT 5000
      `).all(...params);
    },
  },
];
