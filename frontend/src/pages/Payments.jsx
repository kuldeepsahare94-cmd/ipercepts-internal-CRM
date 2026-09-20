import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Download, X, Wallet, Plus } from 'lucide-react';
import Avatar from '../components/Avatar';
import { api } from '../api';
import { usePermissions } from '../context/usePermissions';
import StatusBadge from '../components/StatusBadge';
import { downloadCSV } from '../utils/csv';
import { PageHeader } from '../components/ui';

const STATUSES = ['Pending', 'Partial', 'Paid', 'Failed'];
const MODES = ['Cash', 'UPI', 'Bank Transfer', 'Card', 'Cheque', 'Other'];
const inr = (n) => `₹${Number(n || 0).toLocaleString('en-IN')}`;

function MarkPaidModal({ payment, onClose, onSaved }) {
  const [form, setForm] = useState({ status: 'Paid', payment_mode: 'UPI', transaction_number: '', amount: payment.amount, remarks: '' });
  const submit = async (e) => {
    e.preventDefault();
    await api.updatePayment(payment.id, form);
    onSaved();
  };
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <form onSubmit={submit} className="bg-white rounded-xl p-5 w-full max-w-sm relative">
        <button type="button" onClick={onClose} className="absolute top-4 right-4 text-slate-400 hover:text-ink"><X className="w-4 h-4" /></button>
        <h2 className="text-sm font-semibold text-ink mb-4">Update payment · {payment.payment_number}</h2>
        <label className="text-xs font-medium text-slate-500 block mb-1">Amount</label>
        <input type="number" required className="border border-line rounded-lg px-3 py-2 text-sm w-full mb-3"
          value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} />
        <label className="text-xs font-medium text-slate-500 block mb-1">Status</label>
        <select className="border border-line rounded-lg px-3 py-2 text-sm w-full mb-3" value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}>
          {STATUSES.map((s) => <option key={s}>{s}</option>)}
        </select>
        <label className="text-xs font-medium text-slate-500 block mb-1">Payment mode</label>
        <select className="border border-line rounded-lg px-3 py-2 text-sm w-full mb-3" value={form.payment_mode} onChange={(e) => setForm({ ...form, payment_mode: e.target.value })}>
          {MODES.map((m) => <option key={m}>{m}</option>)}
        </select>
        <label className="text-xs font-medium text-slate-500 block mb-1">Transaction number</label>
        <input className="border border-line rounded-lg px-3 py-2 text-sm w-full mb-3"
          value={form.transaction_number} onChange={(e) => setForm({ ...form, transaction_number: e.target.value })} />
        <label className="text-xs font-medium text-slate-500 block mb-1">Remarks</label>
        <input className="border border-line rounded-lg px-3 py-2 text-sm w-full mb-4"
          value={form.remarks} onChange={(e) => setForm({ ...form, remarks: e.target.value })} />
        <button type="submit" className="w-full bg-amber text-white text-sm font-medium py-2 rounded-lg hover:opacity-90">Save</button>
      </form>
    </div>
  );
}

function NewPaymentModal({ onClose, onSaved }) {
  const [accounts, setAccounts] = useState([]);
  const [form, setForm] = useState({ account_id: '', payer_name: '', amount: '', description: '' });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.universalList({ api_name: 'accounts', table_name: 'accounts' }).then(setAccounts).catch(() => {});
  }, []);

  const submit = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      await api.createPayment({
        account_id: form.account_id || null,
        payer_name: form.account_id ? null : form.payer_name,
        amount: Number(form.amount) || 0,
        description: form.description,
      });
      onSaved();
    } catch (err) {
      alert('Could not create payment: ' + err.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <form onSubmit={submit} className="bg-white rounded-xl p-5 w-full max-w-sm relative">
        <button type="button" onClick={onClose} className="absolute top-4 right-4 text-slate-400 hover:text-ink"><X className="w-4 h-4" /></button>
        <h2 className="text-sm font-semibold text-ink mb-4">New payment</h2>

        <label className="text-xs font-medium text-slate-500 block mb-1">Account (optional)</label>
        <select className="border border-line rounded-lg px-3 py-2 text-sm w-full mb-3" value={form.account_id}
          onChange={(e) => setForm({ ...form, account_id: e.target.value })}>
          <option value="">— No account, use payer name below —</option>
          {accounts.map((a) => <option key={a.id} value={a.id}>{a.account_name}</option>)}
        </select>

        {!form.account_id && (
          <>
            <label className="text-xs font-medium text-slate-500 block mb-1">Payer name</label>
            <input className="border border-line rounded-lg px-3 py-2 text-sm w-full mb-3"
              value={form.payer_name} onChange={(e) => setForm({ ...form, payer_name: e.target.value })} />
          </>
        )}

        <label className="text-xs font-medium text-slate-500 block mb-1">Amount</label>
        <input type="number" required className="border border-line rounded-lg px-3 py-2 text-sm w-full mb-3"
          value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} />

        <label className="text-xs font-medium text-slate-500 block mb-1">Description</label>
        <input className="border border-line rounded-lg px-3 py-2 text-sm w-full mb-4"
          value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="e.g. Implementation fee" />

        <button type="submit" disabled={saving} className="w-full bg-amber text-white text-sm font-medium py-2 rounded-lg hover:opacity-90 disabled:opacity-50">
          {saving ? 'Saving…' : 'Create payment'}
        </button>
      </form>
    </div>
  );
}

