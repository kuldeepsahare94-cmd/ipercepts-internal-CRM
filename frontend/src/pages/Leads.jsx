import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  UserPlus, List, Columns3, Search, Mail, Phone, Clock, Download, X,
  Users as UsersIcon, Sparkles, TrendingUp, CheckCircle2, XCircle, MoreVertical, Plus,
} from 'lucide-react';
import { api } from '../api';
import { usePermissions } from '../context/usePermissions';
import { downloadCSV } from '../utils/csv';
import {
  PageHeader, KpiCard, Badge, Avatar, SkeletonRows, SkeletonCards, ErrorState, EmptyState, toneFor,
  friendlyError,
} from '../components/ui';

// The application's real lead statuses — unchanged, so nothing
// incompatible is written to the database.
const STATUSES = ['New', 'Contacted', 'Interested', 'Follow-up', 'Converted', 'Dropped', 'Not Interested'];

// Each column gets a short description, matching the reference's
// approach of explaining what a stage means.
const STATUS_HINT = {
  New: 'Initial inquiry received',
  Contacted: 'First contact made',
  Interested: 'Showing interest',
  'Follow-up': 'Needs further discussion',
  Converted: 'Successfully converted',
  Dropped: 'No longer proceeding',
  'Not Interested': 'Declined',
};

const TONE_VARS = {
  info: ['var(--color-info-soft)', 'var(--color-info)'],
  success: ['var(--color-success-soft)', 'var(--color-success)'],
  warning: ['var(--color-warning-soft)', 'var(--color-warning)'],
  attention: ['var(--color-attention-soft)', 'var(--color-attention)'],
  danger: ['var(--color-danger-soft)', 'var(--color-danger)'],
  special: ['var(--color-special-soft)', 'var(--color-special)'],
  neutral: ['var(--color-neutral-soft)', 'var(--color-neutral)'],
};
const toneVars = (status) => TONE_VARS[toneFor(status)] || TONE_VARS.neutral;

