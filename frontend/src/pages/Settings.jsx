import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { CalendarDays, Settings as SettingsIcon, Plus, Trash2, Sparkles, Database, ShieldCheck, Boxes, Zap, GitBranch, Users2, History, Percent, Mail, LayoutList, Check, AlertTriangle, Building2, LayoutTemplate } from 'lucide-react';
import { api } from '../api';
import { usePermissions } from '../context/usePermissions';

const LIST_TYPES = [
  { key: 'lead_source', label: 'Lead Source' },
  { key: 'qualification', label: 'Qualification' },
  { key: 'payment_mode', label: 'Payment Mode' },
];

function ReceiptTemplateCard({ template, onSaved }) {
  const [form, setForm] = useState(template);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    await api.updateReceiptTemplate(template.id, form);
    setSaving(false);
    onSaved();
  };

  return (
    <div className="card p-5">
      <h3 className="text-sm font-semibold text-ink mb-3">Institute {template.id} Receipt Template</h3>
      <div className="space-y-3">
        <div>
          <label className="text-xs font-medium text-slate-500 block mb-1">Institute Name</label>
          <input className="input" value={form.institute_name || ''}
            onChange={(e) => setForm({ ...form, institute_name: e.target.value })} />
        </div>
        <div>
          <label className="text-xs font-medium text-slate-500 block mb-1">Logo URL</label>
          <input className="input" value={form.logo_url || ''}
            placeholder="https://…" onChange={(e) => setForm({ ...form, logo_url: e.target.value })} />
        </div>
        <div>
          <label className="text-xs font-medium text-slate-500 block mb-1">Address</label>
          <textarea className="input" value={form.address || ''}
            onChange={(e) => setForm({ ...form, address: e.target.value })} />
        </div>
        <div>
          <label className="text-xs font-medium text-slate-500 block mb-1">GST Details</label>
          <input className="input" value={form.gst_details || ''}
            onChange={(e) => setForm({ ...form, gst_details: e.target.value })} />
        </div>
        <div>
          <label className="text-xs font-medium text-slate-500 block mb-1">Footer Text</label>
          <textarea className="input" value={form.footer_text || ''}
            onChange={(e) => setForm({ ...form, footer_text: e.target.value })} />
        </div>
        <button onClick={save} disabled={saving} className="bg-amber text-white text-sm font-medium px-4 py-2 rounded-lg hover:opacity-90 disabled:opacity-60">
          {saving ? 'Saving…' : 'Save template'}
        </button>
      </div>
    </div>
  );
}

function OptionList({ listType, label }) {
  const [options, setOptions] = useState([]);
  const [newLabel, setNewLabel] = useState('');

  const load = () => api.listMasterOptions(listType).then(setOptions);
  useEffect(() => { load(); }, []);

  const add = async (e) => {
    e.preventDefault();
    if (!newLabel.trim()) return;
    await api.createMasterOption({ list_type: listType, label: newLabel.trim(), sort_order: options.length });
    setNewLabel('');
    load();
  };

  const remove = async (o) => { await api.deleteMasterOption(o.id); load(); };

  return (
    <div className="card p-5">
      <h3 className="text-sm font-semibold text-ink mb-3">{label}</h3>
      <ul className="space-y-1.5 mb-3">
        {options.map((o) => (
          <li key={o.id} className="flex items-center justify-between text-sm bg-canvas rounded-lg px-3 py-1.5">
            {o.label}
            <button onClick={() => remove(o)} className="text-slate-400 hover:text-warn"><Trash2 className="w-3.5 h-3.5" /></button>
          </li>
        ))}
        {options.length === 0 && <li className="text-sm text-slate-400">No options yet.</li>}
      </ul>
      <form onSubmit={add} className="flex gap-2">
        <input value={newLabel} onChange={(e) => setNewLabel(e.target.value)} placeholder="Add option…"
          className="border border-line rounded-lg px-3 py-1.5 text-sm flex-1" />
        <button type="submit" className="border border-line rounded-lg px-3 py-1.5 text-sm hover:bg-canvas"><Plus className="w-4 h-4" /></button>
      </form>
    </div>
  );
}

