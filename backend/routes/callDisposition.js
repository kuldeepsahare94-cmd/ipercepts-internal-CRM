// Call disposition + call analytics.
//
// The dispose flow mirrors how a dialler actually works:
//   1. Agent opens Dispose on a lead -> the client starts a timer.
//   2. Agent answers "was it connected?", picks a disposition, optionally
//      sets a follow-up.
//   3. Client POSTs here with the elapsed seconds. The server is the one
//      that stamps disposed_at, so report timestamps can't be spoofed by a
//      wrong clock on the agent's machine.
//
// Mount: app.use('/api/calls', requireAuth, require('./routes/callDisposition'));
// (mounted BEFORE routes/calls.js so these specific paths win over the
// generic /:id handlers in the activity router)

const express = require('express');
const router = express.Router();
const db = require('../db');
const { requirePermission } = require('../middleware/auth');
const { fireWorkflows } = require('../services/workflowAutomation');

const hhmmss = (totalSeconds) => {
  const s = Math.max(0, Math.round(totalSeconds || 0));
  return [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60]
    .map((n) => String(n).padStart(2, '0')).join(':');
};

// POST /api/calls/dispose
router.post('/dispose', requirePermission('calls', 'create'), (req, res) => {
  const b = req.body || {};
  if (b.connected === undefined || b.connected === null) {
    return res.status(400).json({ error: 'connected (true/false) is required' });
  }
  if (!b.disposition) return res.status(400).json({ error: 'disposition is required' });

  const durationSeconds = Math.max(0, Math.round(Number(b.duration_seconds) || 0));
  const formSeconds = Math.max(0, Math.round(Number(b.form_seconds) || 0));
  const connected = b.connected ? 1 : 0;

  // Subject reads well in the activity timeline without the agent typing one.
  const subject = b.call_subject
    || `${connected ? 'Connected' : 'Not connected'} — ${b.disposition}`;

  const info = db.prepare(`
    INSERT INTO calls (
      call_subject, related_module, related_record_id, phone_number, call_type, direction,
      start_time, duration_seconds, duration_minutes, connected, status, call_outcome,
      notes, follow_up_date, next_action, assigned_user_id, created_by, disposed_at, form_seconds
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'),?)
  `).run(
    subject, b.related_module || 'leads', b.related_record_id || null, b.phone_number || null,
    b.call_type || 'Sales Call', b.direction || 'Outbound',
    b.start_time || new Date(Date.now() - durationSeconds * 1000).toISOString(),
    durationSeconds,
    Math.round(durationSeconds / 60),          // kept in sync for existing readers
    connected,
    connected ? 'Completed' : 'No Answer',
    b.disposition,
    b.notes || null, b.follow_up_date || null, b.next_action || null,
    req.user.id, req.user.id, formSeconds
  );

  // Optionally move the lead's own status/follow-up in the same action, so
  // the agent doesn't have to edit the lead separately after every call.
  if (b.related_module === 'leads' && b.related_record_id) {
    if (b.lead_status) {
      db.prepare('UPDATE leads SET status=? WHERE id=?').run(b.lead_status, b.related_record_id);
    }
    if (b.follow_up_date) {
      db.prepare('UPDATE leads SET follow_up_date=? WHERE id=?').run(b.follow_up_date, b.related_record_id);
    }
    db.prepare('INSERT INTO lead_activities (lead_id, type, note) VALUES (?,?,?)')
      .run(b.related_record_id, 'call',
        `${connected ? 'Connected' : 'Not connected'} · ${b.disposition} · ${hhmmss(durationSeconds)}${b.notes ? ` — ${b.notes}` : ''}`);
  }

  const created = db.prepare('SELECT * FROM calls WHERE id=?').get(info.lastInsertRowid);
  fireWorkflows('calls', 'record_created', created, null, req.user.id);
  res.status(201).json(created);
});

