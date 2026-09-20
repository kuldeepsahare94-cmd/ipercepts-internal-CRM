import { useEffect, useState } from 'react';
import { Database, History, Download, Upload, FileText } from 'lucide-react';
import { api } from '../api';
import { usePermissions } from '../context/usePermissions';
import { PageHeader } from '../components/ui';

const inputClass = 'border border-line rounded-lg px-3 py-1.5 text-sm';

function ImportExportSection({ modules }) {
  const [selected, setSelected] = useState('');
  const [csv, setCsv] = useState('');
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  // When on, headers the module doesn't have yet become new fields instead
  // of rejecting the file. On by default because that is almost always what
  // someone importing an export from another CRM wants.
  const [autoCreate, setAutoCreate] = useState(true);

  const onFile = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => { setCsv(String(reader.result)); setResult(null); setError(null); };
    reader.readAsText(file);
    e.target.value = '';
  };

  const run = async (dryRun) => {
    if (!selected || !csv.trim()) return;
    setBusy(true); setResult(null); setError(null);
    try {
      const r = await api.importCsv(selected, csv, dryRun, autoCreate);
      setResult(r);
    } catch (err) {
      // The backend returns structured validation detail — surface it rather
      // than collapsing everything into one opaque message.
      try { setError(JSON.parse(err.message)); } catch { setError({ error: err.message }); }
    } finally { setBusy(false); }
  };

  return (
    <div className="card p-5">
      <h2 className="text-sm font-semibold text-ink mb-1 flex items-center gap-1.5">
        <Database className="w-4 h-4 text-amber" /> Import &amp; Export
      </h2>
      <p className="text-xs text-slate-400 mb-4">Export any module to CSV, or bulk-import records. Imports are all-or-nothing — if any row fails validation, nothing is written.</p>

      <label className="text-xs text-slate-500 font-medium block mb-1">Module</label>
      <select value={selected} onChange={(e) => { setSelected(e.target.value); setResult(null); setError(null); }} className={inputClass + ' w-full mb-3'}>
        <option value="">Select a module…</option>
        {modules.map((m) => <option key={m.api_name} value={m.api_name}>{m.plural_label}</option>)}
      </select>

      {selected && (
        <>
          <div className="flex gap-2 flex-wrap mb-4">
            <a href={api.exportUrl(selected)} className="text-xs border border-line rounded-lg px-3 py-1.5 hover:bg-canvas inline-flex items-center gap-1.5">
              <Download className="w-3.5 h-3.5" /> Export CSV
            </a>
            <a href={api.importTemplateUrl(selected)} className="text-xs border border-line rounded-lg px-3 py-1.5 hover:bg-canvas inline-flex items-center gap-1.5">
              <FileText className="w-3.5 h-3.5" /> Blank template
            </a>
            <label className="text-xs border border-line rounded-lg px-3 py-1.5 hover:bg-canvas cursor-pointer inline-flex items-center gap-1.5">
              <Upload className="w-3.5 h-3.5" /> Choose CSV file
              <input type="file" accept=".csv,text/csv" onChange={onFile} className="hidden" />
            </label>
          </div>

          <label className="text-xs text-slate-500 font-medium block mb-1">CSV content</label>
          <textarea value={csv} onChange={(e) => { setCsv(e.target.value); setResult(null); setError(null); }} rows={6}
            placeholder="Paste CSV here, or choose a file above. First row must be column headers."
            className="border border-line rounded-lg px-3 py-2 text-xs w-full font-mono" />

          <label className="flex items-start gap-2 mt-3 text-xs text-slate-600 cursor-pointer">
            <input type="checkbox" checked={autoCreate} onChange={(e) => { setAutoCreate(e.target.checked); setResult(null); setError(null); }}
              className="mt-0.5 w-3.5 h-3.5" />
            <span>
              <strong className="text-ink">Create missing fields automatically</strong> — columns this module
              doesn't have yet become new fields, with the type worked out from the data. Headers that mean the
              same as an existing field (e.g. "Email Address" → Email) are matched to it instead of duplicated.
            </span>
          </label>

          <div className="flex gap-2 mt-3">
            <button onClick={() => run(true)} disabled={busy || !csv.trim()}
              className="border border-line text-sm font-medium px-4 py-2 rounded-lg hover:bg-canvas disabled:opacity-50">
              {busy ? 'Checking…' : 'Validate only'}
            </button>
            <button onClick={() => run(false)} disabled={busy || !csv.trim()}
              className="btn btn-primary disabled:opacity-50">
              {busy ? 'Importing…' : 'Import'}
            </button>
          </div>

          {result && (
            <div className="text-xs text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2 mt-3 space-y-2">
              <div className="font-medium">
                {result.dry_run
                  ? `Looks good — ${result.would_import} row(s) would be imported.`
                  : `Imported ${result.imported} row(s).`}
              </div>

              {(result.fields_created?.length > 0 || result.create?.length > 0) && (
                <div>
                  <div className="font-medium">
                    {result.dry_run ? 'Fields that would be created:' : 'New fields created:'}
                  </div>
                  <ul className="list-disc list-inside mt-0.5">
                    {(result.fields_created || result.create).map((f) => (
                      <li key={f.api_name || f.column}>
                        {f.label} <span className="opacity-70">({f.field_type})</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {(result.mapped_to_existing?.length > 0 || result.mapped?.length > 0) && (
                <div>
                  <div className="font-medium">Matched to fields you already have:</div>
                  <ul className="list-disc list-inside mt-0.5">
                    {(result.mapped_to_existing || result.mapped).map((m) => (
                      <li key={m.header}>{m.header} → {m.field || m.column}</li>
                    ))}
                  </ul>
                </div>
              )}

              {result.skipped?.length > 0 && (
                <div>
                  <div className="font-medium">Ignored:</div>
                  <ul className="list-disc list-inside mt-0.5">
                    {result.skipped.map((sk, i) => <li key={i}>{sk.header} — {sk.reason}</li>)}
                  </ul>
                </div>
              )}

              {result.display_name_filled_from && (
                <div className="opacity-80">
                  Record names were built from {result.display_name_filled_from.join(' + ')}.
                </div>
              )}
            </div>
          )}

          {error && (
            <div className="text-xs text-warn bg-red-50 border border-red-200 rounded-lg px-3 py-2 mt-3">
              <div className="font-medium">{error.error}</div>
              {error.issues && (
                <ul className="list-disc list-inside mt-1.5 space-y-0.5">
                  {error.issues.map((i, idx) => <li key={idx}>{i}</li>)}
                </ul>
              )}
              {error.total_issues > (error.issues?.length || 0) && (
                <div className="mt-1">…and {error.total_issues - error.issues.length} more.</div>
              )}
              {error.allowed_columns && (
                <div className="mt-1.5">Valid columns: {error.allowed_columns.join(', ')}</div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function AuditSection({ modules }) {
  const [rows, setRows] = useState([]);
  const [moduleFilter, setModuleFilter] = useState('');
  const [loading, setLoading] = useState(true);

  const load = () => {
    setLoading(true);
    api.listAudit({ module: moduleFilter || undefined, limit: 200 })
      .then(setRows).catch(() => setRows()).finally(() => setLoading(false));
  };
  useEffect(() => { load(); }, [moduleFilter]);

  const describe = (r) => {
    if (r.action === 'created') return `created ${r.singular_label} #${r.record_id}`;
    if (r.action === 'deleted') return `deleted ${r.singular_label} #${r.record_id}`;
    if (r.action === 'field_changed') {
      return `changed ${r.field_api_name} on ${r.singular_label} #${r.record_id}`;
    }
    return `${r.action} ${r.singular_label} #${r.record_id}`;
  };

  return (
    <div className="card p-5 mt-6">
      <div className="flex items-center justify-between flex-wrap gap-3 mb-1">
        <h2 className="text-sm font-semibold text-ink flex items-center gap-1.5">
          <History className="w-4 h-4 text-amber" /> Audit Log
        </h2>
        <select value={moduleFilter} onChange={(e) => setModuleFilter(e.target.value)} className={inputClass}>
          <option value="">All modules</option>
          {modules.map((m) => <option key={m.api_name} value={m.api_name}>{m.plural_label}</option>)}
        </select>
      </div>
      <p className="text-xs text-slate-400 mb-4">Who changed what, most recent first. Showing the latest 200 entries.</p>

      {loading && <p className="text-xs text-slate-400">Loading…</p>}
      {!loading && rows.length === 0 && <p className="text-xs text-slate-400">No activity recorded yet.</p>}

      {!loading && rows.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-slate-400 border-b border-line">
                <th className="py-2 pr-3 font-medium">When</th>
                <th className="py-2 pr-3 font-medium">Who</th>
                <th className="py-2 pr-3 font-medium">What</th>
                <th className="py-2 font-medium">Change</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-b border-line/60">
                  <td className="py-2 pr-3 text-slate-500 whitespace-nowrap">{r.created_at}</td>
                  <td className="py-2 pr-3 text-slate-600">{r.full_name || r.username || '—'}</td>
                  <td className="py-2 pr-3 text-ink">{describe(r)}</td>
                  <td className="py-2 text-slate-500">
                    {r.action === 'field_changed'
                      ? <span><span className="line-through opacity-60">{r.old_value || '(empty)'}</span> → {r.new_value || '(empty)'}</span>
                      : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export default function SettingsData() {
  const can = usePermissions();
  const [modules, setModules] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.listModulesMeta()
      // Import/export and audit only make sense for modules backed by a real
      // table — custom JSON-backed modules store everything in one blob.
      .then((m) => setModules(m.filter((x) => x.table_name)))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="py-8 t-meta">Loading…</div>;

  return (
    <div className="max-w-[1600px] mx-auto">
      <PageHeader
        title="Data & Audit"
        subtitle="Bulk import/export, and a record of who changed what."
        icon={Database}
        accent="documents"
      />
{can('settings', 'edit') && <ImportExportSection modules={modules} />}
      {can('settings', 'view') && <AuditSection modules={modules} />}
    </div>
  );
}