function AiAuditLog() {
  const [rows, setRows] = useState(null);
  useEffect(() => { api.assistantAuditLog().then(setRows).catch(() => setRows([])); }, []);
  if (rows === null) return null;
  return (
    <div className="card overflow-hidden overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left bg-[var(--color-canvas)] border-b border-line">
            <th className="py-2.5 px-4 font-medium">When</th>
            <th className="py-2.5 px-4 font-medium">User</th>
            <th className="py-2.5 px-4 font-medium">Tool</th>
            <th className="py-2.5 px-4 font-medium">Type</th>
            <th className="py-2.5 px-4 font-medium">Status</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="border-b border-line/60">
              <td className="py-2 px-4 text-xs text-slate-400 whitespace-nowrap">{r.created_at}</td>
              <td className="py-2 px-4 text-slate-600">{r.username}</td>
              <td className="py-2 px-4 text-ink font-medium">{r.tool_name}</td>
              <td className="py-2 px-4 text-slate-500">{r.is_write ? 'Write' : 'Read'}</td>
              <td className="py-2 px-4">
                <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${
                  r.status === 'success' ? 'bg-emerald-100 text-good' : r.status === 'denied' ? 'bg-red-50 text-warn' : 'bg-amber-soft text-amber'
                }`}>{r.status}</span>
              </td>
            </tr>
          ))}
          {rows.length === 0 && <tr><td colSpan={5} className="py-6 text-center text-slate-400">No AI assistant activity yet.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

export default function Settings() {
  const can = usePermissions();
  const [templates, setTemplates] = useState([]);
  const [seeding, setSeeding] = useState(false);
  const [seedResult, setSeedResult] = useState(null);
  const load = () => api.listReceiptTemplates().then(setTemplates);
  useEffect(() => { load(); }, []);

  // What is loaded right now, so the panel can say so instead of leaving the
  // admin to press the button and find out.
  const [demoStatus, setDemoStatus] = useState(null);
  const loadDemoStatus = () => api.demoDataStatus().then(setDemoStatus).catch(() => {});
  useEffect(() => { loadDemoStatus(); }, []);

  const seedDemoData = async () => {
    const already = demoStatus?.loaded;
    const warning = already
      ? 'Demo data is already loaded. This will clear it and build a fresh set.\n\nRecords you entered yourself are not touched. Continue?'
      : 'This fills every module with about a year of sample data — customers, deals, quotations, proforma invoices, invoices, payments, tickets and activity history.\n\nYou can remove all of it again with one click. Continue?';
    if (!confirm(warning)) return;
    setSeeding(true);
    setSeedResult(null);
    try {
      const res = await api.seedDemoData();
      setSeedResult(res);
      loadDemoStatus();
    } catch (err) {
      alert('Could not load demo data: ' + err.message);
    } finally {
      setSeeding(false);
    }
  };

  const [repairing, setRepairing] = useState(false);
  const [repairResult, setRepairResult] = useState(null);
  const repairPermissions = async () => {
    setRepairing(true);
    setRepairResult(null);
    try {
      const res = await api.repairPermissions();
      setRepairResult(res);
    } catch (err) {
      alert('Could not repair permissions: ' + err.message);
    } finally {
      setRepairing(false);
    }
  };

  const [wiping, setWiping] = useState(false);
  const wipeDemoData = async () => {
    if (!confirm('Remove every demo record?\n\nAnything you entered yourself stays exactly as it is.')) return;
    setWiping(true);
    setSeedResult(null);
    try {
      const res = await api.wipeDemoData();
      setSeedResult(res);
      loadDemoStatus();
    } catch (err) {
      alert('Could not remove demo data: ' + err.message);
    } finally {
      setWiping(false);
    }
  };

  // "42 accounts, 130 leads, 66 invoices…" — ordered the way someone walking
  // through the sidebar would meet them, not alphabetically.
  const DEMO_ORDER = ['leads', 'accounts', 'contacts', 'opportunities', 'quotations',
    'proforma_invoices', 'invoices', 'payments', 'products', 'subscriptions', 'tickets',
    'calls', 'meetings', 'tasks', 'notes', 'emails', 'documents'];
  const demoLabel = (k) => k.replace(/_/g, ' ');

  const [downloading, setDownloading] = useState(false);
  const [emailingBackup, setEmailingBackup] = useState(false);
  const [backupResult, setBackupResult] = useState(null);
  const [storage, setStorage] = useState(null);
  const [restoring, setRestoring] = useState(false);

  // Tells the admin whether data actually survives a redeploy, rather than
  // leaving them to find out the hard way after one.
  useEffect(() => { api.backupStatus().then(setStorage).catch(() => {}); }, []);

  const restoreBackup = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';                 // let the same file be picked again
    if (!file) return;
    if (!window.confirm(
      `Restore from "${file.name}"?\n\n`
      + 'This replaces the current database when the backend next restarts. '
      + 'The database being replaced is kept as a dated copy, so this can be undone.',
    )) return;

    setRestoring(true);
    setBackupResult(null);
    try {
      const res = await api.restoreBackup(file);
      setBackupResult({ ok: true, message: res.message });
      api.backupStatus().then(setStorage).catch(() => {});
    } catch (err) {
      setBackupResult({ ok: false, message: err.message });
    } finally {
      setRestoring(false);
    }
  };

  const downloadBackup = async () => {
    setDownloading(true);
    try {
      await api.downloadBackup();
    } catch (err) {
      alert('Could not download backup: ' + err.message);
    } finally {
      setDownloading(false);
    }
  };

  const emailBackup = async () => {
    setEmailingBackup(true);
    setBackupResult(null);
    try {
      const res = await api.emailBackupNow();
      setBackupResult({ ok: true, message: `Sent to ${res.sent_to} (${res.size_mb} MB)` });
    } catch (err) {
      setBackupResult({ ok: false, message: err.message });
    } finally {
      setEmailingBackup(false);
    }
  };

  return (
    <div className="max-w-[1600px] mx-auto">
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-xl bg-amber-soft text-amber flex items-center justify-center">
          <SettingsIcon className="w-5 h-5" />
        </div>
        <div>
          <h1 className="t-page-title">Settings</h1>
          <p className="text-sm text-slate-500 mt-1">Receipt templates and master option lists.</p>
        </div>
      </div>

      {can('settings', 'edit') && (
        <Link to="/settings/layout"
          className="card p-5 mt-8 flex items-center justify-between flex-wrap gap-3 hover:border-amber transition-colors">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-indigo-50 text-indigo-600 flex items-center justify-center shrink-0">
              <LayoutList className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-sm font-semibold text-ink">Field &amp; Layout Manager</h2>
              <p className="text-xs text-slate-500 mt-0.5">
                Choose which fields appear in the list, form and detail views, set their order,
                mark fields mandatory, and preview each screen before you save.
              </p>
            </div>
          </div>
          <span className="text-sm font-medium text-amber">Open →</span>
        </Link>
      )}

      {can('settings', 'edit') && (
        <Link to="/settings/modules"
          className="card p-5 mt-8 flex items-center justify-between flex-wrap gap-3 hover:border-amber transition-colors">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-violet-50 text-violet-600 flex items-center justify-center shrink-0">
              <Boxes className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-sm font-semibold text-ink">Modules &amp; Fields</h2>
              <p className="text-xs text-slate-500 mt-0.5">
                Create custom modules (Vendors, Properties, ...), add fields to any module, and control what shows where.
              </p>
            </div>
          </div>
          <span className="text-xs font-medium text-amber shrink-0">Open →</span>
        </Link>
      )}

      {can('settings', 'edit') && (
        <Link to="/settings/workflows"
          className="card p-5 mt-4 flex items-center justify-between flex-wrap gap-3 hover:border-amber transition-colors">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-violet-50 text-violet-600 flex items-center justify-center shrink-0">
              <Zap className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-sm font-semibold text-ink">Workflows</h2>
              <p className="text-xs text-slate-500 mt-0.5">
                Automate what happens when a record is created, updated, or a field changes.
              </p>
            </div>
          </div>
          <span className="text-xs font-medium text-amber shrink-0">Open →</span>
        </Link>
      )}

      {can('settings', 'edit') && (
        <Link to="/settings/pipelines"
          className="card p-5 mt-4 flex items-center justify-between flex-wrap gap-3 hover:border-amber transition-colors">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-violet-50 text-violet-600 flex items-center justify-center shrink-0">
              <GitBranch className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-sm font-semibold text-ink">Pipelines</h2>
              <p className="text-xs text-slate-500 mt-0.5">
                Define the stages deals move through — names, colours, and win probability.
              </p>
            </div>
          </div>
          <span className="text-xs font-medium text-amber shrink-0">Open →</span>
        </Link>
      )}

      {can('settings', 'edit') && (
        <Link to="/settings/teams"
          className="card p-5 mt-4 flex items-center justify-between flex-wrap gap-3 hover:border-amber transition-colors">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-violet-50 text-violet-600 flex items-center justify-center shrink-0">
              <Users2 className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-sm font-semibold text-ink">Teams</h2>
              <p className="text-xs text-slate-500 mt-0.5">
                Group users into teams so records can be assigned to a team, not just an individual.
              </p>
            </div>
          </div>
          <span className="text-xs font-medium text-amber shrink-0">Open →</span>
        </Link>
      )}

      {can('settings', 'view') && (
        <Link to="/settings/data"
          className="card p-5 mt-4 flex items-center justify-between flex-wrap gap-3 hover:border-amber transition-colors">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-violet-50 text-violet-600 flex items-center justify-center shrink-0">
              <History className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-sm font-semibold text-ink">Data &amp; Audit</h2>
              <p className="text-xs text-slate-500 mt-0.5">
                Bulk import/export any module as CSV, and see who changed what.
              </p>
            </div>
          </div>
          <span className="text-xs font-medium text-amber shrink-0">Open →</span>
        </Link>
      )}

      {can('settings', 'edit') && (
        <Link to="/settings/finance"
          className="card p-5 mt-4 flex items-center justify-between flex-wrap gap-3 hover:border-amber transition-colors">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-violet-50 text-violet-600 flex items-center justify-center shrink-0">
              <Percent className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-sm font-semibold text-ink">Taxes &amp; Currencies</h2>
              <p className="text-xs text-slate-500 mt-0.5">
                Tax rates for quotes and products, and the currencies you trade in.
              </p>
            </div>
          </div>
          <span className="text-xs font-medium text-amber shrink-0">Open →</span>
        </Link>
      )}


      {can('settings', 'edit') && (
        <div className="card p-5 mt-4 flex items-center justify-between flex-wrap gap-3" style={{ background: 'var(--color-warning-soft)', borderColor: '#FDE68A' }}>
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-amber-100 text-amber-700 flex items-center justify-center shrink-0">
              <ShieldCheck className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-sm font-semibold text-ink">Don't see Company Profile or Document Templates below?</h2>
              <p className="text-xs text-slate-500 mt-0.5 max-w-2xl">
                Those two screens ship behind their own permission, added after roles were first set
                up — on some installs that permission never got granted to any role. This checks
                Super Admin and Admin and switches full access on for both, in one click. Safe to
                run any time, including if everything already looks fine.
              </p>
              {repairResult && (
                <p className="text-xs text-good mt-2">{repairResult.message}</p>
              )}
            </div>
          </div>
          <button onClick={repairPermissions} disabled={repairing}
            className="text-sm font-medium px-4 py-2 rounded-lg border border-amber-300 bg-white text-amber-700 hover:bg-amber-50 disabled:opacity-60 shrink-0">
            {repairing ? 'Checking…' : 'Fix access now'}
          </button>
        </div>
      )}

      {can('settings', 'edit') && (
        <Link to="/settings/company"
          className="card p-5 mt-4 flex items-center justify-between flex-wrap gap-3 hover:border-amber transition-colors">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-amber-50 text-amber-600 flex items-center justify-center shrink-0">
              <Building2 className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-sm font-semibold text-ink">Company Profile</h2>
              <p className="text-xs text-slate-500 mt-0.5">
                Letterhead, GSTIN, bank details and signature — printed on every quotation and invoice.
              </p>
            </div>
          </div>
          <span className="text-xs font-medium text-amber shrink-0">Open →</span>
        </Link>
      )}

      {/* The library comes FIRST, and the builder is reached from inside it.
          A customer's first contact with document design should be 75
          finished layouts, not an empty block editor. */}
      {can('document_templates', 'view') && (
        <Link to="/settings/template-library"
          className="card p-5 mt-4 flex items-center justify-between flex-wrap gap-3 hover:border-amber transition-colors">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0"
              style={{ background: 'var(--color-brand-soft)', color: 'var(--color-brand)' }}>
              <LayoutTemplate className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-sm font-semibold text-ink">Template Library</h2>
              <p className="text-xs text-slate-500 mt-0.5">
                75 ready-made quotation, proforma and invoice designs across 18 industries.
                Pick one, add your logo and colours, done.
              </p>
            </div>
          </div>
          <span className="text-xs font-medium text-amber shrink-0">Browse →</span>
        </Link>
      )}

      {can('document_templates', 'view') && (
        <Link to="/settings/templates"
          className="card p-5 mt-4 flex items-center justify-between flex-wrap gap-3 hover:border-amber transition-colors">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-sky-50 text-sky-600 flex items-center justify-center shrink-0">
              <LayoutTemplate className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-sm font-semibold text-ink">Template Builder</h2>
              <p className="text-xs text-slate-500 mt-0.5">
                My Templates, and the block-by-block builder for a completely custom design.
              </p>
            </div>
          </div>
          <span className="text-xs font-medium text-amber shrink-0">Open →</span>
        </Link>
      )}

      {/* Ungated like Email: connecting a calendar is a personal setting, not
          an administrative one — every user manages their own. */}
      <Link to="/settings/calendar"
        className="bg-white border border-line rounded-xl p-5 mt-4 flex items-center justify-between flex-wrap gap-3 hover:border-amber transition-colors">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-sky-50 text-sky-600 flex items-center justify-center shrink-0">
            <CalendarDays className="w-5 h-5" />
          </div>
          <div>
            <h2 className="text-sm font-semibold text-ink">My Integrations</h2>
            <p className="text-xs text-slate-500 mt-0.5">
              Connect your own Google or Outlook calendar, and choose what syncs each way.
            </p>
          </div>
        </div>
        <span className="text-xs font-medium text-amber shrink-0">Open →</span>
      </Link>

      <Link to="/settings/email"
        className="bg-white border border-line rounded-xl p-5 mt-4 flex items-center justify-between flex-wrap gap-3 hover:border-amber transition-colors">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-violet-50 text-violet-600 flex items-center justify-center shrink-0">
            <Mail className="w-5 h-5" />
          </div>
          <div>
            <h2 className="text-sm font-semibold text-ink">Email</h2>
            <p className="text-xs text-slate-500 mt-0.5">
              Configure the mailbox this CRM sends from — organisation-wide or your own address.
            </p>
          </div>
        </div>
        <span className="text-xs font-medium text-amber shrink-0">Open →</span>
      </Link>

      {can('settings', 'edit') && (
        <div className="card p-5 mt-4 flex items-center justify-between flex-wrap gap-3">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-sky-50 text-sky-600 flex items-center justify-center shrink-0">
              <Database className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-sm font-semibold text-ink">Demo Data</h2>
              <p className="text-xs text-slate-500 mt-0.5">
                Fills every module with about a year of realistic sample data — customers, deals,
                quotations, proforma invoices, invoices with part payments, tickets and activity
                history — so reports and dashboards have something real to show.
                {' '}Records you entered yourself are never touched.
              </p>

              {demoStatus?.loaded && !seedResult && (
                <p className="text-xs text-slate-500 mt-2">
                  <span className="font-medium text-ink">Currently loaded:</span>{' '}
                  {DEMO_ORDER.filter((k) => demoStatus.counts[k])
                    .map((k) => `${demoStatus.counts[k]} ${demoLabel(k)}`)
                    .join(' · ')}
                </p>
              )}

              {seedResult && (
                <p className="text-xs text-good mt-2">
                  {seedResult.message}
                  {seedResult.counts && Object.keys(seedResult.counts).length > 0 && (
                    <span className="block text-slate-500 mt-1">
                      {DEMO_ORDER.filter((k) => seedResult.counts[k])
                        .map((k) => `${seedResult.counts[k]} ${demoLabel(k)}`)
                        .join(' · ')}
                    </span>
                  )}
                </p>
              )}
            </div>
          </div>
          <div className="flex flex-col gap-2 shrink-0">
            <button onClick={seedDemoData} disabled={seeding || wiping}
              className="bg-ink text-white text-sm font-medium px-4 py-2 rounded-lg hover:bg-ink-light disabled:opacity-60">
              {seeding ? 'Loading…' : demoStatus?.loaded ? 'Reload Demo Data' : 'Load Demo Data'}
            </button>
            {demoStatus?.loaded && (
              <button onClick={wipeDemoData} disabled={seeding || wiping}
                className="text-sm font-medium px-4 py-2 rounded-lg border border-line text-slate-600 hover:text-warn disabled:opacity-60">
                {wiping ? 'Removing…' : 'Remove Demo Data'}
              </button>
            )}
          </div>
        </div>
      )}

      {can('settings', 'edit') && (
        <div className="card p-5 mt-4">
          <div className="flex items-center gap-3 mb-3">
            <div className="w-10 h-10 rounded-xl bg-emerald-50 text-good flex items-center justify-center shrink-0">
              <ShieldCheck className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-sm font-semibold text-ink">Database Backup &amp; Restore</h2>
              <p className="text-xs text-slate-500 mt-0.5">
                Download or email yourself a copy before any risky change, and restore from one if something goes wrong.
              </p>
            </div>
          </div>

          {/* Storage health. The single most useful thing to show here: on a
              host without a persistent disk, the database is wiped on every
              restart and no amount of backing up changes that. */}
          {storage && (
            <div className={`text-xs rounded-lg px-3 py-2.5 mb-3 flex items-start gap-2 ${
              storage.persistent ? 'bg-emerald-50 text-good' : 'bg-amber-50 text-warn'
            }`}>
              {storage.persistent
                ? <Check className="w-4 h-4 shrink-0 mt-px" />
                : <AlertTriangle className="w-4 h-4 shrink-0 mt-px" />}
              <span>
                {storage.persistent ? (
                  <>
                    <strong>Storage is persistent.</strong> Data is stored outside the application
                    folder ({storage.data_dir}), so it survives restarts and redeploys.
                    Database size {storage.size_mb} MB.
                  </>
                ) : (
                  <>
                    <strong>Storage is not persistent.</strong> The database is inside the application
                    folder, so a redeploy or restart will wipe it. Set the <code>DATA_DIR</code>{' '}
                    environment variable to a mounted disk on your host. Until then, download a backup
                    before every deploy. Database size {storage.size_mb} MB.
                  </>
                )}
              </span>
            </div>
          )}

          {storage?.restore_pending && (
            <p className="text-xs bg-blue-50 text-blue-700 rounded-lg px-3 py-2.5 mb-3">
              A restore is staged and will be applied the next time the backend restarts.
            </p>
          )}

          {backupResult && (
            <p className={`text-xs mb-3 ${backupResult.ok ? 'text-good' : 'text-warn'}`}>{backupResult.message}</p>
          )}
          <div className="flex gap-2 flex-wrap">
            <button onClick={downloadBackup} disabled={downloading}
              className="border border-line text-sm font-medium px-4 py-2 rounded-lg hover:bg-canvas disabled:opacity-60">
              {downloading ? 'Downloading…' : 'Download Backup Now'}
            </button>
            <button onClick={emailBackup} disabled={emailingBackup}
              className="border border-line text-sm font-medium px-4 py-2 rounded-lg hover:bg-canvas disabled:opacity-60">
              {emailingBackup ? 'Sending…' : 'Email Backup to Myself'}
            </button>
            <label className={`border border-line text-sm font-medium px-4 py-2 rounded-lg hover:bg-canvas cursor-pointer ${restoring ? 'opacity-60 pointer-events-none' : ''}`}>
              {restoring ? 'Checking…' : 'Restore from Backup…'}
              <input type="file" accept=".db" className="hidden" onChange={restoreBackup} disabled={restoring} />
            </label>
          </div>
        </div>
      )}

      <h2 className="text-sm font-semibold text-ink mt-8 mb-3">Receipt Templates</h2>
      <p className="text-xs text-slate-400 mb-4">
        Configure the two institute templates used on the Payments page. Fields still showing placeholders like
        "[Institute A Name — configure in Settings]" haven't been filled in yet.
      </p>
      <div className="grid md:grid-cols-2 gap-6">
        {templates.map((t) => <ReceiptTemplateCard key={t.id} template={t} onSaved={load} />)}
      </div>

      <h2 className="text-sm font-semibold text-ink mt-8 mb-3">Master Option Lists</h2>
      <div className="grid md:grid-cols-3 gap-6">
        {LIST_TYPES.map((l) => <OptionList key={l.key} listType={l.key} label={l.label} />)}
      </div>

      {can('users', 'view') && (
        <>
          <h2 className="text-sm font-semibold text-ink mt-8 mb-3 flex items-center gap-1.5">
            <Sparkles className="w-4 h-4 text-amber" /> AI Assistant Activity Log
          </h2>
          <p className="text-xs text-slate-400 mb-3">Every query and action the AI assistant has run, per user, for audit purposes.</p>
          <AiAuditLog />
        </>
      )}
    </div>
  );
}
