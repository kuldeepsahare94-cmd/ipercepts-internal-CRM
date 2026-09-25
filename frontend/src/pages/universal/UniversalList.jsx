import { useEffect, useMemo, useState } from 'react';
import { Link, useParams, useNavigate } from 'react-router-dom';
import { Kanban as KanbanIcon, Search, MoreHorizontal, Eye, Pencil, LayoutGrid } from 'lucide-react';
import { UniversalRecordEditModal } from '../../components/RecordEditModal';
import ScheduleMeetingModal from '../../components/ScheduleMeetingModal';
import { ModuleIcon } from '../../components/moduleIcons';
import { accentFor, accentGradient } from '../../theme/moduleAccents';
import { avatarGradientFor, initialsOf } from '../../theme/avatarColors';
import QuotationItemsEditor from './QuotationItemsEditor';
import { api } from '../../api';
import { usePermissions } from '../../context/usePermissions';
import StatusBadge from '../../components/StatusBadge';
import { downloadCSV } from '../../utils/csv';
import { getFieldValue, formatFieldValue, renderFieldValue, FieldInput, recordTitle } from './fieldUtils';
import { cachedLabel } from './lookupCache';
import { computeFollowupStatus, findFollowupField } from './followupUtils';
import { kpisFor } from './listKpis';
import { KpiCard, SkeletonRows, ErrorState, EmptyState, friendlyError } from '../../components/ui';

const STATUS_TYPES = new Set(['status', 'contact_status', 'priority']);


// Shared KPI tile for every module list. The uniform part is the treatment
// — gradient chip, accent bar, same proportions everywhere. The distinct
// part is the hue, taken from that module's own accent. Semantic tones
// (success/warning/danger) still win where a metric genuinely carries
// meaning, e.g. "Overdue" should read as a warning regardless of module.
const TONE_GRADIENTS = {
  success: ['#6EE7B7', '#047857'],
  warning: ['#FCD34D', '#B45309'],
  danger: ['#FDA4AF', '#BE123C'],
  info: ['#93C5FD', '#1D4ED8'],
  special: ['#C4B5FD', '#6D28D9'],
  neutral: ['#A7F3D0', '#0F766E'],
};

function ModuleKpi({ label, value, tone, accent, index, icon: Icon, clickable, active, onClick }) {
  // The first tile always carries the module's own identity colour; the
  // rest use their semantic tone so status still reads correctly.
  const [from, to] = index === 0
    ? [accent.from, accent.to]
    : (TONE_GRADIENTS[tone] || [accent.from, accent.to]);
  // Only tiles that can genuinely narrow the list become buttons — a total
  // or a money figure has nothing to filter to, and making it look
  // clickable would be a promise the tile can't keep.
  const Tag = clickable ? 'button' : 'div';
  return (
    <Tag onClick={onClick}
      className={`relative bg-white border rounded-2xl p-4 pt-5 overflow-hidden transition-all w-full text-left ${
        clickable ? 'hover:shadow-md hover:-translate-y-0.5 cursor-pointer' : ''} ${
        active ? 'border-transparent' : 'border-line'}`}
      style={active ? { boxShadow: `0 0 0 2px ${to}` } : undefined}>
      <div className="absolute top-0 left-0 right-0 h-[3px]" style={{ background: `linear-gradient(90deg, ${from}, ${to})` }} />
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-xl shrink-0 flex items-center justify-center text-white shadow-sm"
          style={{ background: `linear-gradient(135deg, ${from}, ${to})` }}>
          {Icon && <Icon className="w-[18px] h-[18px]" />}
        </div>
        <div className="min-w-0">
          <div className="text-xl font-bold text-ink leading-none">{value}</div>
          <div className="text-xs text-slate-500 mt-1 truncate">{label}</div>
        </div>
      </div>
    </Tag>
  );
}

