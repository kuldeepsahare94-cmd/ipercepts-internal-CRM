import { useEffect, useState } from 'react';
import { Mail, CheckCircle2, AlertTriangle, Send, Info } from 'lucide-react';
import { api } from '../api';
import { usePermissions } from '../context/usePermissions';
import { PageHeader, Badge, friendlyError } from '../components/ui';
import { History } from 'lucide-react';

// Presets for the mail services most people actually use, so nobody has to
// go hunting for port numbers.
const PRESETS = {
  gmail:     { label: 'Gmail / Google Workspace', smtp_host: 'smtp.gmail.com', smtp_port: 587, imap_host: 'imap.gmail.com', imap_port: 993 },
  outlook:   { label: 'Outlook / Microsoft 365',  smtp_host: 'smtp.office365.com', smtp_port: 587, imap_host: 'outlook.office365.com', imap_port: 993 },
  zoho:      { label: 'Zoho Mail',                smtp_host: 'smtp.zoho.in', smtp_port: 587, imap_host: 'imap.zoho.in', imap_port: 993 },
  custom:    { label: 'Other / custom server',    smtp_host: '', smtp_port: 587, imap_host: '', imap_port: 993 },
};

const blank = {
  from_name: '', from_email: '', smtp_host: '', smtp_port: 587,
  smtp_user: '', smtp_pass: '', use_tls: true,
};

function AccountForm({ scope, initial, onSaved, canEdit }) {
  const [form, setForm] = useState({ ...blank, ...(initial || {}) });
  const [preset, setPreset] = useState('custom');
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [msg, setMsg] = useState(null);

  useEffect(() => { setForm({ ...blank, ...(initial || {}), smtp_pass: '' }); }, [initial]);

  const applyPreset = (key) => {
    setPreset(key);
    const p = PRESETS[key];
    setForm((f) => ({ ...f, smtp_host: p.smtp_host, smtp_port: p.smtp_port }));
  };

  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const save = async (e) => {
    e.preventDefault();
    setSaving(true); setMsg(null);
    try {
      const saved = scope === 'org' ? await api.saveOrgEmail(form) : await api.saveMyEmail(form);
      setMsg({ ok: true, text: 'Saved. Send a test to confirm it works.' });
      onSaved?.(saved);
    } catch (err) {
      setMsg({ ok: false, text: friendlyError(err, 'Could not save these settings.').message });
    } finally { setSaving(false); }
  };

  const test = async () => {
    setTesting(true); setMsg(null);
    try {
      const r = await api.testEmail(scope);
      setMsg({ ok: true, text: `Test email sent to ${r.sent_to}. Check that inbox. (id ${r.request_id})` });
      onSaved?.();
    } catch (err) {
      // The request_id ties this exact failure to a row in the diagnostic
      // log below, and the raw error is the actual cause — not a guess at
      // one. Both are worth more than a translated sentence when something
      // needs debugging rather than just explaining.
      setMsg({
        ok: false,
        text: friendlyError(err, 'The test failed.').message,
        requestId: err.requestId,
        raw: err.rawError,
      });
    } finally { setTesting(false); }
  };

  const field = (label, key, props = {}) => (
    <div>
      <label className="t-meta font-medium block mb-1">{label}{props.required && ' *'}</label>
      <input className="input" value={form[key] ?? ''} disabled={!canEdit}
        onChange={(e) => set(key, e.target.value)} {...props} />
    </div>
  );

  return (
    <form onSubmit={save} className="space-y-4">
      <div>
        <label className="t-meta font-medium block mb-1">Mail provider</label>
        <select className="input" value={preset} disabled={!canEdit} onChange={(e) => applyPreset(e.target.value)}>
          {Object.entries(PRESETS).map(([k, p]) => <option key={k} value={k}>{p.label}</option>)}
        </select>
      </div>

      <div className="grid sm:grid-cols-2 gap-3">
        {field('Display name', 'from_name', { placeholder: 'e.g. Kuldeep Sahare' })}
        {field('From address', 'from_email', { required: true, type: 'email', placeholder: 'you@company.com' })}
        {field('SMTP host', 'smtp_host', { required: true, placeholder: 'smtp.gmail.com' })}
        <div>
          <label className="t-meta font-medium block mb-1">SMTP port *</label>
          <input className="input" type="number" value={form.smtp_port ?? 587} disabled={!canEdit}
            onChange={(e) => set('smtp_port', Number(e.target.value))} />
        </div>
        {field('SMTP username', 'smtp_user', { required: true, placeholder: 'usually the same as the from address' })}
        <div>
          <label className="t-meta font-medium block mb-1">
            SMTP password {initial?.has_password ? '(leave blank to keep current)' : '*'}
          </label>
          <input className="input" type="password" value={form.smtp_pass ?? ''} disabled={!canEdit}
            onChange={(e) => set('smtp_pass', e.target.value)}
            placeholder={initial?.has_password ? '••••••••' : ''} autoComplete="new-password" />
        </div>
      </div>

      {(preset === 'gmail' || /gmail|google/i.test(form.smtp_host)) && (
        <div className="rounded-lg px-3 py-2.5 flex gap-2" style={{ background: 'var(--color-warning-soft)' }}>
          <Info className="w-4 h-4 shrink-0 mt-0.5" style={{ color: 'var(--color-warning)' }} />
          <div className="text-xs" style={{ color: 'var(--color-warning)' }}>
            <strong>Gmail needs an App Password</strong>, not your normal password. Create one at
            Google Account → Security → 2-Step Verification → App Passwords. A normal password
            will always fail — that's Google's policy, not something this CRM can work around.
          </div>
        </div>
      )}

      {initial?.last_tested_at && (
        <div className="flex items-center gap-2 t-meta">
          {initial.last_test_ok
            ? <><CheckCircle2 className="w-4 h-4" style={{ color: 'var(--color-success)' }} /> Last test passed on {initial.last_tested_at}</>
            : <><AlertTriangle className="w-4 h-4" style={{ color: 'var(--color-danger)' }} /> Last test failed: {initial.last_test_error}</>}
        </div>
      )}

      {msg && (
        <div className="text-sm rounded-lg px-3 py-2"
          style={{ background: msg.ok ? 'var(--color-success-soft)' : 'var(--color-danger-soft)',
                   color: msg.ok ? 'var(--color-success)' : 'var(--color-danger)' }}>
          {msg.text}
          {msg.requestId && <div className="text-xs opacity-70 mt-1">Diagnostic id: {msg.requestId}</div>}
          {msg.raw && (
            <details className="mt-1.5">
              <summary className="text-xs cursor-pointer opacity-80">Technical detail (for debugging)</summary>
              <pre className="text-xs mt-1 whitespace-pre-wrap opacity-80">{msg.raw.code ? `[${msg.raw.code}] ` : ''}{msg.raw.message}</pre>
            </details>
          )}
        </div>
      )}

      {canEdit && (
        <div className="flex gap-2 pt-2 border-t border-line">
          <button type="submit" disabled={saving} className="btn btn-primary disabled:opacity-50">
            {saving ? 'Saving…' : 'Save'}
          </button>
          <button type="button" onClick={test} disabled={testing || !initial} className="btn btn-secondary disabled:opacity-50">
            <Send className="w-4 h-4" /> {testing ? 'Sending…' : 'Send test email'}
          </button>
        </div>
      )}
    </form>
  );
}