const relative = (iso) => {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const mins = Math.floor((Date.now() - d.getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return d.toISOString().slice(0, 10);
};

const empty = {
  student_name: '', account_name: '', mobile: '', alternate_mobile: '', email: '', gender: '', date_of_birth: '',
  address: '', city: '', qualification: '', source: '', status: 'New', follow_up_date: '',
  assigned_counselor: '', remarks: '', lead_rating: '', product_interest: '',
};


// Leads KPI tile. Clickable: each one filters the list to that status, so
// the numbers are a control rather than just a readout. Uses the same
// gradient-chip + accent-bar treatment as the dashboard so the two pages
// read as one product.
function LeadKpi({ label, value, icon: Icon, from, to, active, onClick }) {
  return (
    <button onClick={onClick}
      className={`relative bg-white border rounded-2xl p-4 pt-5 overflow-hidden text-left transition-all hover:shadow-md hover:-translate-y-0.5 ${
        active ? 'border-transparent ring-2' : 'border-line'}`}
      style={active ? { boxShadow: `0 0 0 2px ${to}` } : undefined}>
      <div className="absolute top-0 left-0 right-0 h-[3px]" style={{ background: `linear-gradient(90deg, ${from}, ${to})` }} />
      <div className="flex items-center gap-3">
        <div className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0 text-white shadow-sm"
          style={{ background: `linear-gradient(135deg, ${from}, ${to})` }}>
          {Icon && <Icon className="w-[18px] h-[18px]" />}
        </div>
        <div className="min-w-0">
          <div className="text-xl font-bold text-ink leading-none">{value}</div>
          <div className="text-xs text-slate-500 mt-1 truncate">{label}</div>
        </div>
      </div>
    </button>
  );
}

function LeadCard({ lead, onMoved, canEdit, onDragStart, onDragEnd, dragging }) {
  const [moving, setMoving] = useState(false);
  const [moveError, setMoveError] = useState('');

  const move = async (e, next) => {
    e.preventDefault();
    e.stopPropagation();
    if (!next || next === lead.status) return;
    setMoving(true); setMoveError('');
    try {
      await api.updateLead(lead.id, { ...lead, status: next });
      onMoved?.();
    } catch (err) {
      setMoveError(friendlyError(err, 'Could not move this lead.').message);
    } finally { setMoving(false); }
  };
  return (
    <LeadCardBody lead={lead} canEdit={canEdit} moving={moving} moveError={moveError} onMove={move}
      onDragStart={onDragStart} onDragEnd={onDragEnd} dragging={dragging} />
  );
}

function LeadCardBody({ lead, canEdit, moving, moveError, onMove, onDragStart, onDragEnd, dragging }) {
  const followUp = lead.follow_up_date ? String(lead.follow_up_date).slice(0, 10) : null;
  const isToday = followUp === new Date().toISOString().slice(0, 10);
  return (
    <Link to={`/leads/${lead.id}`}
      draggable={canEdit}
      onDragStart={(e) => {
        // dataTransfer must be set for the drop to register in Firefox.
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', String(lead.id));
        onDragStart?.(lead);
      }}
      onDragEnd={() => onDragEnd?.()}
      className={`card card-hover p-3 block transition-opacity ${canEdit ? 'cursor-grab active:cursor-grabbing' : ''} ${dragging ? 'opacity-40' : ''}`}>
      <div className="flex items-start gap-2.5">
        <Avatar name={lead.student_name} size="sm" />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-ink truncate leading-tight">{lead.student_name}</div>
          {lead.lead_rating && <div className="mt-1"><Badge size="xs" status={lead.lead_rating}>{lead.lead_rating}</Badge></div>}
        </div>
      </div>
      <div className="mt-2.5 space-y-1">
        {lead.email && (
          <div className="flex items-center gap-1.5 t-meta min-w-0">
            <Mail className="w-3 h-3 shrink-0" /><span className="truncate">{lead.email}</span>
          </div>
        )}
        {lead.mobile && (
          <div className="flex items-center gap-1.5 t-meta"><Phone className="w-3 h-3 shrink-0" />{lead.mobile}</div>
        )}
        {lead.product_interest && (
          <div className="flex items-center gap-1.5 t-meta min-w-0">
            <Sparkles className="w-3 h-3 shrink-0" /><span className="truncate">{lead.product_interest}</span>
          </div>
        )}
      </div>
      {canEdit && (
        <div className="mt-2" onClick={(e) => e.preventDefault()}>
          <select value={lead.status || ''} disabled={moving}
            onChange={(e) => onMove(e, e.target.value)}
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); }}
            aria-label={`Move ${lead.student_name} to another status`}
            className="w-full text-[11px] border border-line rounded-md px-1.5 py-1 bg-white text-[var(--color-muted)] disabled:opacity-50">
            {STATUSES.map((st) => <option key={st} value={st}>{moving ? 'Moving…' : `Move to ${st}`}</option>)}
          </select>
          {moveError && <p className="text-[10px] mt-1" style={{ color: 'var(--color-danger)' }}>{moveError}</p>}
        </div>
      )}
      <div className="mt-2 pt-2 border-t border-line flex items-center justify-between gap-2">
        <span className="t-meta truncate">{lead.source || '—'}</span>
        {followUp ? (
          <span className="text-[11px] font-medium shrink-0"
            style={{ color: isToday ? 'var(--color-attention)' : 'var(--color-muted)' }}>
            {isToday ? 'Today' : followUp}
          </span>
        ) : (
          <span className="t-meta shrink-0">{relative(lead.created_at)}</span>
        )}
      </div>
    </Link>
  );
}

