const express = require('express');
const router = express.Router();
const db = require('../db');

function isRead(key) {
  return !!db.prepare('SELECT 1 FROM notification_reads WHERE notification_key = ?').get(key);
}

function buildNotifications(userId) {
  const items = [];
  const today = new Date().toISOString().slice(0, 10);

  // New Lead Assigned (today)
  const newLeads = db.prepare(`SELECT id, student_name, assigned_counselor, created_at FROM leads WHERE date(created_at) = date(?) AND assigned_counselor IS NOT NULL`).all(today);
  for (const l of newLeads) {
    const key = `lead-new-${l.id}`;
    items.push({ key, type: 'new_lead_assigned', title: 'New Lead Assigned', message: `${l.student_name} → ${l.assigned_counselor}`, link: `/leads/${l.id}`, date: l.created_at, read: isRead(key) });
  }

  // Upcoming Follow-up
  const followups = db.prepare(`SELECT id, student_name, follow_up_date FROM leads WHERE follow_up_date IS NOT NULL AND date(follow_up_date) <= date(?) AND status NOT IN ('Converted','Dropped')`).all(today);
  for (const l of followups) {
    const key = `followup-${l.id}`;
    items.push({ key, type: 'upcoming_followup', title: 'Upcoming Follow-up', message: l.student_name, link: `/leads/${l.id}`, date: l.follow_up_date, read: isRead(key) });
  }

  // Admission Created (today)
  const admissions = db.prepare(`SELECT a.id, a.created_at, s.student_name FROM admissions a JOIN students s ON s.id = a.student_id WHERE date(a.created_at) = date(?)`).all(today);
  for (const a of admissions) {
    const key = `admission-${a.id}`;
    items.push({ key, type: 'admission_created', title: 'Admission Created', message: a.student_name, link: `/admissions/${a.id}`, date: a.created_at, read: isRead(key) });
  }

  // Payment Due / Payment Received
  const payments = db.prepare(`SELECT p.id, p.status, p.amount, p.created_at, s.student_name FROM payments p JOIN students s ON s.id = p.student_id WHERE p.status IN ('Pending','Partial','Paid') ORDER BY p.created_at DESC LIMIT 50`).all();
  for (const p of payments) {
    const due = p.status === 'Pending' || p.status === 'Partial';
    const key = `payment-${p.id}-${p.status}`;
    items.push({
      key, type: due ? 'payment_due' : 'payment_received',
      title: due ? 'Payment Due' : 'Payment Received',
      message: `${p.student_name} · ₹${Number(p.amount).toLocaleString('en-IN')}`,
      link: `/payments/${p.id}`, date: p.created_at, read: isRead(key),
    });
  }

  // Interview Scheduled / Reminder / Result Updated
  const placements = db.prepare(`SELECT pl.id, pl.interview_status, pl.interview_date, pl.result, pl.created_at, s.student_name, co.company_name FROM placements pl JOIN students s ON s.id = pl.student_id JOIN companies co ON co.id = pl.company_id`).all();
  for (const p of placements) {
    if (p.interview_status === 'Scheduled') {
      const key = `interview-scheduled-${p.id}`;
      items.push({ key, type: 'interview_scheduled', title: 'Interview Scheduled', message: `${p.student_name} · ${p.company_name}`, link: `/placements/${p.id}`, date: p.created_at, read: isRead(key) });
      if (p.interview_date && p.interview_date.slice(0, 10) === today) {
        const rKey = `interview-reminder-${p.id}`;
        items.push({ key: rKey, type: 'interview_reminder', title: 'Interview Reminder — Today', message: `${p.student_name} · ${p.company_name}`, link: `/placements/${p.id}`, date: p.interview_date, read: isRead(rKey) });
      }
    }
    if (p.result) {
      const key = `placement-result-${p.id}`;
      items.push({ key, type: 'placement_result_updated', title: 'Placement Result Updated', message: `${p.student_name} · ${p.company_name} · ${p.result}`, link: `/placements/${p.id}`, date: p.created_at, read: isRead(key) });
    }
  }

  // WhatsApp: unread inbound messages
  const unreadConvos = db.prepare(`SELECT id, phone_number, entity_name, last_message_preview, last_message_at FROM whatsapp_conversations WHERE unread_count > 0`).all();
  for (const c of unreadConvos) {
    const key = `whatsapp-unread-${c.id}-${c.last_message_at}`;
    items.push({
      key, type: 'whatsapp_message', title: 'New WhatsApp Message',
      message: `${c.entity_name || c.phone_number}: ${c.last_message_preview || ''}`,
      link: `/whatsapp/inbox/${c.id}`, date: c.last_message_at, read: isRead(key),
    });
  }

  // Ad-hoc notifications from the general Workflow Automation engine's
  // "create_notification" action — everything above this is computed/
  // derived; these are the one kind that's actually inserted as a row.
  const workflowNotifs = db.prepare(`SELECT * FROM crm_workflow_notifications WHERE user_id IS NULL OR user_id = ? ORDER BY created_at DESC LIMIT 50`).all(userId || null);
  for (const n of workflowNotifs) {
    const key = `workflow-${n.id}`;
    items.push({ key, type: 'workflow_notification', title: n.title, message: n.message || '', link: n.link || null, date: n.created_at, read: isRead(key) });
  }

  items.sort((a, b) => new Date(b.date) - new Date(a.date));
  return items;
}

router.get('/', (req, res) => {
  const items = buildNotifications(req.user.id);
  res.json({ items, unread: items.filter((i) => !i.read).length });
});

router.post('/:key/read', (req, res) => {
  db.prepare('INSERT OR IGNORE INTO notification_reads (notification_key) VALUES (?)').run(req.params.key);
  res.json({ ok: true });
});

router.post('/:key/unread', (req, res) => {
  db.prepare('DELETE FROM notification_reads WHERE notification_key = ?').run(req.params.key);
  res.json({ ok: true });
});

router.post('/read-all', (req, res) => {
  const items = buildNotifications(req.user.id);
  const insert = db.prepare('INSERT OR IGNORE INTO notification_reads (notification_key) VALUES (?)');
  const tx = db.transaction((keys) => { for (const k of keys) insert.run(k); });
  tx(items.filter((i) => !i.read).map((i) => i.key));
  res.json({ ok: true });
});

module.exports = router;
