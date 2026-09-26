import { useEffect, useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import { api } from '../api';
import { PageHeader } from '../components/ui';

// Modules that actually exist in this CRM. The education-era entries
// (students/courses/admissions/companies/placements) were removed, so
// listing them here only produced permission rows nothing could use.
// This list is hand-maintained, so a new permission surface has to be added
// here too — otherwise the permission exists in the database but there is no
// row in this matrix to switch it on or off, which is how `chat` was
// initially missed, and how `proforma_invoices` / `invoices` /
// `document_templates` were missed when the documents feature shipped: the
// backend granted the permission rows correctly, but nothing in this screen
// could display or edit them, so a role that genuinely needed adjusting here
// had no way to.
const MODULES = ['leads', 'accounts', 'contacts', 'opportunities', 'quotations', 'proforma_invoices',
  'invoices', 'document_templates', 'products', 'subscriptions', 'tickets', 'calls', 'meetings',
  'tasks', 'notes', 'emails', 'payments', 'documents', 'teams', 'workflows', 'reports', 'users',
  'chat', 'calendar', 'settings', 'support', 'support_settings', 'kb_articles', 'major_incidents', 'problems',
  'service_catalog', 'assets'];
const MODULE_LABEL = {
  proforma_invoices: 'Proforma Invoices', document_templates: 'Document Templates',
  support: 'Support Desk', support_settings: 'Support Settings', kb_articles: 'Knowledge Base',
  major_incidents: 'Major Incidents', service_catalog: 'Service Catalog',
};
const ACTIONS = ['view', 'create', 'edit', 'delete', 'export'];
const ACTION_KEYS = { view: 'can_view', create: 'can_create', edit: 'can_edit', delete: 'can_delete', export: 'can_export' };

function titleCase(s) { return s.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()); }

export default function Roles() {
  const [roles, setRoles] = useState([]);
  const [activeRoleId, setActiveRoleId] = useState(null);
  const [matrix, setMatrix] = useState({});
  const [newRoleName, setNewRoleName] = useState('');
  const [dirty, setDirty] = useState(false);

  const load = () => api.listRoles().then((rs) => {
    setRoles(rs);
    if (!activeRoleId && rs.length) setActiveRoleId(rs[0].id);
  });
  useEffect(() => { load(); }, []);

  useEffect(() => {
    const role = roles.find((r) => r.id === activeRoleId);
    if (!role) return;
    const m = {};
    for (const mod of MODULES) {
      const p = role.permissions.find((x) => x.module === mod) || {};
      m[mod] = { view: !!p.can_view, create: !!p.can_create, edit: !!p.can_edit, delete: !!p.can_delete, export: !!p.can_export };
    }
    setMatrix(m);
    setDirty(false);
  }, [activeRoleId, roles]);

  const toggle = (mod, action) => {
    setMatrix((m) => ({ ...m, [mod]: { ...m[mod], [action]: !m[mod][action] } }));
    setDirty(true);
  };

  const save = async () => {
    const permissions = MODULES.map((mod) => ({
      module: mod,
      can_view: matrix[mod].view, can_create: matrix[mod].create, can_edit: matrix[mod].edit,
      can_delete: matrix[mod].delete, can_export: matrix[mod].export,
    }));
    await api.updateRolePermissions(activeRoleId, permissions);
    setDirty(false);
    load();
  };

  const addRole = async (e) => {
    e.preventDefault();
    if (!newRoleName.trim()) return;
    const role = await api.createRole({ name: newRoleName.trim() });
    setNewRoleName('');
    await load();
    setActiveRoleId(role.id);
  };

  const activeRole = roles.find((r) => r.id === activeRoleId);

  return (
    <div className="max-w-[1600px] mx-auto">
      <PageHeader
        title="Roles & Permissions"
        subtitle="Module-wise View / Create / Edit / Delete / Export access per role."
        icon={ShieldCheck}
        accent="roles"
      />

      <div className="flex gap-2 mt-6 flex-wrap items-center">
        {roles.map((r) => (
          <button key={r.id} onClick={() => setActiveRoleId(r.id)}
            className={`text-xs font-medium px-3 py-1.5 rounded-full border ${
              activeRoleId === r.id ? 'bg-ink text-white border-ink' : 'border-line text-slate-500 hover:border-ink/40'
            }`}>
            {r.name}
          </button>
        ))}
        <form onSubmit={addRole} className="flex gap-1 ml-2">
          <input value={newRoleName} onChange={(e) => setNewRoleName(e.target.value)} placeholder="New role name…"
            className="border border-line rounded-lg px-2 py-1 text-xs w-32" />
          <button type="submit" className="text-xs border border-line rounded-lg px-2 py-1 hover:bg-white">+ Add</button>
        </form>
      </div>

      {activeRole && (
        <div className="card mt-6 overflow-hidden overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left bg-[var(--color-canvas)] border-b border-line">
                <th className="py-3 px-4 font-medium">Module</th>
                {ACTIONS.map((a) => <th key={a} className="py-3 px-4 font-medium text-center capitalize">{a}</th>)}
              </tr>
            </thead>
            <tbody>
              {MODULES.map((mod) => (
                <tr key={mod} className="border-b border-line/60">
                  <td className="py-2.5 px-4 text-ink font-medium">{MODULE_LABEL[mod] || titleCase(mod)}</td>
                  {ACTIONS.map((a) => (
                    <td key={a} className="py-2.5 px-4 text-center">
                      <input type="checkbox" checked={!!matrix[mod]?.[a]} onChange={() => toggle(mod, a)}
                        disabled={activeRole.is_system && activeRole.name === 'Super Admin'}
                        className="w-4 h-4 accent-amber" />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          {activeRole.is_system && activeRole.name === 'Super Admin' && (
            <p className="text-xs text-slate-400 px-4 py-3 border-t border-line">Super Admin always has full access and can't be restricted.</p>
          )}
        </div>
      )}

      {dirty && (
        <button onClick={save} className="mt-4 bg-amber text-white text-sm font-medium px-4 py-2 rounded-lg hover:opacity-90">
          Save permission changes
        </button>
      )}
    </div>
  );
}