function KanbanBoard({ leads, onAdd, canCreate, canEdit, onMoved }) {
  // Drag-and-drop, implemented with the native HTML5 drag events rather
  // than pulling in a drag library for one board.
  //
  // `optimistic` holds a pending {id -> status} override so the card jumps
  // to the new column the instant you drop it, instead of sitting still
  // until the server replies. If the save fails the override is discarded,
  // the card snaps back to where it really is, and the error is surfaced —
  // a card that silently stays moved while the database disagrees is worse
  // than no drag at all.
  const [dragLead, setDragLead] = useState(null);
  const [dragOver, setDragOver] = useState(null);
  const [optimistic, setOptimistic] = useState({});
  const [dropError, setDropError] = useState('');

  const byStatus = useMemo(() => {
    const map = Object.fromEntries(STATUSES.map((s) => [s, []]));
    leads.forEach((l) => {
      const effective = optimistic[l.id] || l.status;
      const key = STATUSES.includes(effective) ? effective : 'New';
      map[key].push(l);
    });
    return map;
  }, [leads, optimistic]);

  const handleDrop = async (status) => {
    setDragOver(null);
    const lead = dragLead;
    setDragLead(null);
    if (!lead || lead.status === status) return;

    setOptimistic((o) => ({ ...o, [lead.id]: status }));
    setDropError('');
    try {
      await api.updateLead(lead.id, { ...lead, status });
      await onMoved?.();
    } catch (err) {
      setDropError(friendlyError(err, `Could not move ${lead.student_name}.`).message);
    } finally {
      // Cleared either way: on success the reloaded data already reflects
      // the change, on failure the card must snap back to the truth.
      setOptimistic((o) => {
        const next = { ...o };
        delete next[lead.id];
        return next;
      });
    }
  };

  return (
    <>
      {dropError && (
        <div className="text-sm rounded-lg px-3 py-2 mb-3"
          style={{ background: 'var(--color-danger-soft)', color: 'var(--color-danger)' }}>{dropError}</div>
      )}
      {canEdit && (
        <p className="t-meta mb-2">Drag a card to another column to change its status.</p>
      )}
    <div className="flex gap-4 overflow-x-auto thin-scroll pb-4 -mx-1 px-1">
      {STATUSES.map((status) => {
        const [soft, solid] = toneVars(status);
        const items = byStatus[status];
        const isTarget = dragOver === status && dragLead && dragLead.status !== status;
        return (
          <section key={status} className="w-[280px] shrink-0 rounded-xl flex flex-col transition-all"
            onDragOver={(e) => { if (canEdit && dragLead) { e.preventDefault(); setDragOver(status); } }}
            onDragLeave={() => setDragOver((d) => (d === status ? null : d))}
            onDrop={(e) => { e.preventDefault(); if (canEdit) handleDrop(status); }}
            style={{
              background: soft,
              maxHeight: 'calc(100vh - 340px)',
              outline: isTarget ? `2px dashed ${solid}` : 'none',
              outlineOffset: '2px',
              transform: isTarget ? 'translateY(-2px)' : 'none',
            }}>
            <header className="px-3 pt-3 pb-2 shrink-0">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="w-2 h-2 rounded-full shrink-0" style={{ background: solid }} />
                  <h3 className="text-sm font-semibold truncate" style={{ color: solid }}>{status}</h3>
                  <span className="text-xs font-medium px-1.5 rounded-full shrink-0"
                    style={{ background: 'rgba(255,255,255,.7)', color: solid }}>{items.length}</span>
                </div>
                <button className="p-0.5 rounded opacity-50 hover:opacity-100 shrink-0"
                  style={{ color: solid }} aria-label={`${status} column options`}>
                  <MoreVertical className="w-4 h-4" />
                </button>
              </div>
              <p className="text-[11px] mt-0.5 opacity-70" style={{ color: solid }}>{STATUS_HINT[status]}</p>
            </header>

            <div className="px-2 pb-2 space-y-2 overflow-y-auto thin-scroll flex-1">
              {items.map((l) => (
                <LeadCard key={l.id} lead={l} canEdit={canEdit} onMoved={onMoved}
                  onDragStart={setDragLead} onDragEnd={() => { setDragLead(null); setDragOver(null); }}
                  dragging={dragLead?.id === l.id} />
              ))}
              {items.length === 0 && (
                <p className="text-[11px] text-center py-6 opacity-60" style={{ color: solid }}>No leads</p>
              )}
            </div>

            {canCreate && (
              <button onClick={() => onAdd(status)}
                className="m-2 mt-0 py-2 rounded-lg text-xs font-medium flex items-center justify-center gap-1 shrink-0
                           bg-white/60 hover:bg-white transition-colors"
                style={{ color: solid }}>
                <Plus className="w-3.5 h-3.5" /> Add Lead
              </button>
            )}
          </section>
        );
      })}
    </div>
    </>
  );
}