export default function UniversalList() {
  const { moduleApiName } = useParams();
  const navigate = useNavigate();
  const can = usePermissions();

  const [module, setModule] = useState(null);
  const [fields, setFields] = useState([]);
  const [records, setRecords] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [q, setQ] = useState('');
  const [showForm, setShowForm] = useState(false);
  // Quotation line items live outside `form` because they're a child
  // collection, not a column on the record.
  const [quoteItems, setQuoteItems] = useState([]);
  const [discountType, setDiscountType] = useState('percent');
  const [discountValue, setDiscountValue] = useState(0);
  // Quotations, proforma invoices and invoices are all built the same way:
  // a header form plus line items, saved together. The create form offers the
  // line-item editor for all three rather than for quotations alone.
  const SALES_DOCUMENTS = ['quotations', 'proforma_invoices', 'invoices'];
  const isQuotations = SALES_DOCUMENTS.includes(moduleApiName);
  const [form, setForm] = useState({});
  const [saving, setSaving] = useState(false);
  const [statusFilter, setStatusFilter] = useState('');
  const [page, setPage] = useState(1);
  const [openMenu, setOpenMenu] = useState(null);
  const [editingId, setEditingId] = useState(null);   // row being edited in the popup
  const [kpiFilter, setKpiFilter] = useState(null);
  const [fieldErrors, setFieldErrors] = useState({});
  const PAGE_SIZE = 25;

  useEffect(() => {
    setLoading(true);
    setError('');
    api.getModuleMeta(moduleApiName)
      .then(async (mod) => {
        setModule(mod);
        const f = await api.listModuleFields(mod.id);
        setFields(f);
      })
      .catch((e) => setError(friendlyError(e, `Unable to load ${moduleApiName}.`)))
      .finally(() => setLoading(false));
  }, [moduleApiName]);

  const load = () => {
    if (!module) return;
    api.universalList(module, { q }).then(setRecords).catch((e) => setError(friendlyError(e, 'Unable to load records.')));
  };
  useEffect(() => { load(); }, [module]);
  useEffect(() => { const t = setTimeout(load, 300); return () => clearTimeout(t); }, [q]);

  const listFields = useMemo(() => fields.filter((f) => f.show_in_list), [fields]);
  const createFields = useMemo(() => fields.filter((f) => f.show_in_create), [fields]);

  const defaultsForCreate = useMemo(() => {
    const out = {};
    createFields.forEach((f) => {
      if (f.default_value === null || f.default_value === undefined || f.default_value === '') return;
      out[f.api_name] = f.field_type === 'checkbox'
        ? ['1', 'true', 'yes'].includes(String(f.default_value).toLowerCase())
        : f.default_value;
    });
    return out;
  }, [createFields]);
  const statusField = useMemo(() => fields.find((f) => STATUS_TYPES.has(f.api_name)), [fields]);
  const followupField = useMemo(() => findFollowupField(fields), [fields]);

  // Options for the status filter: prefer the field's own configured
  // options, fall back to whatever values the data actually contains.
  const statusOptions = useMemo(() => {
    if (!statusField) return [];
    try {
      const opts = JSON.parse(statusField.options_json || '[]');
      if (opts.length) return opts.map((o) => (typeof o === 'string' ? o : o.value ?? o.label));
    } catch { /* fall through to deriving from data */ }
    return [...new Set(records.map((r) => r[statusField.api_name]).filter(Boolean))];
  }, [statusField, records]);

  const kpis = useMemo(() => kpisFor(moduleApiName, records), [moduleApiName, records]);

  const filtered = useMemo(() => {
    let rows = statusField && statusFilter
      ? records.filter((r) => r[statusField.api_name] === statusFilter)
      : records;
    // A KPI tile filter stacks on top of the dropdown filters rather than
    // replacing them, so the two controls compose instead of fighting.
    const active = kpis?.find((k) => k.label === kpiFilter);
    if (active?.filter) rows = rows.filter(active.filter);
    return rows;
  }, [records, statusField, statusFilter, kpiFilter, kpis]);


  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const pageRows = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  useEffect(() => { setPage(1); }, [q, statusFilter, kpiFilter, moduleApiName]);

  // Guard order matters. `if (!module) return null` used to run BEFORE the
  // loading check, so while the module was being fetched the page rendered
  // literally nothing — an empty content area indistinguishable from a
  // broken page.
  //
  // It was also only a truthiness check. If the API returned an unexpected
  // shape (an empty array, an object without labels) it passed this guard
  // and then threw on `module.plural_label.toLowerCase()`, taking out the
  // whole route.
  if (loading) {
    return <div className="max-w-[1600px] mx-auto"><SkeletonRows rows={8} cols={5} /></div>;
  }
  if (error) {
    return (
      <div className="max-w-[1600px] mx-auto">
        <ErrorState message={error.message || String(error)} detail={error.detail}
          onRetry={() => { setLoading(true); setError(''); }} />
      </div>
    );
  }
  if (!module || typeof module !== 'object' || !module.api_name) {
    return (
      <div className="max-w-[1600px] mx-auto">
        <ErrorState message={`The "${moduleApiName}" module could not be loaded.`}
          detail={`Expected module metadata, received: ${JSON.stringify(module)}`}
          onRetry={() => { setLoading(true); setError(''); }} />
      </div>
    );
  }

  // Labels are rendered in several places; missing metadata must degrade to
  // the module's api_name rather than throwing.
  const accent = accentFor(module.api_name);
  const pluralLabel = (module.plural_label || module.api_name || 'records');
  const singularLabel = (module.singular_label || module.api_name || 'record');

  // Types where an empty value is legitimate, matching the server's list —
  // a checkbox that is off, or a file uploaded separately, is not "missing".
  const REQUIRED_EXEMPT = new Set(['checkbox', 'file', 'image']);

  const validateRequired = () => {
    const errs = {};
    createFields.forEach((f) => {
      if (!f.required || REQUIRED_EXEMPT.has(f.field_type)) return;
      const v = form[f.api_name];
      if (v === undefined || v === null || String(v).trim() === '') {
        errs[f.api_name] = `${f.label} is required`;
      }
    });
    setFieldErrors(errs);
    return Object.keys(errs).length === 0;
  };

  const submit = async (e) => {
    e.preventDefault();
    if (!validateRequired()) return;
    setSaving(true);
    try {
      const payload = isQuotations
        ? {
          ...form,
          items: quoteItems.map((i) => ({
            product_id: i.product_id || null,
            description: i.description || null,
            quantity: Number(i.quantity) || 0,
            unit_price: Number(i.unit_price) || 0,
            discount_percent: Number(i.discount_percent) || 0,
            tax_percent: Number(i.tax_percent) || 0,
          })),
          overall_discount_type: discountType,
          overall_discount_value: Number(discountValue) || 0,
        }
        : form;
      await api.universalCreate(module, payload);
      setForm(defaultsForCreate);
      setQuoteItems([]);
      setDiscountValue(0);
      setShowForm(false);
      load();
    } catch (err) {
      alert('Could not save: ' + err.message);
    } finally {
      setSaving(false);
    }
  };

  // Lookup columns hold a row id. Exporting those raw produced a spreadsheet
  // with a "Customer" column full of numbers — the names are already on
  // screen, so use the same resolved values the table is showing.
  const exportCsv = () => downloadCSV(`${module.api_name}.csv`, records.map((r) => {
    const row = { id: r.id };
    listFields.forEach((f) => {
      const v = getFieldValue(r, f);
      row[f.label] = f.field_type === 'lookup'
        ? (cachedLabel(f.lookup_module, v) ?? '')
        : v;
    });
    return row;
  }));



  return (
    <div className="relative max-w-[1600px] mx-auto rounded-3xl -m-4 sm:-m-6 p-4 sm:p-6">
      {/* Background treatment, tinted by THIS module's accent — so Accounts
          sits on a faint blue wash and Tickets on a rose one, while the
          treatment itself (dot grid + corner blooms) is identical
          everywhere. That's the uniform-system / distinct-module split
          applied to the canvas rather than just the components.

          Every layer is pointer-events-none behind a negative z-index, so
          it can never intercept a click or sit on top of content. */}
      <div aria-hidden="true" className="absolute inset-0 z-0 overflow-hidden rounded-3xl pointer-events-none">
        <div className="absolute inset-0" style={{
          backgroundImage: `radial-gradient(circle at 1px 1px, ${accent.solid}33 1px, transparent 0)`,
          backgroundSize: '22px 22px',
        }} />
        <div className="absolute -top-32 -right-28 w-[520px] h-[520px] rounded-full" style={{
          background: `radial-gradient(circle, ${accent.solid}38, transparent 70%)`,
        }} />
        <div className="absolute -bottom-36 -left-28 w-[460px] h-[460px] rounded-full" style={{
          background: `radial-gradient(circle, ${accent.solid}2E, transparent 70%)`,
        }} />
      </div>

      <div className="relative z-10">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <div className="w-11 h-11 rounded-xl flex items-center justify-center shrink-0 text-white shadow-sm"
            style={{ background: module.color ? `${module.color}` : accentGradient(module.api_name) }}>
            <ModuleIcon name={module.icon} className="w-5 h-5" />
          </div>
          <div>
            <h1 className="t-page-title">{pluralLabel}</h1>
            {module.description && <p className="text-sm text-slate-500 mt-1">{module.description}</p>}
          </div>
        </div>
        <div className="flex gap-2">
          {!!module.has_pipeline && (
            <button onClick={() => navigate(`/records/${module.api_name}/kanban`)}
              className="border border-line text-sm font-medium px-4 py-2 rounded-lg hover:bg-white inline-flex items-center gap-2">
              <KanbanIcon className="w-4 h-4" /> Kanban
            </button>
          )}
          {can(module.api_name, 'export') && (
            <button onClick={exportCsv} className="btn btn-secondary">Export CSV</button>
          )}
          {can(module.api_name, 'create') && (
            <button onClick={() => setShowForm((s) => {
              setFieldErrors({});
              // Opening the form seeds it with each field's configured
              // default. module_fields has carried a default_value column all
              // along and nothing ever read it, so every new record started
              // blank — including Currency, which is INR for this business on
              // essentially every quotation.
              if (!s) setForm(defaultsForCreate);
              return !s;
            })} className="btn btn-primary">
              {showForm ? 'Cancel' : `+ Add ${module.singular_label}`}
            </button>
          )}
        </div>
      </div>

      {kpis && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-5">
          {kpis.map((k, i) => (
            <ModuleKpi key={k.label} label={k.label} value={k.value} tone={k.tone} accent={accent} index={i} icon={k.icon}
              clickable={!!k.filter} active={kpiFilter === k.label}
              onClick={k.filter ? () => setKpiFilter(kpiFilter === k.label ? null : k.label) : undefined} />
          ))}
        </div>
      )}

      <div className="flex gap-2 mt-5 flex-wrap">
        <div className="relative flex-1 min-w-[220px]">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-[var(--color-faint)]" />
          <input value={q} onChange={(e) => setQ(e.target.value)} className="input pl-9"
            placeholder={`Search ${pluralLabel.toLowerCase()}…`}
            aria-label={`Search ${module.plural_label}`} />
        </div>
        {statusOptions.length > 0 && (
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}
            className="input w-auto min-w-[150px]" aria-label={`Filter by ${statusField.label || 'status'}`}>
            <option value="">All {(statusField.label || 'statuses').toLowerCase()}</option>
            {statusOptions.map((o) => <option key={o} value={o}>{o}</option>)}
          </select>
        )}
      </div>

      {showForm && (
        <form onSubmit={submit} className="card p-5 mt-5 grid grid-cols-2 gap-4">
          {createFields.map((f) => (
            <div key={f.id} className={f.field_type === 'textarea' ? 'col-span-2' : ''}>
              <label className="text-xs text-slate-500 font-medium block mb-1">
                {f.label}
                {f.required ? <span style={{ color: 'var(--color-danger)' }}> *</span> : null}
              </label>
              <div className={fieldErrors[f.api_name] ? 'rounded-lg' : ''}
                style={fieldErrors[f.api_name] ? { boxShadow: '0 0 0 2px var(--color-danger)' } : undefined}>
                <FieldInput field={f} value={form[f.api_name]}
                  onChange={(v) => {
                    setForm({ ...form, [f.api_name]: v });
                    // Clear the error as soon as they start fixing it —
                    // leaving it red while they type reads as broken.
                    if (fieldErrors[f.api_name]) {
                      setFieldErrors((prev) => { const n = { ...prev }; delete n[f.api_name]; return n; });
                    }
                  }} />
              </div>
              {fieldErrors[f.api_name] && (
                <p className="text-xs mt-1" style={{ color: 'var(--color-danger)' }}>{fieldErrors[f.api_name]}</p>
              )}
            </div>
          ))}
          {isQuotations && (
            <QuotationItemsEditor
              items={quoteItems} setItems={setQuoteItems}
              discountType={discountType} setDiscountType={setDiscountType}
              discountValue={discountValue} setDiscountValue={setDiscountValue}
            />
          )}
          <button type="submit" disabled={saving} className="col-span-2 bg-amber text-white text-sm font-medium py-2 rounded-lg hover:opacity-90 disabled:opacity-50">
            {saving ? 'Saving…' : `Save ${singularLabel.toLowerCase()}`}
          </button>
        </form>
      )}

      <div className="card mt-6 overflow-hidden overflow-x-auto shadow-sm">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left border-b-2" style={{ background: `${accent.solid}0D`, borderColor: `${accent.solid}33` }}>
              {listFields.map((f) => <th key={f.id} className="py-3 px-4 font-medium">{f.label}</th>)}
              {listFields.length === 0 && <th className="py-3 px-4 font-medium">Record</th>}
              {followupField && <th className="py-3 px-4 font-medium">Follow-up</th>}
              {module.api_name === 'accounts' && (
                <>
                  <th className="py-3 px-4 t-meta font-semibold text-right">Contacts</th>
                  <th className="py-3 px-4 t-meta font-semibold text-right">Open deals</th>
                  <th className="py-3 px-4 t-meta font-semibold text-right">Pipeline</th>
                  <th className="py-3 px-4 t-meta font-semibold">Owner</th>
                  <th className="py-3 px-4 t-meta font-semibold text-right"></th>
                </>
              )}
              {can(module.api_name, 'edit') && <th className="py-3 px-4 font-medium text-right whitespace-nowrap">Actions</th>}
            </tr>
          </thead>
          <tbody>
            {pageRows.map((r) => (
              <tr key={r.id} className="border-b border-line/60 transition-colors cursor-pointer"
                onMouseEnter={(e) => { e.currentTarget.style.background = `${accent.solid}0A`; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = ''; }}
                onClick={() => navigate(`/records/${module.api_name}/${r.id}`)}>
                {listFields.length > 0 ? listFields.map((f, i) => (
                  <td key={f.id} className="py-3 px-4">
                    {i === 0 ? (
                      // An initials chip on the primary column. The first
                      // cell was plain text with nothing to anchor the eye,
                      // which is a large part of why the table read as flat.
                      // Deterministic per record name, in the module accent.
                      <Link to={`/records/${module.api_name}/${r.id}`} onClick={(e) => e.stopPropagation()}
                        className="flex items-center gap-2.5 group">
                        <span className="w-8 h-8 rounded-lg flex items-center justify-center text-[11px] font-bold text-white shrink-0 shadow-sm"
                          style={{ background: avatarGradientFor(formatFieldValue(getFieldValue(r, f), f)) }}>
                          {initialsOf(formatFieldValue(getFieldValue(r, f), f))}
                        </span>
                        <span className="text-ink font-medium group-hover:text-[var(--color-brand)] truncate">
                          {formatFieldValue(getFieldValue(r, f), f)}
                        </span>
                      </Link>
                    ) : f.api_name === statusField?.api_name ? (
                      <StatusBadge status={getFieldValue(r, f)} />
                    ) : (
                      <span className="text-slate-500">{renderFieldValue(r, f)}</span>
                    )}
                  </td>
                )) : (
                  <td className="py-3 px-4"><Link to={`/records/${module.api_name}/${r.id}`} className="text-ink font-medium hover:text-amber">{recordTitle(r, fields)}</Link></td>
                )}
                {module.api_name === 'accounts' && (
                  <>
                    <td className="py-3 px-4 text-right">
                      <span className="text-slate-500 tabular-nums">{r.contact_count ?? 0}</span>
                      {r.open_ticket_count > 0 && (
                        <span className="ml-1.5 text-[10px] font-semibold px-1.5 py-0.5 rounded-full"
                          style={{ background: 'var(--color-danger-soft)', color: 'var(--color-danger)' }}
                          title={`${r.open_ticket_count} open ticket(s)`}>
                          {r.open_ticket_count}
                        </span>
                      )}
                    </td>
                    <td className="py-3 px-4 text-right text-slate-500 tabular-nums">{r.open_deal_count ?? 0}</td>
                    <td className="py-3 px-4 text-right tabular-nums">
                      {r.open_pipeline_value > 0
                        ? <span className="text-ink font-semibold">₹{Number(r.open_pipeline_value).toLocaleString('en-IN')}</span>
                        : <span className="text-slate-300">—</span>}
                      {r.won_value > 0 && (
                        <div className="text-[11px]" style={{ color: 'var(--color-success)' }}>
                          ₹{Number(r.won_value).toLocaleString('en-IN')} won
                        </div>
                      )}
                    </td>
                    <td className="py-3 px-4 text-slate-500">{r.owner_name || '—'}</td>
                    <td className="py-3 px-4 text-right">
                      <Link to={`/customer-360/${r.id}`} onClick={(e) => e.stopPropagation()}
                        className="text-xs font-semibold whitespace-nowrap px-2.5 py-1.5 rounded-lg"
                        style={{ background: `${accent.solid}14`, color: accent.solid }}>
                        Customer 360 →
                      </Link>
                    </td>
                  </>
                )}
                {followupField && (
                  <td className="py-3 px-4">
                    {(() => { const s = computeFollowupStatus(getFieldValue(r, followupField)); return (
                      <span className="inline-flex items-center gap-1.5 text-xs text-slate-500">
                        <span className="w-2 h-2 rounded-full shrink-0" style={{ background: s.color }} /> {s.label}
                      </span>
                    ); })()}
                  </td>
                )}
                {/* Edit opens the same popup as the detail page, right here —
                    no trip to the record and back to find your place in the
                    list again. Shown only to roles with edit on this module. */}
                {can(module.api_name, 'edit') && (
                  <td className="py-3 px-4 text-right whitespace-nowrap">
                    <button onClick={(e) => { e.stopPropagation(); setEditingId(r.id); }}
                      title={`Edit this ${singularLabel.toLowerCase()}`} aria-label={`Edit ${singularLabel.toLowerCase()}`}
                      className="inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-1.5 rounded-lg border border-line bg-white transition-colors hover:border-[var(--color-brand-border)] hover:bg-[var(--color-brand-faint)]"
                      style={{ color: 'var(--color-ink)' }}>
                      <Pencil className="w-3.5 h-3.5" style={{ color: accent.solid }} /> Edit
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>

        {filtered.length === 0 && (
          <div className="py-12 text-center">
            <p className="t-section mb-1">
              No {pluralLabel.toLowerCase()} {q || statusFilter ? 'match your filters' : 'yet'}
            </p>
            <p className="t-meta">
              {q || statusFilter
                ? 'Try clearing the search or filter.'
                : `Add your first ${singularLabel.toLowerCase()} to get started.`}
            </p>
          </div>
        )}

        {filtered.length > 0 && (
          <div className="flex items-center justify-between gap-3 px-4 py-2.5 border-t border-line flex-wrap">
            <span className="t-meta">
              Showing {(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, filtered.length)} of {filtered.length}
              {filtered.length !== records.length ? ` (filtered from ${records.length})` : ''}
            </span>
            {totalPages > 1 && (
              <div className="flex items-center gap-1">
                <button onClick={() => setPage((n) => Math.max(1, n - 1))} disabled={page === 1}
                  className="btn btn-secondary disabled:opacity-40">Previous</button>
                <span className="t-meta px-2">Page {page} of {totalPages}</span>
                <button onClick={() => setPage((n) => Math.min(totalPages, n + 1))} disabled={page === totalPages}
                  className="btn btn-secondary disabled:opacity-40">Next</button>
              </div>
            )}
          </div>
        )}
      </div>
      </div>

      {editingId && module.api_name === 'meetings' && (
        <ScheduleMeetingModal initial={{ meeting_id: editingId }}
          onClose={() => setEditingId(null)}
          onSaved={() => { setEditingId(null); load(); }} />
      )}
      {editingId && module.api_name !== 'meetings' && (
        <UniversalRecordEditModal
          moduleApiName={module.api_name} recordId={editingId}
          module={module} fields={fields}
          onClose={() => setEditingId(null)}
          onSaved={() => { setEditingId(null); load(); }} />
      )}
    </div>
  );
}
