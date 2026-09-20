import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Paperclip, Download, PhoneCall, Calendar, CheckSquare, TrendingUp } from 'lucide-react';
import { api } from '../api';

/* ---------------------------------------------------------------------------
   These are REAL tables, not invented ones. calls/meetings/tasks/notes/
   emails/documents already support a polymorphic related_module +
   related_record_id pair — that's how Accounts' relation tabs work, and how
   the Dispose Call flow already writes real rows into `calls` today. Lead
   detail simply never surfaced them, because it's a bespoke page rather
   than going through the universal detail component that Accounts uses.

   Worth being explicit about one thing: this Calls tab shows the `calls`
   table (real dispose-call history). The existing "Activity" tab's own
   Call Log sub-filter is a SEPARATE, older mechanism (`lead_activities`,
   free-typed notes). Both keep working exactly as they did — this adds a
   second, genuine view onto data that already exists, it doesn't merge or
   replace anything.
   --------------------------------------------------------------------------- */

function tableModule(apiName) {
  return { api_name: apiName, table_name: apiName };
}

export function CallsTab({ leadId }) {
  const [rows, setRows] = useState(null);
  useEffect(() => {
    api.universalList(tableModule('calls'), { related_module: 'leads', related_record_id: leadId })
      .then(setRows).catch(() => setRows([]));
  }, [leadId]);
  if (rows === null) return <p className="t-meta">Loading…</p>;
  if (rows.length === 0) return <p className="t-meta py-3">No calls logged yet. Use "Dispose Call" to log one.</p>;
  return (
    <div className="space-y-2">
      {rows.map((c) => (
        <div key={c.id} className="flex items-start gap-3 text-sm border-l-2 border-line pl-3 py-1">
          <PhoneCall className="w-3.5 h-3.5 text-[var(--color-brand)] mt-0.5 shrink-0" />
          <div className="min-w-0 flex-1">
            <div className="text-ink font-medium">{c.call_subject || c.call_outcome || 'Call'}</div>
            <div className="t-meta">
              {c.connected ? 'Connected' : 'Not connected'}{c.duration_seconds ? ` · ${Math.round(c.duration_seconds / 60)}m` : ''} · {String(c.created_at || '').slice(0, 16)}
            </div>
            {c.notes && <div className="text-xs text-[var(--color-muted)] mt-0.5">{c.notes}</div>}
          </div>
        </div>
      ))}
    </div>
  );
}

export function MeetingsTab({ leadId }) {
  const [rows, setRows] = useState(null);
  useEffect(() => {
    api.universalList(tableModule('meetings'), { related_module: 'leads', related_record_id: leadId })
      .then(setRows).catch(() => setRows([]));
  }, [leadId]);
  if (rows === null) return <p className="t-meta">Loading…</p>;
  if (rows.length === 0) return <p className="t-meta py-3">No meetings scheduled with this lead yet.</p>;
  return (
    <div className="space-y-2">
      {rows.map((m) => (
        <div key={m.id} className="flex items-start gap-3 text-sm border-l-2 border-line pl-3 py-1">
          <Calendar className="w-3.5 h-3.5 text-[var(--color-brand)] mt-0.5 shrink-0" />
          <div className="min-w-0 flex-1">
            <div className="text-ink font-medium">{m.meeting_title}</div>
            <div className="t-meta">{String(m.start_datetime || m.created_at || '').slice(0, 16)} · {m.status || 'Scheduled'}</div>
          </div>
        </div>
      ))}
    </div>
  );
}

export function TasksTab({ leadId }) {
  const [rows, setRows] = useState(null);
  useEffect(() => {
    api.universalList(tableModule('tasks'), { related_module: 'leads', related_record_id: leadId })
      .then(setRows).catch(() => setRows([]));
  }, [leadId]);
  if (rows === null) return <p className="t-meta">Loading…</p>;
  if (rows.length === 0) return <p className="t-meta py-3">No tasks linked to this lead.</p>;
  return (
    <div className="space-y-2">
      {rows.map((t) => (
        <div key={t.id} className="flex items-start gap-3 text-sm border-l-2 border-line pl-3 py-1">
          <CheckSquare className="w-3.5 h-3.5 mt-0.5 shrink-0" style={{ color: t.status === 'Completed' ? 'var(--color-success)' : 'var(--color-brand)' }} />
          <div className="min-w-0 flex-1">
            <div className="text-ink font-medium">{t.task_title}</div>
            <div className="t-meta">{t.status}{t.due_date ? ` · Due ${String(t.due_date).slice(0, 10)}` : ''}{t.priority ? ` · ${t.priority}` : ''}</div>
          </div>
        </div>
      ))}
    </div>
  );
}

