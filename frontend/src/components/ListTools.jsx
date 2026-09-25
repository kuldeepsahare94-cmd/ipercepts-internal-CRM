/*
 * List tools shared by every module list: filters, saved filters, row
 * selection and bulk actions.
 *
 *   FilterButton / FilterPanel   build conditions on any of the module's
 *                                fields (text, number, date, dropdown,
 *                                multi-select, checkbox, user, lookup)
 *   ActiveFilterChips            what is applied, removable one by one
 *   SavedFiltersMenu             name and reuse a set of conditions
 *   BulkBar + BulkUpdateModal    act on the selected rows: update any field,
 *   + BulkAssignModal            assign to a user, export, delete
 *
 * Bulk changes go through each record's normal update / delete route, one
 * record at a time (a few in parallel), so every rule a single edit obeys —
 * validation, workflows, locked invoices, subscription schedules — still
 * applies, and failures are reported per record rather than hidden.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Bookmark, BookmarkPlus, Check, ChevronDown, Download, Filter, Pencil, Plus, Trash2, UserRoundCog, Users, X,
} from 'lucide-react';
import { api } from '../api';
import { useDirectory } from './userDirectory';
import { FieldInput, parseOptions, formatFieldValue } from '../pages/universal/fieldUtils';
import { useAuth } from '../context/AuthContext';

// ---------------------------------------------------------------------------
// Operators
// ---------------------------------------------------------------------------
const NUM = ['number', 'decimal', 'currency', 'percent'];
const DATE = ['date', 'datetime'];
const CHOICE = ['dropdown', 'radio', 'status'];

export function kindOf(field) {
  const t = field.field_type;
  if (NUM.includes(t)) return 'number';
  if (DATE.includes(t)) return 'date';
  if (CHOICE.includes(t)) return 'choice';
  if (t === 'multiselect') return 'multi';
  if (t === 'checkbox') return 'bool';
  if (t === 'user' || t === 'user_name') return 'user';
  if (t === 'team') return 'team';
  if (t === 'lookup') return 'lookup';
  return 'text';
}

const OPS = {
  text: [['contains', 'contains'], ['not_contains', 'does not contain'], ['eq', 'is'], ['neq', 'is not'], ['starts', 'starts with'], ['empty', 'is empty'], ['not_empty', 'is not empty']],
  number: [['eq', '='], ['neq', '≠'], ['gt', '>'], ['gte', '≥'], ['lt', '<'], ['lte', '≤'], ['between', 'between'], ['empty', 'is empty'], ['not_empty', 'is not empty']],
  date: [['on', 'is on'], ['before', 'is before'], ['after', 'is after'], ['between', 'is between'], ['today', 'is today'], ['last_days', 'in the last … days'], ['next_days', 'in the next … days'], ['overdue', 'is before today'], ['empty', 'is empty'], ['not_empty', 'is not empty']],
  choice: [['in', 'is any of'], ['not_in', 'is none of'], ['empty', 'is empty'], ['not_empty', 'is not empty']],
  multi: [['has_any', 'has any of'], ['has_none', 'has none of'], ['empty', 'is empty'], ['not_empty', 'is not empty']],
  bool: [['yes', 'is Yes'], ['no', 'is No']],
  user: [['in', 'is any of'], ['not_in', 'is none of'], ['me', 'is me'], ['empty', 'is unassigned'], ['not_empty', 'is assigned']],
  team: [['in', 'is any of'], ['empty', 'is empty'], ['not_empty', 'is not empty']],
  lookup: [['eq', 'is'], ['neq', 'is not'], ['empty', 'is empty'], ['not_empty', 'is not empty']],
};
const NO_VALUE = new Set(['empty', 'not_empty', 'today', 'overdue', 'yes', 'no', 'me']);
export const opsFor = (field) => OPS[kindOf(field)];

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------
const localToday = () => new Date().toLocaleDateString('en-CA');
const shift = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const blank = (v) => v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0);
const asList = (v) => (Array.isArray(v) ? v : blank(v) ? [] : String(v).split(',').map((x) => x.trim()).filter(Boolean));

function matchOne(raw, cond, field, me) {
  const k = kindOf(field);
  const { op } = cond;
  if (op === 'empty') return blank(raw);
  if (op === 'not_empty') return !blank(raw);
  if (k === 'bool') return op === 'yes' ? !!raw && raw !== '0' : !raw || raw === '0';
  if (k === 'text') {
    const s = String(raw ?? '').toLowerCase();
    const v = String(cond.value ?? '').toLowerCase();
    if (op === 'contains') return s.includes(v);
    if (op === 'not_contains') return !s.includes(v);
    if (op === 'eq') return s === v;
    if (op === 'neq') return s !== v;
    if (op === 'starts') return s.startsWith(v);
  }
  if (k === 'number') {
    if (blank(raw)) return false;
    const n = Number(raw); const a = Number(cond.value); const b = Number(cond.value2);
    return { eq: n === a, neq: n !== a, gt: n > a, gte: n >= a, lt: n < a, lte: n <= a, between: n >= a && n <= b }[op] ?? true;
  }
  if (k === 'date') {
    if (blank(raw)) return false;
    const d = String(raw).slice(0, 10); const t = localToday();
    const a = String(cond.value ?? '').slice(0, 10); const b = String(cond.value2 ?? '').slice(0, 10);
    const n = Number(cond.value) || 0;
    return {
      on: d === a, before: d < a, after: d > a, between: d >= a && d <= b, today: d === t, overdue: d < t,
      last_days: d >= shift(t, -n) && d <= t, next_days: d >= t && d <= shift(t, n),
    }[op] ?? true;
  }
  if (k === 'choice' || k === 'team' || k === 'user') {
    const vals = asList(cond.value).map(String);
    const s = blank(raw) ? '' : String(raw);
    if (op === 'me') return me != null && (s === String(me.id) || s === me.name);
    if (op === 'in') return vals.includes(s);
    if (op === 'not_in') return !vals.includes(s);
  }
  if (k === 'multi') {
    const have = asList(raw).map(String); const want = asList(cond.value).map(String);
    if (op === 'has_any') return want.some((w) => have.includes(w));
    if (op === 'has_none') return !want.some((w) => have.includes(w));
  }
  if (k === 'lookup') {
    if (op === 'eq') return String(raw ?? '') === String(cond.value ?? '');
    if (op === 'neq') return String(raw ?? '') !== String(cond.value ?? '');
  }
  return true;
}

// A condition missing its value is ignored rather than matching nothing.
export function isComplete(cond) {
  if (!cond.field || !cond.op) return false;
  if (NO_VALUE.has(cond.op)) return true;
  if (cond.op === 'between') return !blank(cond.value) && !blank(cond.value2);
  return !blank(cond.value);
}

export function applyFilters(rows, conditions, match, fields, getValue, me) {
  const live = (conditions || []).filter(isComplete).map((c) => ({ c, f: fields.find((x) => x.api_name === c.field) })).filter((x) => x.f);
  if (!live.length) return rows;
  return rows.filter((r) => {
    const results = live.map(({ c, f }) => matchOne(getValue(r, f), c, f, me));
    return match === 'any' ? results.some(Boolean) : results.every(Boolean);
  });
}

// Fields worth filtering on: everything the module has, minus internal ids.
export function filterableFields(fields) {
  return fields.filter((f) => !['file', 'image'].includes(f.field_type) && f.api_name !== 'related_record_id');
}

// ---------------------------------------------------------------------------
// Value editors
// ---------------------------------------------------------------------------
function MultiPick({ options, value, onChange }) {
  const selected = asList(value).map(String);
  const toggle = (v) => onChange(selected.includes(v) ? selected.filter((x) => x !== v) : [...selected, v]);
  return (
    <div className="flex flex-wrap gap-1.5 max-h-28 overflow-y-auto p-1 rounded-lg border border-line bg-white min-h-[38px]">
      {options.length === 0 && <span className="text-xs text-slate-400 px-1 py-1">No options</span>}
      {options.map((o) => {
        const on = selected.includes(String(o.value));
        return (
          <button type="button" key={o.value} onClick={() => toggle(String(o.value))} aria-pressed={on}
            className="text-xs px-2 py-1 rounded-full border inline-flex items-center gap-1 transition-colors"
            style={on ? { background: 'var(--color-brand-soft)', borderColor: 'var(--color-brand-border)', color: 'var(--color-brand)' } : { borderColor: 'var(--color-line)', color: 'var(--color-ink)' }}>
            {on && <Check className="w-3 h-3" />}{o.label}
          </button>
        );
      })}
    </div>
  );
}

function choiceOptions(field, dir) {
  const k = kindOf(field);
  if (k === 'user') {
    return (dir?.users || []).filter((u) => u.active !== 0)
      .map((u) => ({ value: field.field_type === 'user_name' ? u.name : String(u.id), label: u.name }));
  }
  if (k === 'team') return (dir?.teams || []).map((t) => ({ value: String(t.id), label: t.name }));
  return parseOptions(field).map((o) => (typeof o === 'string' ? { value: o, label: o } : { value: String(o.value ?? o.label), label: String(o.label ?? o.value) }));
}

function ValueEditor({ field, cond, onChange }) {
  const dir = useDirectory();
  const k = kindOf(field);
  if (NO_VALUE.has(cond.op)) return <div className="text-xs text-slate-400 px-1 py-2">No value needed</div>;
  if (['choice', 'multi', 'user', 'team'].includes(k)) {
    return <MultiPick options={choiceOptions(field, dir)} value={cond.value} onChange={(v) => onChange({ value: v })} />;
  }
  if (k === 'date') {
    if (cond.op === 'last_days' || cond.op === 'next_days') {
      return <input type="number" min="1" className="input w-full" placeholder="Days" value={cond.value ?? ''} onChange={(e) => onChange({ value: e.target.value })} />;
    }
    return (
      <div className="flex items-center gap-1.5">
        <input type="date" className="input w-full" value={cond.value ?? ''} onChange={(e) => onChange({ value: e.target.value })} aria-label="Date" />
        {cond.op === 'between' && <><span className="text-xs text-slate-400">and</span>
          <input type="date" className="input w-full" value={cond.value2 ?? ''} onChange={(e) => onChange({ value2: e.target.value })} aria-label="End date" /></>}
      </div>
    );
  }
  if (k === 'number') {
    return (
      <div className="flex items-center gap-1.5">
        <input type="number" className="input w-full" value={cond.value ?? ''} onChange={(e) => onChange({ value: e.target.value })} aria-label="Value" />
        {cond.op === 'between' && <><span className="text-xs text-slate-400">and</span>
          <input type="number" className="input w-full" value={cond.value2 ?? ''} onChange={(e) => onChange({ value2: e.target.value })} aria-label="Upper value" /></>}
      </div>
    );
  }
  if (k === 'lookup') return <FieldInput field={field} value={cond.value} onChange={(v) => onChange({ value: v })} />;
  return <input className="input w-full" placeholder="Value" value={cond.value ?? ''} onChange={(e) => onChange({ value: e.target.value })} aria-label="Value" />;
}

// ---------------------------------------------------------------------------
// Filter panel
// ---------------------------------------------------------------------------
export function FilterPanel({ module, fields, initial, initialMatch = 'all', onApply, onClose, onSaved }) {
  const usable = useMemo(() => filterableFields(fields), [fields]);
  const fresh = () => ({ field: usable[0]?.api_name || '', op: usable[0] ? opsFor(usable[0])[0][0] : '', value: '', value2: '' });
  const [rows, setRows] = useState(() => (initial?.length ? initial.map((r) => ({ ...r })) : [fresh()]));
  const [match, setMatch] = useState(initialMatch);
  const [saveName, setSaveName] = useState('');
  const [share, setShare] = useState(false);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');

  const set = (i, patch) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const complete = rows.filter(isComplete);

  const save = async () => {
    if (!saveName.trim()) { setMsg('Give the filter a name to save it.'); return; }
    if (!complete.length) { setMsg('Complete at least one condition first.'); return; }
    setSaving(true); setMsg('');
    try {
      const saved = await api.saveFilter({ module, name: saveName.trim(), filters: complete, match, shared: share });
      setMsg(`Saved as “${saved.name}”.`);
      onSaved?.(saved);
      onApply(complete, match, saved);
    } catch (e) { setMsg(e.message); } finally { setSaving(false); }
  };

  return (
    <section className="card p-4 mt-3" aria-label="Filters" style={{ borderColor: 'var(--color-brand-border)' }}>
      <div className="flex items-center justify-between gap-2 flex-wrap mb-3">
        <h3 className="text-sm font-semibold text-ink flex items-center gap-2"><Filter className="w-4 h-4" style={{ color: 'var(--color-brand)' }} /> Filter records</h3>
        <div className="flex items-center gap-2 text-xs" style={{ color: 'var(--color-muted)' }}>
          Match
          <select className="input w-auto py-1" value={match} onChange={(e) => setMatch(e.target.value)} aria-label="Match all or any">
            <option value="all">all conditions</option>
            <option value="any">any condition</option>
          </select>
          <button type="button" onClick={onClose} aria-label="Close filters" className="p-1 rounded hover:bg-slate-100"><X className="w-4 h-4" /></button>
        </div>
      </div>
      <div className="space-y-2">
        {rows.map((r, i) => {
          const f = usable.find((x) => x.api_name === r.field) || usable[0];
          return (
            <div key={i} className="grid grid-cols-1 md:grid-cols-[210px_180px_1fr_32px] gap-2 items-start">
              <select className="input w-full" value={r.field} aria-label="Field"
                onChange={(e) => { const nf = usable.find((x) => x.api_name === e.target.value); set(i, { field: e.target.value, op: opsFor(nf)[0][0], value: '', value2: '' }); }}>
                {usable.map((x) => <option key={x.api_name} value={x.api_name}>{x.label}</option>)}
              </select>
              <select className="input w-full" value={r.op} aria-label="Condition" onChange={(e) => set(i, { op: e.target.value })}>
                {f && opsFor(f).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </select>
              {f ? <ValueEditor field={f} cond={r} onChange={(p) => set(i, p)} /> : <span />}
              <button type="button" onClick={() => setRows((rs) => (rs.length === 1 ? [fresh()] : rs.filter((_, j) => j !== i)))}
                aria-label="Remove condition" className="h-[38px] w-8 rounded-lg flex items-center justify-center hover:bg-slate-100 text-slate-400">
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
          );
        })}
      </div>
      <button type="button" onClick={() => setRows((rs) => [...rs, fresh()])} className="mt-2 text-xs font-semibold inline-flex items-center gap-1" style={{ color: 'var(--color-brand)' }}>
        <Plus className="w-3.5 h-3.5" /> Add condition
      </button>

      <div className="flex items-end justify-between gap-3 flex-wrap mt-4 pt-3 border-t border-line">
        <div className="flex items-end gap-2 flex-wrap">
          <label className="text-xs text-slate-500">Save as
            <input className="input w-48 mt-1" placeholder="e.g. My hot leads" value={saveName} onChange={(e) => setSaveName(e.target.value)} />
          </label>
          <label className="text-xs inline-flex items-center gap-1.5 pb-2" style={{ color: 'var(--color-muted)' }}>
            <input type="checkbox" checked={share} onChange={(e) => setShare(e.target.checked)} /> Share with everyone
          </label>
          <button type="button" onClick={save} disabled={saving} className="btn btn-secondary inline-flex items-center gap-1.5">
            <BookmarkPlus className="w-4 h-4" /> {saving ? 'Saving…' : 'Save filter'}
          </button>
        </div>
        <div className="flex gap-2">
          <button type="button" onClick={() => { setRows([fresh()]); onApply([], match, null); }} className="btn btn-secondary">Clear</button>
          <button type="button" onClick={() => onApply(complete, match, null)} className="btn btn-primary">Apply{complete.length ? ` (${complete.length})` : ''}</button>
        </div>
      </div>
      {msg && <p className="text-xs mt-2" role="status" style={{ color: 'var(--color-muted)' }}>{msg}</p>}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Toolbar pieces
// ---------------------------------------------------------------------------
export function FilterButton({ count, open, onClick }) {
  return (
    <button type="button" onClick={onClick} aria-expanded={open}
      className="btn inline-flex items-center gap-1.5"
      style={count ? { background: 'var(--color-brand-soft)', color: 'var(--color-brand)', border: '1px solid var(--color-brand-border)' } : { background: '#FFFFFF', border: '1px solid var(--color-line)', color: 'var(--color-ink)' }}>
      <Filter className="w-4 h-4" /> Filters{count ? <span className="text-[11px] font-bold px-1.5 rounded-full text-white" style={{ background: 'var(--color-brand)' }}>{count}</span> : null}
    </button>
  );
}

function describe(cond, field, dir) {
  const opLabel = (opsFor(field).find(([k]) => k === cond.op) || [null, cond.op])[1];
  if (NO_VALUE.has(cond.op)) return `${field.label} ${opLabel}`;
  let v = cond.value;
  const k = kindOf(field);
  if (['choice', 'multi', 'user', 'team'].includes(k)) {
    const opts = choiceOptions(field, dir);
    v = asList(cond.value).map((x) => opts.find((o) => String(o.value) === String(x))?.label || x).join(', ');
  } else if (k === 'number' && field.field_type === 'currency') v = formatFieldValue(cond.value, field);
  if (cond.op === 'between') v = `${v} and ${cond.value2}`;
  if (cond.op === 'last_days' || cond.op === 'next_days') return `${field.label} ${opLabel.replace('…', cond.value)}`;
  return `${field.label} ${opLabel} ${v}`;
}

export function ActiveFilterChips({ conditions, match, fields, savedName, onRemove, onClear }) {
  const dir = useDirectory();
  const live = (conditions || []).filter(isComplete);
  if (!live.length) return null;
  return (
    <div className="flex items-center gap-1.5 flex-wrap mt-3" aria-label="Active filters">
      {savedName && <span className="text-[11px] font-semibold px-2 py-1 rounded-lg inline-flex items-center gap-1" style={{ background: 'var(--color-brand-soft)', color: 'var(--color-brand)' }}><Bookmark className="w-3 h-3" />{savedName}</span>}
      {live.length > 1 && <span className="text-[11px]" style={{ color: 'var(--color-muted)' }}>Matching {match === 'any' ? 'any' : 'all'}:</span>}
      {live.map((c, i) => {
        const f = fields.find((x) => x.api_name === c.field);
        if (!f) return null;
        return (
          <span key={i} className="text-[12px] pl-2 pr-1 py-1 rounded-lg border inline-flex items-center gap-1 bg-white" style={{ borderColor: 'var(--color-line)' }}>
            {describe(c, f, dir)}
            <button type="button" onClick={() => onRemove(c)} aria-label={`Remove filter ${f.label}`} className="p-0.5 rounded hover:bg-slate-100"><X className="w-3 h-3" /></button>
          </span>
        );
      })}
      <button type="button" onClick={onClear} className="text-[12px] font-semibold px-1.5" style={{ color: 'var(--color-brand)' }}>Clear all</button>
    </div>
  );
}

export function SavedFiltersMenu({ module, refreshKey, activeId, onSelect }) {
  const [list, setList] = useState(null);
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const load = () => api.listSavedFilters(module).then(setList).catch(() => setList([]));
  useEffect(() => { load(); }, [module, refreshKey]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!open) return undefined;
    const close = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);
  const remove = async (f) => {
    // eslint-disable-next-line no-alert
    if (!window.confirm(`Delete the saved filter “${f.name}”?`)) return;
    await api.deleteSavedFilter(f.id).catch(() => {});
    load();
    if (activeId === f.id) onSelect(null);
  };
  return (
    <div className="relative" ref={ref}>
      <button type="button" onClick={() => setOpen((o) => !o)} aria-haspopup="menu" aria-expanded={open}
        className="btn inline-flex items-center gap-1.5" style={{ background: '#FFFFFF', border: '1px solid var(--color-line)', color: 'var(--color-ink)' }}>
        <Bookmark className="w-4 h-4" style={{ color: 'var(--color-brand)' }} /> Saved filters{list?.length ? ` (${list.length})` : ''} <ChevronDown className="w-3.5 h-3.5 text-slate-400" />
      </button>
      {open && (
        <div role="menu" className="absolute right-0 z-40 mt-1 w-72 bg-white border border-line rounded-xl shadow-xl py-1.5">
          {list === null && <p className="px-3 py-2 text-xs text-slate-400">Loading…</p>}
          {list && list.length === 0 && <p className="px-3 py-2 text-xs text-slate-400">No saved filters yet. Build one with Filters, then “Save filter”.</p>}
          {list && list.map((f) => (
            <div key={f.id} className="flex items-center gap-1 px-1.5">
              <button type="button" role="menuitem" onClick={() => { onSelect(f); setOpen(false); }}
                className="flex-1 min-w-0 text-left px-2 py-2 rounded-lg hover:bg-[var(--color-brand-faint)]">
                <span className="text-sm flex items-center gap-1.5 truncate" style={{ color: 'var(--color-ink)' }}>
                  {activeId === f.id && <Check className="w-3.5 h-3.5 shrink-0" style={{ color: 'var(--color-brand)' }} />}{f.name}
                </span>
                <span className="text-[11px] flex items-center gap-1" style={{ color: 'var(--color-faint)' }}>
                  {f.filters.length} condition{f.filters.length === 1 ? '' : 's'}
                  {f.shared && <><Users className="w-3 h-3" /> shared{!f.mine && f.owner_name ? ` by ${f.owner_name}` : ''}</>}
                </span>
              </button>
              {f.mine && (
                <button type="button" onClick={() => remove(f)} aria-label={`Delete saved filter ${f.name}`} className="p-1.5 rounded hover:bg-slate-100 text-slate-400">
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// The signed-in user, for "is me" conditions.
export function useMe() {
  const { user } = useAuth();
  return user ? { id: user.id, name: user.full_name || user.username } : null;
}

// ---------------------------------------------------------------------------
// Selection + bulk actions
// ---------------------------------------------------------------------------
export function useSelection(resetKey) {
  const [ids, setIds] = useState(() => new Set());
  useEffect(() => { setIds(new Set()); }, [resetKey]);
  return {
    ids,
    has: (id) => ids.has(id),
    toggle: (id) => setIds((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; }),
    setMany: (list, on) => setIds((s) => { const n = new Set(s); list.forEach((id) => (on ? n.add(id) : n.delete(id))); return n; }),
    replace: (list) => setIds(new Set(list)),
    clear: () => setIds(new Set()),
  };
}

export function RowCheckbox({ checked, onChange, label, indeterminate }) {
  const ref = useRef(null);
  useEffect(() => { if (ref.current) ref.current.indeterminate = !!indeterminate; }, [indeterminate]);
  return (
    <input ref={ref} type="checkbox" checked={checked} onChange={onChange} aria-label={label}
      onClick={(e) => e.stopPropagation()} className="w-4 h-4 rounded cursor-pointer accent-[var(--color-brand)]" />
  );
}

// Runs `worker(id)` over ids, a few at a time, reporting progress.
export async function runBulk(ids, worker, onProgress, concurrency = 4) {
  const failed = [];
  let done = 0;
  const queue = [...ids];
  const next = async () => {
    while (queue.length) {
      const id = queue.shift();
      try { await worker(id); } catch (e) { failed.push({ id, error: e.message || 'Failed' }); }
      done += 1;
      onProgress?.(done, ids.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, ids.length) }, next));
  return { ok: ids.length - failed.length, failed };
}

export function BulkBar({ count, pageCount, matchingCount, allPageSelected, onSelectAllMatching, onClear, canEdit, canDelete, canExport, onUpdate, onAssign, onExport, onDelete, hasUserField }) {
  if (!count) return null;
  const btn = 'inline-flex items-center gap-1.5 text-[13px] font-semibold px-3 py-1.5 rounded-lg transition-colors';
  return (
    <div className="sticky top-2 z-20 mt-3 rounded-xl px-3 py-2 flex items-center justify-between gap-3 flex-wrap text-white"
      role="region" aria-label="Bulk actions"
      style={{ background: 'linear-gradient(100deg, #4F46E5, #6C4FF7 60%, #7C3AED)', boxShadow: '0 12px 28px -14px rgba(79,70,229,0.8)' }}>
      <div className="text-[13px] flex items-center gap-2 flex-wrap">
        <b>{count}</b> selected
        {allPageSelected && matchingCount > count && (
          <button type="button" onClick={onSelectAllMatching} className="underline underline-offset-2 text-white/90 hover:text-white">
            Select all {matchingCount} matching records
          </button>
        )}
        {count > pageCount && <span className="text-white/75">(across all pages)</span>}
        <button type="button" onClick={onClear} className="underline underline-offset-2 text-white/80 hover:text-white">Clear selection</button>
      </div>
      <div className="flex items-center gap-1.5 flex-wrap">
        {canEdit && <button type="button" onClick={onUpdate} className={`${btn} bg-white/15 hover:bg-white/25`}><Pencil className="w-4 h-4" /> Bulk update</button>}
        {canEdit && hasUserField && <button type="button" onClick={onAssign} className={`${btn} bg-white/15 hover:bg-white/25`}><UserRoundCog className="w-4 h-4" /> Assign to</button>}
        {canExport && <button type="button" onClick={onExport} className={`${btn} bg-white/15 hover:bg-white/25`}><Download className="w-4 h-4" /> Export</button>}
        {canDelete && <button type="button" onClick={onDelete} className={`${btn} bg-white text-rose-600 hover:bg-rose-50`}><Trash2 className="w-4 h-4" /> Delete</button>}
      </div>
    </div>
  );
}

function Progress({ done, total }) {
  const pct = total ? Math.round((done / total) * 100) : 0;
  return (
    <div className="mt-3" role="status" aria-live="polite">
      <div className="h-2 rounded-full overflow-hidden" style={{ background: 'var(--color-canvas)' }}>
        <div className="h-full rounded-full transition-all" style={{ width: `${pct}%`, background: 'var(--color-brand)' }} />
      </div>
      <p className="text-xs mt-1" style={{ color: 'var(--color-muted)' }}>{done} of {total} done…</p>
    </div>
  );
}

function Result({ result, noun, onClose }) {
  return (
    <div className="mt-3 text-sm" role="status">
      <p style={{ color: 'var(--color-success-strong)' }}>{result.ok} {noun}{result.ok === 1 ? '' : 's'} updated.</p>
      {result.failed.length > 0 && (
        <div className="mt-2 rounded-lg p-2 text-xs max-h-40 overflow-y-auto" style={{ background: 'var(--color-danger-soft)', color: 'var(--color-danger-strong)' }}>
          <b>{result.failed.length} could not be changed:</b>
          <ul className="mt-1 space-y-0.5">{result.failed.slice(0, 20).map((f) => <li key={f.id}>#{f.id}: {f.error}</li>)}</ul>
        </div>
      )}
      <button type="button" onClick={onClose} className="btn btn-primary w-full mt-3">Done</button>
    </div>
  );
}

function Modal({ title, onClose, children }) {
  useEffect(() => {
    const esc = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', esc);
    return () => document.removeEventListener('keydown', esc);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true" aria-label={title}>
      <div className="bg-white rounded-2xl p-5 w-full max-w-md relative shadow-2xl">
        <button type="button" onClick={onClose} aria-label="Close" className="absolute top-4 right-4 text-slate-400 hover:text-ink"><X className="w-4 h-4" /></button>
        <h2 className="text-[15px] font-semibold text-ink mb-4 pr-6">{title}</h2>
        {children}
      </div>
    </div>
  );
}

// Update one field on every selected record.
export function BulkUpdateModal({ fields, count, noun, onRun, onClose }) {
  const editable = useMemo(() => fields.filter((f) => f.show_in_edit !== 0 && !['file', 'image'].includes(f.field_type)), [fields]);
  const [fieldName, setFieldName] = useState(editable[0]?.api_name || '');
  const [value, setValue] = useState('');
  const [clear, setClear] = useState(false);
  const [progress, setProgress] = useState(null);
  const [result, setResult] = useState(null);
  const field = editable.find((f) => f.api_name === fieldName);

  const run = async () => {
    if (!field) return;
    const v = clear ? null : (field.field_type === 'checkbox' ? !!value : value);
    if (!clear && (v === '' || v === undefined) && field.field_type !== 'checkbox') return;
    setProgress({ done: 0, total: count });
    setResult(await onRun(field, v, (done, total) => setProgress({ done, total })));
  };

  return (
    <Modal title={`Bulk update ${count} ${noun}${count === 1 ? '' : 's'}`} onClose={onClose}>
      {result ? <Result result={result} noun={noun} onClose={onClose} /> : (
        <>
          <label className="text-xs font-medium text-slate-500 block">Field to update
            <select className="input w-full mt-1" value={fieldName} onChange={(e) => { setFieldName(e.target.value); setValue(''); setClear(false); }} disabled={!!progress}>
              {editable.map((f) => <option key={f.api_name} value={f.api_name}>{f.label}</option>)}
            </select>
          </label>
          {field && (
            <div className="mt-3">
              <span className="text-xs font-medium text-slate-500 block mb-1">New value</span>
              {clear ? <p className="text-xs text-slate-400 py-2">The field will be emptied on every selected record.</p>
                : <FieldInput field={field} value={value} onChange={setValue} />}
              {!field.required && (
                <label className="text-xs inline-flex items-center gap-1.5 mt-2" style={{ color: 'var(--color-muted)' }}>
                  <input type="checkbox" checked={clear} onChange={(e) => setClear(e.target.checked)} /> Clear this field instead
                </label>
              )}
            </div>
          )}
          <p className="text-xs mt-3" style={{ color: 'var(--color-muted)' }}>Each record is saved through its normal update, so validation and automations still apply.</p>
          {progress ? <Progress {...progress} /> : (
            <button type="button" onClick={run} className="btn btn-primary w-full mt-4">Update {count} {noun}{count === 1 ? '' : 's'}</button>
          )}
        </>
      )}
    </Modal>
  );
}

// Assign every selected record to one user.
export function BulkAssignModal({ userFields, count, noun, onRun, onClose }) {
  const dir = useDirectory();
  const [fieldName, setFieldName] = useState(userFields[0]?.api_name);
  const [user, setUser] = useState('');
  const [progress, setProgress] = useState(null);
  const [result, setResult] = useState(null);
  const field = userFields.find((f) => f.api_name === fieldName);
  const users = (dir?.users || []).filter((u) => u.active !== 0);

  const run = async () => {
    const u = users.find((x) => String(x.id) === String(user));
    if (!u || !field) return;
    setProgress({ done: 0, total: count });
    setResult(await onRun(field, field.field_type === 'user_name' ? u.name : u.id, (done, total) => setProgress({ done, total })));
  };
  return (
    <Modal title={`Assign ${count} ${noun}${count === 1 ? '' : 's'}`} onClose={onClose}>
      {result ? <Result result={result} noun={noun} onClose={onClose} /> : (
        <>
          {userFields.length > 1 && (
            <label className="text-xs font-medium text-slate-500 block mb-3">Field
              <select className="input w-full mt-1" value={fieldName} onChange={(e) => setFieldName(e.target.value)}>
                {userFields.map((f) => <option key={f.api_name} value={f.api_name}>{f.label}</option>)}
              </select>
            </label>
          )}
          <label className="text-xs font-medium text-slate-500 block">Assign to
            <select className="input w-full mt-1" value={user} onChange={(e) => setUser(e.target.value)} disabled={!!progress}>
              <option value="">Select a user…</option>
              {users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
            </select>
          </label>
          {progress ? <Progress {...progress} /> : (
            <button type="button" onClick={run} disabled={!user} className="btn btn-primary w-full mt-4 disabled:opacity-50">Assign {count} {noun}{count === 1 ? '' : 's'}</button>
          )}
        </>
      )}
    </Modal>
  );
}

export function BulkDeleteModal({ count, noun, onRun, onClose }) {
  const [progress, setProgress] = useState(null);
  const [result, setResult] = useState(null);
  const [typed, setTyped] = useState('');
  const needsConfirm = count > 10;
  const run = async () => {
    setProgress({ done: 0, total: count });
    setResult(await onRun((done, total) => setProgress({ done, total })));
  };
  return (
    <Modal title={`Delete ${count} ${noun}${count === 1 ? '' : 's'}?`} onClose={onClose}>
      {result ? (
        <div className="text-sm">
          <p style={{ color: 'var(--color-success-strong)' }}>{result.ok} deleted.</p>
          {result.failed.length > 0 && (
            <div className="mt-2 rounded-lg p-2 text-xs max-h-40 overflow-y-auto" style={{ background: 'var(--color-danger-soft)', color: 'var(--color-danger-strong)' }}>
              <b>{result.failed.length} could not be deleted:</b>
              <ul className="mt-1">{result.failed.slice(0, 20).map((f) => <li key={f.id}>#{f.id}: {f.error}</li>)}</ul>
            </div>
          )}
          <button type="button" onClick={onClose} className="btn btn-primary w-full mt-3">Done</button>
        </div>
      ) : (
        <>
          <p className="text-sm" style={{ color: 'var(--color-muted)' }}>This permanently deletes the selected {noun}s. It cannot be undone.</p>
          {needsConfirm && (
            <label className="text-xs font-medium text-slate-500 block mt-3">Type <b>DELETE</b> to confirm
              <input className="input w-full mt-1" value={typed} onChange={(e) => setTyped(e.target.value)} />
            </label>
          )}
          {progress ? <Progress {...progress} /> : (
            <button type="button" onClick={run} disabled={needsConfirm && typed !== 'DELETE'}
              className="w-full mt-4 text-sm font-semibold py-2 rounded-lg text-white disabled:opacity-50" style={{ background: 'var(--color-danger)' }}>
              Delete {count} {noun}{count === 1 ? '' : 's'}
            </button>
          )}
        </>
      )}
    </Modal>
  );
}