function AddLeadModal({ initialStatus, sources, onClose, onSaved }) {
  const [form, setForm] = useState({ ...empty, status: initialStatus || 'New' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e) => {
    e.preventDefault();
    if (!form.student_name.trim()) return setError('Name is required.');
    setSaving(true); setError('');
    try {
      await api.createLead(form);
      onSaved();
    } catch (err) { setError(err.message); } finally { setSaving(false); }
  };

  const field = (label, key, props = {}) => (
    <div>
      <label className="t-meta font-medium block mb-1">{label}{props.required && ' *'}</label>
      <input className="input" value={form[key] || ''} onChange={(e) => setForm({ ...form, [key]: e.target.value })} {...props} />
    </div>
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-label="Add lead">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <form onSubmit={submit} className="card relative w-full max-w-2xl max-h-[90vh] flex flex-col shadow-2xl">
        <div className="flex items-center justify-between px-5 py-4 border-b border-line shrink-0">
          <h2 className="t-section">Add Lead</h2>
          <button type="button" onClick={onClose} aria-label="Close"
            className="text-[var(--color-faint)] hover:text-ink p-1 rounded-lg hover:bg-[var(--color-canvas)]">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="px-5 py-4 overflow-y-auto space-y-5">
          {error && (
            <div className="text-xs rounded-lg px-3 py-2"
              style={{ background: 'var(--color-danger-soft)', color: 'var(--color-danger)' }}>{error}</div>
          )}

          <section>
            <h3 className="t-meta font-semibold uppercase tracking-wide mb-2">Personal</h3>
            <div className="grid sm:grid-cols-2 gap-3">
              {field('Name', 'student_name', { required: true, placeholder: 'Full name' })}
              {/* Converting a lead creates an Account, and an Account is the
                  ORGANISATION. Without this the conversion had nothing to
                  name it after and used the person's name instead. */}
              {field('Company / Account Name', 'account_name', { placeholder: 'e.g. Smart Business Solution' })}
              {field('City', 'city')}
            </div>
          </section>

          <section>
            <h3 className="t-meta font-semibold uppercase tracking-wide mb-2">Contact</h3>
            <div className="grid sm:grid-cols-2 gap-3">
              {field('Mobile', 'mobile', { type: 'tel' })}
              {field('Email', 'email', { type: 'email' })}
            </div>
          </section>

          <section>
            <h3 className="t-meta font-semibold uppercase tracking-wide mb-2">Lead details</h3>
            <div className="grid sm:grid-cols-2 gap-3">
              <div>
                <label className="t-meta font-medium block mb-1">Status</label>
                <select className="input" value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}>
                  {STATUSES.map((s) => <option key={s}>{s}</option>)}
                </select>
              </div>
              <div>
                <label className="t-meta font-medium block mb-1">Source</label>
                <select className="input" value={form.source} onChange={(e) => setForm({ ...form, source: e.target.value })}>
                  <option value="">Select…</option>
                  {sources.map((s) => <option key={s.id || s.label} value={s.label}>{s.label}</option>)}
                </select>
              </div>
              <div>
                <label className="t-meta font-medium block mb-1">Rating</label>
                <select className="input" value={form.lead_rating} onChange={(e) => setForm({ ...form, lead_rating: e.target.value })}>
                  <option value="">Select…</option>
                  {['Hot', 'Warm', 'Cold'].map((r) => <option key={r}>{r}</option>)}
                </select>
              </div>
              {field('Product interest', 'product_interest')}
            </div>
          </section>

          <section>
            <h3 className="t-meta font-semibold uppercase tracking-wide mb-2">Assignment &amp; follow-up</h3>
            <div className="grid sm:grid-cols-2 gap-3">
              {field('Assigned to', 'assigned_counselor')}
              {field('Next follow-up', 'follow_up_date', { type: 'date' })}
            </div>
          </section>

          <section>
            <label className="t-meta font-medium block mb-1">Notes</label>
            <textarea className="input" rows={3} value={form.remarks}
              onChange={(e) => setForm({ ...form, remarks: e.target.value })} />
          </section>
        </div>

        <div className="flex justify-end gap-2 px-5 py-4 border-t border-line shrink-0">
          <button type="button" onClick={onClose} className="btn btn-secondary">Cancel</button>
          <button type="submit" disabled={saving} className="btn btn-primary disabled:opacity-50">
            {saving ? 'Saving…' : 'Add Lead'}
          </button>
        </div>
      </form>
    </div>
  );
}