export function DocumentsTab({ leadId }) {
  const [rows, setRows] = useState(null);
  useEffect(() => {
    api.listDocuments({ related_module: 'leads', related_record_id: leadId }).then(setRows).catch(() => setRows([]));
  }, [leadId]);
  if (rows === null) return <p className="t-meta">Loading…</p>;
  if (rows.length === 0) return <p className="t-meta py-3">Nothing attached to this lead yet.</p>;
  return (
    <div className="space-y-2">
      {rows.map((d) => (
        <div key={d.id} className="flex items-center justify-between gap-2 text-sm">
          <span className="flex items-center gap-2 min-w-0 text-ink">
            <Paperclip className="w-3.5 h-3.5 text-[var(--color-faint)] shrink-0" /> <span className="truncate">{d.title}</span>
          </span>
          {d.external_url
            ? <a href={d.external_url} target="_blank" rel="noreferrer" className="text-xs shrink-0" style={{ color: 'var(--color-brand)' }}>Open</a>
            : <button onClick={() => api.downloadDocument(d.id, d.file_name)} className="text-xs shrink-0 inline-flex items-center gap-1" style={{ color: 'var(--color-brand)' }}>
                <Download className="w-3 h-3" /> Download
              </button>}
        </div>
      ))}
    </div>
  );
}

// A lead only has one possible "deal" — the opportunity created if/when it
// converts. lead.converted_opportunity_id is a real field, set by the real
// conversion flow. No fabricated pipeline here; before conversion this is
// honestly empty.
export function DealsTab({ lead }) {
  const [opp, setOpp] = useState(null);
  const [loading, setLoading] = useState(!!lead.converted_opportunity_id);
  useEffect(() => {
    if (!lead.converted_opportunity_id) return;
    api.universalGet(tableModule('opportunities'), lead.converted_opportunity_id).then(setOpp).finally(() => setLoading(false));
  }, [lead.converted_opportunity_id]);

  if (!lead.converted_opportunity_id) {
    return <p className="t-meta py-3">No deal yet — deals are created when this lead is converted.</p>;
  }
  if (loading) return <p className="t-meta">Loading…</p>;
  if (!opp) return <p className="t-meta py-3">Could not load the linked opportunity.</p>;
  return (
    <Link to={`/records/opportunities/${opp.id}`} className="flex items-center justify-between gap-3 text-sm p-2 -mx-2 rounded-lg hover:bg-[var(--color-canvas)]">
      <span className="flex items-center gap-2 min-w-0">
        <TrendingUp className="w-3.5 h-3.5 text-[var(--color-brand)] shrink-0" />
        <span className="text-ink font-medium truncate">{opp.opportunity_name}</span>
      </span>
      <span className="text-[var(--color-muted)] shrink-0">₹{Number(opp.amount || 0).toLocaleString('en-IN')}</span>
    </Link>
  );
}

export function NotesTab({ leadId }) {
  const [rows, setRows] = useState(null);
  useEffect(() => {
    api.universalList(tableModule('notes'), { related_module: 'leads', related_record_id: leadId })
      .then(setRows).catch(() => setRows([]));
  }, [leadId]);
  if (rows === null) return <p className="t-meta">Loading…</p>;
  if (rows.length === 0) return <p className="t-meta py-3">No notes in the shared notes log for this lead.</p>;
  return (
    <div className="space-y-2">
      {rows.map((n) => (
        <div key={n.id} className="text-sm border-l-2 border-line pl-3 py-1">
          <div className="text-ink">{n.body}</div>
          <div className="t-meta mt-0.5">{String(n.created_at || '').slice(0, 16)}</div>
        </div>
      ))}
    </div>
  );
}