export default function Payments() {
  const [downloadError, setDownloadError] = useState('');
  // Downloads now go through fetch (they need the auth header), so a
  // failure is a real rejected promise — surface it instead of letting
  // the click appear to do nothing.
  const grab = async (fn) => {
    setDownloadError('');
    try { await fn(); } catch (e) { setDownloadError(e.message); }
  };

  const { id } = useParams();
  const navigate = useNavigate();
  const can = usePermissions();
  const [list, setList] = useState([]);
  const [statusFilter, setStatusFilter] = useState('');
  const [editing, setEditing] = useState(null);
  const [creating, setCreating] = useState(false);

  const load = () => api.listPayments({ status: statusFilter }).then(setList);
  useEffect(() => { load(); }, [statusFilter]);

  // Deep-linked (e.g. from a Dashboard link) — open the mark-paid modal directly
  useEffect(() => {
    if (id) {
      api.getPayment(id).then((p) => setEditing(p)).catch(() => {});
    }
  }, [id]);

  const closeModal = () => { setEditing(null); if (id) navigate('/payments'); };
  const saved = () => { closeModal(); load(); };
  const created = () => { setCreating(false); load(); };

  const reference = (p) => p.opportunity_name || p.quote_number || p.course_name || '—';

  return (
    <div className="max-w-[1600px] mx-auto">
      <PageHeader
        title="Payments"
        subtitle="Linked to an Account, Opportunity, or Quotation. Mark paid to unlock receipts."
        icon={Wallet}
        accent="payments"
      >
        <div className="flex gap-2">
          {can('payments', 'export') && (
            <button onClick={() => downloadCSV('payments.csv', list)} className="btn btn-secondary">Export CSV</button>
          )}
          {can('payments', 'create') && (
            <button onClick={() => setCreating(true)} className="btn btn-primary inline-flex items-center gap-1.5">
              <Plus className="w-4 h-4" /> New payment
            </button>
          )}
        </div>
      </PageHeader>

      {downloadError && (
        <div className="text-sm rounded-lg px-3 py-2 mt-4"
          style={{ background: 'var(--color-danger-soft)', color: 'var(--color-danger)' }}>{downloadError}</div>
      )}

      <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className="border border-line rounded-lg px-3 py-2 text-sm mt-5">
        <option value="">All statuses</option>
        {STATUSES.map((s) => <option key={s}>{s}</option>)}
      </select>

      <div className="card mt-6 overflow-hidden overflow-x-auto shadow-sm">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left bg-[var(--color-canvas)] border-b border-line">
              <th className="py-3 px-4 font-medium">Payment #</th>
              <th className="py-3 px-4 font-medium">Payer</th>
              <th className="py-3 px-4 font-medium">Reference</th>
              <th className="py-3 px-4 font-medium">Installment</th>
              <th className="py-3 px-4 font-medium text-right">Amount</th>
              <th className="py-3 px-4 font-medium">Status</th>
              <th className="py-3 px-4 font-medium"></th>
            </tr>
          </thead>
          <tbody>
            {list.map((p) => (
              <tr key={p.id} className="border-b border-line/60 hover:bg-[var(--color-canvas)] transition-colors">
                <td className="py-3 px-4 text-ink font-medium">{p.payment_number}</td>
                <td className="py-3 px-4 text-slate-600">
                  <div className="flex items-center gap-3">
                    <Avatar name={p.payer_display_name} color="amber" />
                    {p.payer_display_name || '—'}
                  </div>
                </td>
                <td className="py-3 px-4 text-slate-500">{reference(p)}</td>
                <td className="py-3 px-4 text-slate-500">#{p.installment_number}</td>
                <td className="py-3 px-4 text-right text-slate-700">{inr(p.amount)}</td>
                <td className="py-3 px-4"><StatusBadge status={p.status} /></td>
                <td className="py-3 px-4 text-right whitespace-nowrap">
                  {can('payments', 'edit') && p.status !== 'Paid' && (
                    <button onClick={() => setEditing(p)} className="text-xs text-amber hover:underline mr-3">Mark paid</button>
                  )}
                  {p.status === 'Paid' && (
                    <>
                      <button onClick={() => grab(() => api.downloadReceipt(p.id, 'A'))}
                        className="text-xs text-slate-500 hover:text-ink inline-flex items-center gap-1 mr-2">
                        <Download className="w-3 h-3" /> Receipt A
                      </button>
                      <button onClick={() => grab(() => api.downloadReceipt(p.id, 'B'))}
                        className="text-xs text-slate-500 hover:text-ink inline-flex items-center gap-1">
                        <Download className="w-3 h-3" /> Receipt B
                      </button>
                    </>
                  )}
                </td>
              </tr>
            ))}
            {list.length === 0 && (
              <tr><td colSpan={7} className="py-8 text-center text-slate-400">No payments yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {editing && <MarkPaidModal payment={editing} onClose={closeModal} onSaved={saved} />}
      {creating && <NewPaymentModal onClose={() => setCreating(false)} onSaved={created} />}
    </div>
  );
}