// GET /api/calls/report?from=&to=&user_id=
// Non-admins are scoped to their own calls; the UI hides the user filter
// for them, but the server enforces it rather than trusting the client.
router.get('/report', requirePermission('calls', 'view'), (req, res) => {
  const canSeeAll = !!req.user.permissions?.users?.view;
  const from = req.query.from || new Date().toISOString().slice(0, 10);
  const to = req.query.to || from;
  const userId = canSeeAll ? (req.query.user_id || null) : req.user.id;

  const where = [`date(COALESCE(c.disposed_at, c.created_at)) BETWEEN date(?) AND date(?)`];
  const params = [from, to];
  if (userId) { where.push('c.assigned_user_id = ?'); params.push(userId); }
  const W = where.join(' AND ');

  const one = (sql, ...p) => db.prepare(sql).get(...p) || {};

  const overview = one(`
    SELECT
      COUNT(*)                                            AS total_calls,
      COALESCE(SUM(CASE WHEN c.connected=1 THEN 1 ELSE 0 END),0) AS connected_calls,
      COALESCE(SUM(CASE WHEN c.connected=0 THEN 1 ELSE 0 END),0) AS unconnected_calls,
      COALESCE(SUM(c.duration_seconds),0)                 AS total_seconds,
      COALESCE(AVG(c.duration_seconds),0)                 AS avg_seconds,
      COALESCE(AVG(NULLIF(c.form_seconds,0)),0)           AS avg_form_seconds,
      COALESCE(SUM(CASE WHEN c.direction='Outbound' THEN 1 ELSE 0 END),0) AS outbound,
      COALESCE(SUM(CASE WHEN c.direction='Inbound'  THEN 1 ELSE 0 END),0) AS inbound
    FROM calls c WHERE ${W}
  `, ...params);

  // Talk time is only meaningful across connected calls — averaging in
  // zero-length unconnected attempts would understate it badly.
  const connectedAvg = one(`
    SELECT COALESCE(AVG(c.duration_seconds),0) AS v FROM calls c WHERE ${W} AND c.connected=1
  `, ...params).v || 0;

  const dispositions = db.prepare(`
    SELECT c.call_outcome AS disposition,
           COUNT(*) AS count,
           COALESCE(SUM(c.duration_seconds),0) AS total_seconds,
           MAX(c.connected) AS connected
    FROM calls c WHERE ${W} AND c.call_outcome IS NOT NULL
    GROUP BY c.call_outcome ORDER BY count DESC
  `).all(...params);

  const byAgent = canSeeAll ? db.prepare(`
    SELECT COALESCE(u.full_name, u.username, 'Unassigned') AS agent,
           COUNT(*) AS total_calls,
           COALESCE(SUM(CASE WHEN c.connected=1 THEN 1 ELSE 0 END),0) AS connected_calls,
           COALESCE(SUM(c.duration_seconds),0) AS total_seconds
    FROM calls c LEFT JOIN users u ON u.id = c.assigned_user_id
    WHERE ${W} GROUP BY c.assigned_user_id ORDER BY total_calls DESC
  `).all(...params) : [];

  const byDay = db.prepare(`
    SELECT date(COALESCE(c.disposed_at, c.created_at)) AS day,
           COUNT(*) AS total_calls,
           COALESCE(SUM(CASE WHEN c.connected=1 THEN 1 ELSE 0 END),0) AS connected_calls,
           COALESCE(SUM(c.duration_seconds),0) AS total_seconds
    FROM calls c WHERE ${W} GROUP BY day ORDER BY day
  `).all(...params);

  // Follow-up health, scoped to the same agent where one is selected.
  const today = new Date().toISOString().slice(0, 10);
  const leadWhere = userId ? 'AND l.assigned_counselor = (SELECT COALESCE(full_name, username) FROM users WHERE id=?)' : '';
  const leadParams = userId ? [userId] : [];

  const dueToday = one(`SELECT COUNT(*) c FROM leads l WHERE date(l.follow_up_date)=date(?) ${leadWhere}`, today, ...leadParams).c || 0;
  const overdue = one(`SELECT COUNT(*) c FROM leads l WHERE l.follow_up_date IS NOT NULL AND date(l.follow_up_date) < date(?) AND l.status NOT IN ('Converted','Not Interested','Dropped') ${leadWhere}`, today, ...leadParams).c || 0;
  const doneToday = one(`SELECT COUNT(DISTINCT c.related_record_id) c FROM calls c WHERE c.related_module='leads' AND date(COALESCE(c.disposed_at,c.created_at))=date(?) ${userId ? 'AND c.assigned_user_id=?' : ''}`, today, ...(userId ? [userId] : [])).c || 0;

  const connectRate = overview.total_calls ? (overview.connected_calls / overview.total_calls) * 100 : 0;
  // Compliance = of the follow-ups that were due, how many were actually
  // called. Reported as null (not 0%) when nothing was due, since 0% would
  // wrongly read as a failure.
  const dueTotal = dueToday + overdue;
  const compliance = dueTotal > 0 ? Math.min(100, (doneToday / dueTotal) * 100) : null;

  res.json({
    range: { from, to, user_id: userId ? Number(userId) : null, scoped: !canSeeAll },
    overview: {
      total_calls: overview.total_calls || 0,
      connected_calls: overview.connected_calls || 0,
      unconnected_calls: overview.unconnected_calls || 0,
      outbound: overview.outbound || 0,
      inbound: overview.inbound || 0,
      total_talk_time: hhmmss(overview.total_seconds),
      total_seconds: overview.total_seconds || 0,
      avg_call_duration: hhmmss(overview.avg_seconds),
      avg_connected_duration: hhmmss(connectedAvg),
      avg_form_time: hhmmss(overview.avg_form_seconds),
      connect_rate: Math.round(connectRate * 10) / 10,
    },
    follow_ups: {
      due_today: dueToday,
      overdue,
      leads_called_today: doneToday,
      compliance_percent: compliance === null ? null : Math.round(compliance * 10) / 10,
    },
    dispositions: dispositions.map((d) => ({
      ...d,
      total_talk_time: hhmmss(d.total_seconds),
      percent: overview.total_calls ? Math.round((d.count / overview.total_calls) * 1000) / 10 : 0,
    })),
    by_agent: byAgent.map((a) => ({
      ...a,
      total_talk_time: hhmmss(a.total_seconds),
      connect_rate: a.total_calls ? Math.round((a.connected_calls / a.total_calls) * 1000) / 10 : 0,
    })),
    by_day: byDay.map((d) => ({ ...d, total_talk_time: hhmmss(d.total_seconds) })),
  });
});

module.exports = router;
