const express = require('express');
const router = express.Router();
const db = require('../db');
const { requireAuth } = require('../middleware/auth');


// ============================================================================
// Universal CRM dashboard (master prompt section 17). Kept in this same file
// since it's additive to the existing dashboard route, not a replacement —
// GET /api/dashboard still returns the original placement/education view
// unchanged; this is a second, separate summary the frontend renders as a
// second tab.
// ============================================================================
router.get('/crm', requireAuth, (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const monthStart = today.slice(0, 7) + '-01';
  const count = (sql, ...params) => db.prepare(sql).get(...params).c;
  const sum = (sql, ...params) => db.prepare(sql).get(...params).s || 0;

  const cards = {
    total_leads: count('SELECT COUNT(*) c FROM leads'),
    open_opportunities: count(`
      SELECT COUNT(*) c FROM opportunities o LEFT JOIN module_pipeline_stages s ON s.id=o.stage_id
      WHERE COALESCE(s.is_won,0)=0 AND COALESCE(s.is_lost,0)=0
    `),
    pipeline_value: sum(`
      SELECT COALESCE(SUM(o.amount),0) s FROM opportunities o LEFT JOIN module_pipeline_stages st ON st.id=o.stage_id
      WHERE COALESCE(st.is_won,0)=0 AND COALESCE(st.is_lost,0)=0
    `),
    weighted_pipeline: sum(`
      SELECT COALESCE(SUM(o.amount * COALESCE(o.probability, st.probability, 0) / 100.0),0) s
      FROM opportunities o LEFT JOIN module_pipeline_stages st ON st.id=o.stage_id
      WHERE COALESCE(st.is_won,0)=0 AND COALESCE(st.is_lost,0)=0
    `),
    won_revenue_month: sum(`
      SELECT COALESCE(SUM(o.amount),0) s FROM opportunities o JOIN module_pipeline_stages st ON st.id=o.stage_id
      WHERE st.is_won=1 AND date(o.updated_at) >= date(?)
    `, monthStart),
    lost_this_month: count(`
      SELECT COUNT(*) c FROM opportunities o JOIN module_pipeline_stages st ON st.id=o.stage_id
      WHERE st.is_lost=1 AND date(o.updated_at) >= date(?)
    `, monthStart),
    open_tickets: count(`SELECT COUNT(*) c FROM tickets WHERE status NOT IN ('Resolved','Closed')`),
    overdue_tasks: count(`SELECT COUNT(*) c FROM tasks WHERE status != 'Completed' AND due_date IS NOT NULL AND date(due_date) < date(?)`, today),
    todays_calls: count(`SELECT COUNT(*) c FROM calls WHERE date(COALESCE(start_time, created_at)) = date(?)`, today),
    todays_meetings: count(`SELECT COUNT(*) c FROM meetings WHERE date(COALESCE(start_datetime, created_at)) = date(?)`, today),
    followups_due_today: count(`
      SELECT COUNT(*) c FROM (
        SELECT follow_up_date d FROM leads WHERE date(follow_up_date) = date(?)
        UNION ALL SELECT next_followup d FROM contacts WHERE date(next_followup) = date(?)
        UNION ALL SELECT expected_close_date d FROM opportunities WHERE date(expected_close_date) = date(?)
      )
    `, today, today, today),
    followups_overdue: count(`
      SELECT COUNT(*) c FROM (
        SELECT follow_up_date d FROM leads WHERE follow_up_date IS NOT NULL AND date(follow_up_date) < date(?)
        UNION ALL SELECT next_followup d FROM contacts WHERE next_followup IS NOT NULL AND date(next_followup) < date(?)
        UNION ALL SELECT expected_close_date d FROM opportunities WHERE expected_close_date IS NOT NULL AND date(expected_close_date) < date(?)
      )
    `, today, today, today),
  };

  // MRR/ARR — normalize every billing cycle to a monthly figure so they're
  // comparable, same logic as routes/subscriptions.js's /summary endpoint.
  const activeSubs = db.prepare(`SELECT recurring_amount, billing_cycle FROM subscriptions WHERE status='Active'`).all();
  const monthly = (s) => (s.billing_cycle === 'Yearly' ? s.recurring_amount / 12 : s.billing_cycle === 'Quarterly' ? s.recurring_amount / 3 : s.recurring_amount);
  const mrr = activeSubs.reduce((total, s) => total + monthly(s), 0);
  cards.mrr = mrr;
  cards.arr = mrr * 12;

  const leads_by_source = db.prepare(`
    SELECT COALESCE(source, 'Unknown') AS source, COUNT(*) c FROM leads GROUP BY source ORDER BY c DESC LIMIT 8
  `).all();

  const opportunities_by_stage = db.prepare(`
    SELECT s.name AS stage, s.color, COUNT(o.id) c, COALESCE(SUM(o.amount),0) total
    FROM module_pipeline_stages s
    JOIN module_pipelines p ON p.id = s.pipeline_id AND p.is_default = 1
    JOIN modules m ON m.id = p.module_id AND m.api_name = 'opportunities'
    LEFT JOIN opportunities o ON o.stage_id = s.id
    GROUP BY s.id ORDER BY s.sort_order
  `).all();

  const revenue_by_month = db.prepare(`
    SELECT strftime('%Y-%m', payment_date) month, COALESCE(SUM(amount),0) revenue
    FROM subscription_payments WHERE status='Paid' AND payment_date IS NOT NULL
    GROUP BY month ORDER BY month DESC LIMIT 6
  `).all().reverse();

  // Global recent-activity feed — same five-table union as routes/activities.js,
  // but without a related_record filter, so this is "what happened recently
  // across the whole CRM" rather than one record's timeline.
  const recentSources = [
    { type: 'call', table: 'calls', titleCol: 'call_subject', dateCol: 'start_time' },
    { type: 'meeting', table: 'meetings', titleCol: 'meeting_title', dateCol: 'start_datetime' },
    { type: 'task', table: 'tasks', titleCol: 'task_title', dateCol: 'due_date' },
    { type: 'note', table: 'notes', titleCol: 'body', dateCol: 'created_at' },
    { type: 'email', table: 'emails', titleCol: 'subject', dateCol: 'sent_at' },
  ];
  let recent_activities = [];
  for (const s of recentSources) {
    const rows = db.prepare(`
      SELECT id, ${s.titleCol} AS title, related_module, related_record_id, created_at,
        COALESCE(${s.dateCol}, created_at) AS activity_date
      FROM ${s.table} ORDER BY created_at DESC LIMIT 10
    `).all();
    rows.forEach((r) => recent_activities.push({ ...r, type: s.type }));
  }
  recent_activities.sort((a, b) => new Date(b.activity_date) - new Date(a.activity_date));
  recent_activities = recent_activities.slice(0, 8);


  // ---- Executive additions (brief §8): answer "what is happening in my
  // CRM today?" rather than only showing totals. All real data.

  // Today's agenda — what actually needs doing, not a generic counter.
  //
  // Six rows each, deliberately. The dashboard shows five and a "view all"
  // link, so six is enough to know a sixth exists without shipping a list
  // nobody reads: with 66 tasks due, the old LIMIT 10 sent ten rows that
  // stretched the card to ten rows tall and pushed everything below it off
  // the screen. How many there really are is answered by agenda_counts,
  // which costs three COUNT(*)s rather than the rows themselves.
  const agenda = {
    follow_ups: db.prepare(`
      SELECT id, student_name AS title, mobile, status, follow_up_date
      FROM leads WHERE date(follow_up_date) = date(?) ORDER BY student_name LIMIT 6`).all(today),
    meetings: db.prepare(`
      SELECT id, meeting_title AS title, start_datetime, related_module, related_record_id
      FROM meetings WHERE date(COALESCE(start_datetime, created_at)) = date(?) ORDER BY start_datetime LIMIT 6`).all(today),
    tasks_due: db.prepare(`
      SELECT id, task_title AS title, priority, due_date, related_module, related_record_id
      FROM tasks WHERE status != 'Completed' AND date(due_date) <= date(?) ORDER BY due_date LIMIT 6`).all(today),
  };

  const agenda_counts = {
    follow_ups: count('SELECT COUNT(*) c FROM leads WHERE date(follow_up_date) = date(?)', today),
    meetings: count('SELECT COUNT(*) c FROM meetings WHERE date(COALESCE(start_datetime, created_at)) = date(?)', today),
    tasks_due: count(`SELECT COUNT(*) c FROM tasks WHERE status != 'Completed' AND date(due_date) <= date(?)`, today),
  };

  // Win rate over closed deals only — including open deals in the
  // denominator would understate it and drift as the pipeline grows.
  const closed = db.prepare(`
    SELECT COALESCE(SUM(CASE WHEN s.is_won=1 THEN 1 ELSE 0 END),0) won,
           COALESCE(SUM(CASE WHEN s.is_lost=1 THEN 1 ELSE 0 END),0) lost
    FROM opportunities o JOIN module_pipeline_stages s ON s.id=o.stage_id
    WHERE s.is_won=1 OR s.is_lost=1`).get();
  const closedTotal = (closed.won || 0) + (closed.lost || 0);
  const performance = {
    won: closed.won || 0,
    lost: closed.lost || 0,
    // null rather than 0 when nothing has closed — 0% would read as failure.
    win_rate: closedTotal > 0 ? Math.round((closed.won / closedTotal) * 1000) / 10 : null,
    avg_deal_size: closed.won > 0
      ? Math.round(db.prepare(`SELECT COALESCE(AVG(o.amount),0) v FROM opportunities o
          JOIN module_pipeline_stages s ON s.id=o.stage_id WHERE s.is_won=1`).get().v)
      : 0,
  };

  // ---- Money actually collected, not just money invoiced ------------------
  // A pipeline figure is a forecast; this is the only block on the dashboard
  // that reports cash. `balance_due` is maintained by documentPayments on
  // every recorded payment, so it's authoritative rather than re-derived
  // here. Cancelled invoices are excluded — an invoice that was voided was
  // never owed, and counting it would inflate outstanding forever.
  const collections = (() => {
    const totals = db.prepare(`
      SELECT COALESCE(SUM(grand_total), 0) invoiced,
             COALESCE(SUM(amount_paid), 0) collected,
             COALESCE(SUM(balance_due), 0) outstanding,
             COUNT(*) c
      FROM sales_documents
      WHERE doc_type = 'invoice' AND COALESCE(status, '') != 'Cancelled'`).get();
    const overdue = db.prepare(`
      SELECT COALESCE(SUM(balance_due), 0) amount, COUNT(*) c
      FROM sales_documents
      WHERE doc_type = 'invoice' AND COALESCE(status, '') != 'Cancelled'
        AND COALESCE(balance_due, 0) > 0
        AND due_date IS NOT NULL AND date(due_date) < date(?)`).get(today);
    return {
      invoiced: totals.invoiced,
      collected: totals.collected,
      outstanding: totals.outstanding,
      invoice_count: totals.c,
      overdue_amount: overdue.amount,
      overdue_count: overdue.c,
      // Share of everything invoiced that has actually come in. null (not 0)
      // when nothing has been invoiced at all, so the UI can say "no
      // invoices yet" instead of showing a 0% that looks like a collections
      // failure.
      collected_pct: totals.invoiced > 0 ? Math.round((totals.collected / totals.invoiced) * 1000) / 10 : null,
    };
  })();

  // ---- Who is actually closing business ------------------------------------
  // Grouped by owner_id (not name) so two people who happen to share a
  // display name stay separate rows, and ordered by value rather than count
  // — five small wins is not the same contribution as one large one.
  const leaderboard = db.prepare(`
    SELECT COALESCE(u.full_name, u.username, 'Unassigned') AS name,
           COUNT(o.id) AS won,
           COALESCE(SUM(o.amount), 0) AS value
    FROM opportunities o
    JOIN module_pipeline_stages s ON s.id = o.stage_id AND s.is_won = 1
    LEFT JOIN users u ON u.id = o.owner_id
    GROUP BY o.owner_id
    ORDER BY value DESC
    LIMIT 5`).all();

  // ---- Support load, open tickets only -------------------------------------
  // Ordered by how much they should worry someone rather than alphabetically,
  // so Urgent is never buried under Low.
  const PRIORITY_RANK = { Urgent: 0, High: 1, Medium: 2, Low: 3 };
  const ticket_load = db.prepare(`
    SELECT COALESCE(priority, 'Unset') AS priority, COUNT(*) c
    FROM tickets WHERE status NOT IN ('Resolved', 'Closed')
    GROUP BY priority`).all()
    .sort((a, b) => (PRIORITY_RANK[a.priority] ?? 9) - (PRIORITY_RANK[b.priority] ?? 9));

  // Things that need a human decision, ranked.
  const attention = [];
  const overdueFollowUps = count(`SELECT COUNT(*) c FROM leads
    WHERE follow_up_date IS NOT NULL AND date(follow_up_date) < date(?)
    AND status NOT IN ('Converted','Not Interested','Dropped')`, today);
  if (overdueFollowUps) attention.push({ severity: 'high', text: `${overdueFollowUps} overdue lead follow-up(s)`, link: '/leads' });
  const urgentTickets = count(`SELECT COUNT(*) c FROM tickets
    WHERE status NOT IN ('Resolved','Closed') AND priority IN ('High','Urgent')`);
  if (urgentTickets) attention.push({ severity: 'high', text: `${urgentTickets} high-priority ticket(s) open`, link: '/records/tickets' });
  const overdueTasks = count(`SELECT COUNT(*) c FROM tasks
    WHERE status != 'Completed' AND due_date IS NOT NULL AND date(due_date) < date(?)`, today);
  if (overdueTasks) attention.push({ severity: 'high', text: `${overdueTasks} overdue task(s)`, link: '/records/tasks' });
  const staleDeals = count(`SELECT COUNT(*) c FROM opportunities o
    LEFT JOIN module_pipeline_stages s ON s.id=o.stage_id
    WHERE COALESCE(s.is_won,0)=0 AND COALESCE(s.is_lost,0)=0
    AND julianday('now') - julianday(o.updated_at) > 30`);
  if (staleDeals) attention.push({ severity: 'medium', text: `${staleDeals} deal(s) with no movement in 30+ days`, link: '/records/opportunities' });
  const expiringQuotes = count(`SELECT COUNT(*) c FROM quotations
    WHERE status='Sent' AND valid_until IS NOT NULL AND date(valid_until) < date(?)`, today);
  if (expiringQuotes) attention.push({ severity: 'medium', text: `${expiringQuotes} quotation(s) past their valid-until date`, link: '/records/quotations' });
  const renewals = count(`SELECT COUNT(*) c FROM subscriptions
    WHERE status='Active' AND renewal_date IS NOT NULL
    AND julianday(renewal_date) - julianday('now') BETWEEN 0 AND 30`);
  if (renewals) attention.push({ severity: 'medium', text: `${renewals} subscription(s) renewing within 30 days`, link: '/records/subscriptions' });


  // ---- Trend deltas (real, not decorative) -------------------------------
  // Every figure here is computed by comparing actual record counts in two
  // real date windows. Nothing is estimated or seeded — if a metric can't
  // be compared honestly it returns null and the UI simply shows no delta
  // rather than an invented one.
  //
  // "This week" = the last 7 days including today. "Last week" = the 7 days
  // before that. A rolling window rather than calendar weeks, so the number
  // means the same thing whichever day you look at it.
  const trends = {
    // Leads created in the last 7 days vs the 7 before.
    total_leads: (() => {
      const thisWeek = count(`SELECT COUNT(*) c FROM leads WHERE date(created_at) > date(?, '-7 day')`, today);
      const lastWeek = count(`SELECT COUNT(*) c FROM leads WHERE date(created_at) > date(?, '-14 day') AND date(created_at) <= date(?, '-7 day')`, today, today);
      return { current: thisWeek, previous: lastWeek, delta: thisWeek - lastWeek, unit: 'count', label: 'this week' };
    })(),

    // Open opportunities now vs those that existed a week ago. Counted by
    // creation date, since a deal created inside the window is genuinely
    // new pipeline.
    open_opportunities: (() => {
      const created = count(`
        SELECT COUNT(*) c FROM opportunities o LEFT JOIN module_pipeline_stages s ON s.id=o.stage_id
        WHERE COALESCE(s.is_won,0)=0 AND COALESCE(s.is_lost,0)=0 AND date(o.created_at) > date(?, '-7 day')`, today);
      const closed = count(`
        SELECT COUNT(*) c FROM opportunities o JOIN module_pipeline_stages s ON s.id=o.stage_id
        WHERE (s.is_won=1 OR s.is_lost=1) AND date(o.updated_at) > date(?, '-7 day')`, today);
      return { current: created, previous: closed, delta: created - closed, unit: 'count', label: 'from last week' };
    })(),

    // Pipeline value added in the last 7 days, as a percentage of the value
    // that already existed. Returns null when there was no prior pipeline —
    // a percentage change from zero is meaningless, not "infinite growth".
    pipeline_value: (() => {
      const addedThisWeek = sum(`
        SELECT COALESCE(SUM(o.amount),0) s FROM opportunities o LEFT JOIN module_pipeline_stages st ON st.id=o.stage_id
        WHERE COALESCE(st.is_won,0)=0 AND COALESCE(st.is_lost,0)=0 AND date(o.created_at) > date(?, '-7 day')`, today);
      const priorValue = sum(`
        SELECT COALESCE(SUM(o.amount),0) s FROM opportunities o LEFT JOIN module_pipeline_stages st ON st.id=o.stage_id
        WHERE COALESCE(st.is_won,0)=0 AND COALESCE(st.is_lost,0)=0 AND date(o.created_at) <= date(?, '-7 day')`, today);
      if (priorValue <= 0) return null;
      return { current: addedThisWeek, previous: priorValue, delta: Math.round((addedThisWeek / priorValue) * 1000) / 10, unit: 'percent', label: 'this week' };
    })(),
  };

  res.json({
    cards, trends, agenda, agenda_counts, performance, attention,
    collections, leaderboard, ticket_load,
    leads_by_source, opportunities_by_stage, revenue_by_month, recent_activities,
  });
});

module.exports = router;