// The actual answer to "did the fix work" — every send attempt, the raw
// error behind each failure, and how long it took, without needing hosting-
// dashboard access.
function DiagnosticsPanel() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);

  const load = () => api.emailDiagnostics({ limit: 30 }).then(setRows).catch(() => setRows([])).finally(() => setLoading(false));
  useEffect(() => { load(); }, []);

  if (loading) return null;

  return (
    <div className="card p-5 mt-5">
      <div className="flex items-center justify-between mb-1">
        <h2 className="t-section flex items-center gap-1.5"><History className="w-4 h-4 text-amber" /> Recent send attempts</h2>
        <button onClick={load} className="text-xs text-[var(--color-brand)]">Refresh</button>
      </div>
      <p className="t-meta mb-3">Every test, campaign send and reply attempt, with the real error behind any failure.</p>

      {rows.length === 0 ? (
        <p className="t-meta">Nothing logged yet — run a test send above.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left border-b border-line">
                <th className="py-1.5 pr-3 t-meta font-semibold">When</th>
                <th className="py-1.5 pr-3 t-meta font-semibold">Kind</th>
                <th className="py-1.5 pr-3 t-meta font-semibold">To</th>
                <th className="py-1.5 pr-3 t-meta font-semibold">Result</th>
                <th className="py-1.5 pr-3 t-meta font-semibold">Time</th>
                <th className="py-1.5 t-meta font-semibold">Raw error</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-b border-line/60 align-top">
                  <td className="py-1.5 pr-3 whitespace-nowrap">{r.created_at}</td>
                  <td className="py-1.5 pr-3">{r.kind.replace('_', ' ')}</td>
                  <td className="py-1.5 pr-3">{r.to_address || '—'}</td>
                  <td className="py-1.5 pr-3">
                    <Badge tone={r.outcome === 'success' ? 'success' : 'danger'} size="xs">{r.outcome}</Badge>
                  </td>
                  <td className="py-1.5 pr-3 whitespace-nowrap">{r.duration_ms ? `${(r.duration_ms / 1000).toFixed(1)}s` : '—'}</td>
                  <td className="py-1.5 max-w-xs">
                    {r.error_message ? (
                      <span className="text-[var(--color-danger)]">{r.error_code ? `[${r.error_code}] ` : ''}{r.error_message}</span>
                    ) : '—'}
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

export default function SettingsEmail() {
  const can = usePermissions();
  const [org, setOrg] = useState(null);
  const [envFallback, setEnvFallback] = useState(null);
  const [mine, setMine] = useState(null);
  const [tab, setTab] = useState('mine');
  const [loading, setLoading] = useState(true);

  const isAdmin = can('email_settings', 'edit');

  const load = () => Promise.all([
    isAdmin ? api.getOrgEmail().catch(() => null) : Promise.resolve(null),
    api.getMyEmail().catch(() => null),
  ]).then(([o, m]) => {
    if (o) { setOrg(o.account); setEnvFallback(o.env_fallback); }
    setMine(m);
  }).finally(() => setLoading(false));

  useEffect(() => { load(); }, []);

  if (loading) return <div className="py-8 t-meta">Loading…</div>;

  return (
    <div className="max-w-[1600px] mx-auto">
      <PageHeader title="Email" icon={Mail} accent="emails"
        subtitle="Configure the mailbox this CRM sends from — for the whole organisation, or per user." />

      <div className="card p-4 mb-5">
        <h2 className="t-section mb-2">How sending works</h2>
        <ol className="text-sm text-[var(--color-muted)] space-y-1 list-decimal list-inside">
          <li><strong className="text-ink">Your own address</strong> — used when you've set one up below.</li>
          <li><strong className="text-ink">The organisation address</strong> — used when you haven't.</li>
          <li><strong className="text-ink">Server environment variables</strong> — the original fallback, still honoured.</li>
        </ol>
        {envFallback?.configured && (
          <p className="t-meta mt-2">
            Environment fallback is currently active: {envFallback.from} via {envFallback.host}
          </p>
        )}
      </div>

      {isAdmin && (
        <div className="flex gap-2 mb-4">
          <button onClick={() => setTab('mine')} className={`btn ${tab === 'mine' ? 'btn-primary' : 'btn-secondary'}`}>My email</button>
          <button onClick={() => setTab('org')} className={`btn ${tab === 'org' ? 'btn-primary' : 'btn-secondary'}`}>Organisation email</button>
        </div>
      )}

      <div className="card p-5">
        <div className="flex items-center gap-2 mb-4">
          <Mail className="w-4 h-4 text-[var(--color-brand)]" />
          <h2 className="t-section">{tab === 'org' ? 'Organisation mailbox' : 'My sending address'}</h2>
          {tab === 'mine' && mine && <Badge tone="success" size="xs">Configured</Badge>}
          {tab === 'org' && org && <Badge tone="success" size="xs">Configured</Badge>}
        </div>
        <p className="t-meta mb-4">
          {tab === 'org'
            ? 'Used for system mail and for any user who has not set up their own address.'
            : 'Mail you send — quotations, notifications — will go out from this address instead of the shared one.'}
        </p>
        <AccountForm scope={tab} initial={tab === 'org' ? org : mine}
          canEdit={tab === 'org' ? isAdmin : true} onSaved={load} />
      </div>

      <DiagnosticsPanel />

      <div className="card p-4 mt-5" style={{ borderColor: 'var(--color-warning)' }}>
        <h2 className="t-section flex items-center gap-2 mb-1">
          <AlertTriangle className="w-4 h-4" style={{ color: 'var(--color-warning)' }} /> Inbound email is not active yet
        </h2>
        <p className="text-sm text-[var(--color-muted)]">
          This screen configures <strong className="text-ink">sending only</strong>. Receiving replies
          back into the CRM needs a mail-fetching service (IMAP polling or a provider webhook) that
          isn't built yet — so replies from customers will land in your normal mailbox, not here.
          The IMAP fields are stored ready for it, but nothing reads them today.
        </p>
      </div>
    </div>
  );
}