export default function Leads() {
  const can = usePermissions();
  const [list, setList] = useState([]);
  const [sources, setSources] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [view, setView] = useState(() => localStorage.getItem('leads_view') || 'list');
  const [statusFilter, setStatusFilter] = useState('');
  const [sourceFilter, setSourceFilter] = useState('');
  const [ownerFilter, setOwnerFilter] = useState('');
  const [q, setQ] = useState('');
  const [addFor, setAddFor] = useState(null);

  const load = () => {
    setError(null);
    return api.listLeads({ status: statusFilter, q })
      .then(setList)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    load();
    // Lead sources come from the master-options list this CRM already has.
    // Failing to load them must never take the page down, so it degrades
    // to an empty dropdown rather than throwing.
    api.listMasterOptions?.('lead_source').then(setSources).catch(() => setSources([]));
  }, [statusFilter]);

  useEffect(() => { const t = setTimeout(load, 300); return () => clearTimeout(t); }, [q]);
  useEffect(() => { localStorage.setItem('leads_view', view); }, [view]);

  const owners = useMemo(
    () => [...new Set(list.map((l) => l.assigned_counselor).filter(Boolean))],
    [list]
  );

  // Source/owner filter client-side; status and search go to the API.
  const filtered = useMemo(() => list.filter((l) => (
    (!sourceFilter || l.source === sourceFilter) &&
    (!ownerFilter || l.assigned_counselor === ownerFilter)
  )), [list, sourceFilter, ownerFilter]);

  const kpis = useMemo(() => {
    const by = (s) => list.filter((l) => l.status === s).length;
    return {
      total: list.length,
      isNew: by('New'),
      progress: by('Contacted') + by('Interested') + by('Follow-up'),
      converted: by('Converted'),
      lost: by('Dropped') + by('Not Interested'),
    };
  }, [list]);

  const viewBtn = (id, Icon, label) => (
    <button onClick={() => setView(id)} aria-pressed={view === id}
      className={`btn ${view === id ? 'btn-primary' : 'btn-secondary'}`}>
      <Icon className="w-4 h-4" /> {label}
    </button>
  );

  return (
    <div className="max-w-[1600px] mx-auto">
      <PageHeader title="Leads" subtitle="Manage your leads and track their journey from first enquiry to close">
        {viewBtn('list', List, 'List View')}
        {viewBtn('kanban', Columns3, 'Kanban View')}
        {can('leads', 'export') && (
          <button onClick={() => downloadCSV('leads.csv', filtered)} className="btn btn-secondary">
            <Download className="w-4 h-4" /><span className="hidden sm:inline">Export</span>
          </button>
        )}
        {can('leads', 'create') && (
          <button onClick={() => setAddFor('New')} className="btn btn-primary">
            <UserPlus className="w-4 h-4" /> Add Lead
          </button>
        )}
      </PageHeader>

      {loading ? <SkeletonCards count={5} /> : (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3">
          <LeadKpi label="Total Leads" value={kpis.total} icon={UsersIcon} from="#E879F9" to="#A21CAF"
            active={!statusFilter} onClick={() => setStatusFilter('')} />
          <LeadKpi label="New" value={kpis.isNew} icon={Sparkles} from="#93C5FD" to="#1D4ED8"
            active={statusFilter === 'New'} onClick={() => setStatusFilter('New')} />
          <LeadKpi label="In Progress" value={kpis.progress} icon={TrendingUp} from="#FCD34D" to="#B45309"
            active={false} onClick={() => setStatusFilter('')} />
          <LeadKpi label="Converted" value={kpis.converted} icon={CheckCircle2} from="#6EE7B7" to="#047857"
            active={statusFilter === 'Converted'} onClick={() => setStatusFilter('Converted')} />
          <LeadKpi label="Lost" value={kpis.lost} icon={XCircle} from="#FDA4AF" to="#BE123C"
            active={statusFilter === 'Dropped'} onClick={() => setStatusFilter('Dropped')} />
        </div>
      )}

      {/* One compact toolbar. These were four full-width blocks stacked
          vertically, pushing the actual leads far below the fold — caused
          by `.input { width:100% }` outranking the `w-auto` already in the
          markup (fixed in index.css). */}
      <div className="flex flex-wrap items-center gap-2 mt-5 mb-4">
        <div className="relative flex-1 min-w-[240px]">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-[var(--color-faint)]" />
          <input value={q} onChange={(e) => setQ(e.target.value)} className="input w-full pl-9"
            placeholder="Search by name, email or phone…" aria-label="Search leads" />
        </div>
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}
          className="input w-auto min-w-[130px]" aria-label="Filter by status">
          <option value="">All Statuses</option>
          {STATUSES.map((s) => <option key={s}>{s}</option>)}
        </select>
        <select value={sourceFilter} onChange={(e) => setSourceFilter(e.target.value)}
          className="input w-auto min-w-[130px]" aria-label="Filter by source">
          <option value="">All Sources</option>
          {sources.map((s) => <option key={s.id || s.label} value={s.label}>{s.label}</option>)}
        </select>
        {owners.length > 0 && (
          <select value={ownerFilter} onChange={(e) => setOwnerFilter(e.target.value)}
            className="input w-auto min-w-[130px]" aria-label="Filter by owner">
            <option value="">All Owners</option>
            {owners.map((o) => <option key={o}>{o}</option>)}
          </select>
        )}
        {(q || statusFilter || sourceFilter || ownerFilter) && (
          <button onClick={() => { setQ(''); setStatusFilter(''); setSourceFilter(''); setOwnerFilter(''); }}
            className="text-xs font-medium px-3 py-2 rounded-lg border border-line text-slate-500 hover:text-ink hover:bg-[var(--color-canvas)]">
            Clear
          </button>
        )}
      </div>

      {loading && <SkeletonRows rows={6} cols={6} />}

      {!loading && error && (
        <ErrorState message="Unable to load leads." detail={error} onRetry={() => { setLoading(true); load(); }} />
      )}

      {!loading && !error && filtered.length === 0 && (
        <EmptyState icon={UsersIcon} title="No leads found"
          description={q || statusFilter || sourceFilter || ownerFilter
            ? 'No leads match your current filters. Try clearing them.'
            : 'Leads you add or capture will appear here.'}>
          {can('leads', 'create') && (
            <button onClick={() => setAddFor('New')} className="btn btn-primary mx-auto">
              <UserPlus className="w-4 h-4" /> Add Lead
            </button>
          )}
        </EmptyState>
      )}

      {!loading && !error && filtered.length > 0 && view === 'kanban' && (
        <KanbanBoard leads={filtered} onAdd={setAddFor} canCreate={can('leads', 'create')}
          canEdit={can('leads', 'edit')} onMoved={load} />
      )}

      {!loading && !error && filtered.length > 0 && view === 'list' && (
        <div className="card overflow-hidden">
          <div className="overflow-x-auto thin-scroll">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left bg-[var(--color-canvas)] border-b border-line">
                  {['Lead', 'Contact', 'Source', 'Status', 'Rating', 'Assigned To', 'Next Follow-up', 'Created'].map((h) => (
                    <th key={h} className="py-2.5 px-4 t-meta font-semibold whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.map((l) => (
                  <tr key={l.id} className="border-b border-line/60 hover:bg-[var(--color-canvas)] transition-colors">
                    <td className="py-3 px-4">
                      <Link to={`/leads/${l.id}`} className="flex items-center gap-2.5 group">
                        <Avatar name={l.student_name} size="sm" />
                        <span className="font-medium text-ink group-hover:text-[var(--color-brand)] truncate">
                          {l.student_name}
                        </span>
                      </Link>
                    </td>
                    <td className="py-3 px-4">
                      <div className="text-[var(--color-muted)] text-xs space-y-0.5">
                        {l.email && <div className="truncate max-w-[180px]">{l.email}</div>}
                        {l.mobile && <div>{l.mobile}</div>}
                        {!l.email && !l.mobile && '—'}
                      </div>
                    </td>
                    <td className="py-3 px-4 text-[var(--color-muted)] whitespace-nowrap">{l.source || '—'}</td>
                    <td className="py-3 px-4"><Badge status={l.status}>{l.status}</Badge></td>
                    <td className="py-3 px-4">{l.lead_rating ? <Badge status={l.lead_rating}>{l.lead_rating}</Badge> : <span className="text-[var(--color-faint)]">—</span>}</td>
                    <td className="py-3 px-4 text-[var(--color-muted)] whitespace-nowrap">{l.assigned_counselor || '—'}</td>
                    <td className="py-3 px-4 whitespace-nowrap">
                      {l.follow_up_date ? (
                        <span className="inline-flex items-center gap-1 text-xs text-[var(--color-muted)]">
                          <Clock className="w-3 h-3" />{String(l.follow_up_date).slice(0, 10)}
                        </span>
                      ) : <span className="text-[var(--color-faint)]">—</span>}
                    </td>
                    <td className="py-3 px-4 t-meta whitespace-nowrap">{relative(l.created_at) || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="px-4 py-2.5 border-t border-line t-meta">
            Showing {filtered.length} of {list.length} lead{list.length === 1 ? '' : 's'}
          </div>
        </div>
      )}

      {addFor && (
        <AddLeadModal initialStatus={addFor} sources={sources}
          onClose={() => setAddFor(null)}
          onSaved={() => { setAddFor(null); setLoading(true); load(); }} />
      )}
    </div>
  );
}
