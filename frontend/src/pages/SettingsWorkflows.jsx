import { useEffect, useState } from 'react';
import { Zap, Plus, Trash2, Pencil, X, Play } from 'lucide-react';
import { api } from '../api';
import { usePermissions } from '../context/usePermissions';
import { PageHeader } from '../components/ui';

const TRIGGER_TYPES = [
  { value: 'record_created', label: 'Record is created' },
  { value: 'record_updated', label: 'Record is updated (any field)' },
  { value: 'field_changed', label: 'A specific field changes' },
];
const OPERATORS = [
  { value: 'equals', label: 'equals' },
  { value: 'not_equals', label: 'does not equal' },
  { value: 'contains', label: 'contains' },
  { value: 'greater_than', label: 'is greater than' },
  { value: 'less_than', label: 'is less than' },
  { value: 'is_empty', label: 'is empty' },
  { value: 'is_not_empty', label: 'is not empty' },
];
const ACTION_TYPES = [
  { value: 'update_field', label: 'Update a field' },
  { value: 'create_record', label: 'Create a record' },
  { value: 'create_notification', label: 'Send a notification' },
  { value: 'webhook', label: 'Call a webhook' },
];

const inputClass = 'border border-line rounded-lg px-3 py-1.5 text-sm';

function emptyWorkflow() {
  return { name: '', module_id: '', trigger_type: 'record_created', trigger_field: '', conditions: [], actions: [], active: true };
}

function ConditionRow({ cond, fields, onChange, onRemove }) {
  const needsValue = !['is_empty', 'is_not_empty'].includes(cond.operator);
  return (
    <div className="flex items-center gap-2 flex-wrap bg-canvas rounded-lg p-2">
      <select value={cond.field} onChange={(e) => onChange({ ...cond, field: e.target.value })} className={inputClass}>
        <option value="">Field…</option>
        {fields.map((f) => <option key={f.api_name} value={f.api_name}>{f.label}</option>)}
      </select>
      <select value={cond.operator} onChange={(e) => onChange({ ...cond, operator: e.target.value })} className={inputClass}>
        {OPERATORS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      {needsValue && <input value={cond.value ?? ''} onChange={(e) => onChange({ ...cond, value: e.target.value })} placeholder="Value" className={inputClass + ' flex-1 min-w-[100px]'} />}
      <button onClick={onRemove} className="text-slate-400 hover:text-warn"><X className="w-4 h-4" /></button>
    </div>
  );
}

function ActionRow({ action, fields, modules, targetFields, onLoadTargetFields, onChange, onRemove }) {
  const cfg = action.config || {};
  const setCfg = (patch) => onChange({ ...action, config: { ...cfg, ...patch } });

  return (
    <div className="bg-canvas rounded-lg p-3 space-y-2">
      <div className="flex items-center gap-2">
        <select value={action.type} onChange={(e) => onChange({ type: e.target.value, config: {} })} className={inputClass + ' flex-1'}>
          {ACTION_TYPES.map((a) => <option key={a.value} value={a.value}>{a.label}</option>)}
        </select>
        <button onClick={onRemove} className="text-slate-400 hover:text-warn shrink-0"><Trash2 className="w-4 h-4" /></button>
      </div>

      {action.type === 'update_field' && (
        <div className="flex gap-2 flex-wrap">
          <select value={cfg.field || ''} onChange={(e) => setCfg({ field: e.target.value })} className={inputClass}>
            <option value="">Field to update…</option>
            {fields.map((f) => <option key={f.api_name} value={f.api_name}>{f.label}</option>)}
          </select>
          <input value={cfg.value ?? ''} onChange={(e) => setCfg({ value: e.target.value })} placeholder="New value" className={inputClass + ' flex-1 min-w-[100px]'} />
        </div>
      )}

      {action.type === 'create_record' && (
        <div className="space-y-2">
          <select value={cfg.module || ''} onChange={(e) => { setCfg({ module: e.target.value, fields: {} }); onLoadTargetFields(e.target.value); }} className={inputClass}>
            <option value="">Which module…</option>
            {modules.map((m) => <option key={m.api_name} value={m.api_name}>{m.plural_label}</option>)}
          </select>
          {cfg.module && (targetFields[cfg.module] || []).filter((f) => f.show_in_create).map((f) => (
            <div key={f.api_name} className="flex items-center gap-2">
              <span className="text-xs text-slate-500 w-28 shrink-0 truncate">{f.label}</span>
              <input value={cfg.fields?.[f.api_name] ?? ''} onChange={(e) => setCfg({ fields: { ...cfg.fields, [f.api_name]: e.target.value } })}
                placeholder={`e.g. {{${fields[0]?.api_name || 'field'}}}`} className={inputClass + ' flex-1'} />
            </div>
          ))}
          <p className="text-[11px] text-slate-400">Linked automatically back to the record that triggered this workflow, where the target module supports it. Use {'{{field_name}}'} to pull in a value from the triggering record.</p>
        </div>
      )}

      {action.type === 'create_notification' && (
        <div className="space-y-2">
          <input value={cfg.title ?? ''} onChange={(e) => setCfg({ title: e.target.value })} placeholder="Notification title" className={inputClass + ' w-full'} />
          <input value={cfg.message ?? ''} onChange={(e) => setCfg({ message: e.target.value })} placeholder={`Message — use {{${fields[0]?.api_name || 'field'}}} to insert a value`} className={inputClass + ' w-full'} />
        </div>
      )}

      {action.type === 'webhook' && (
        <input value={cfg.url ?? ''} onChange={(e) => setCfg({ url: e.target.value })} placeholder="https://…" className={inputClass + ' w-full'} />
      )}
    </div>
  );
}

function WorkflowEditor({ workflow, modules, onSave, onCancel, can }) {
  const [wf, setWf] = useState(workflow);
  const [fields, setFields] = useState([]);
  const [targetFields, setTargetFields] = useState({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (wf.module_id) api.listModuleFields(wf.module_id).then(setFields);
    else setFields([]);
  }, [wf.module_id]);

  const loadTargetFields = async (apiName) => {
    if (!apiName || targetFields[apiName]) return;
    const mod = modules.find((m) => m.api_name === apiName);
    if (!mod) return;
    const f = await api.listModuleFields(mod.id);
    setTargetFields((prev) => ({ ...prev, [apiName]: f }));
  };

  const addCondition = () => setWf({ ...wf, conditions: [...wf.conditions, { field: '', operator: 'equals', value: '' }] });
  const updateCondition = (i, cond) => setWf({ ...wf, conditions: wf.conditions.map((c, idx) => (idx === i ? cond : c)) });
  const removeCondition = (i) => setWf({ ...wf, conditions: wf.conditions.filter((_, idx) => idx !== i) });

  const addAction = () => setWf({ ...wf, actions: [...wf.actions, { type: 'update_field', config: {} }] });
  const updateAction = (i, action) => setWf({ ...wf, actions: wf.actions.map((a, idx) => (idx === i ? action : a)) });
  const removeAction = (i) => setWf({ ...wf, actions: wf.actions.filter((_, idx) => idx !== i) });

  const save = async () => {
    setError('');
    if (!wf.name.trim()) return setError('Name is required.');
    if (!wf.module_id) return setError('Pick a module.');
    if (wf.trigger_type === 'field_changed' && !wf.trigger_field) return setError('Pick which field to watch.');
    if (wf.actions.length === 0) return setError('Add at least one action.');
    setSaving(true);
    try { await onSave(wf); } catch (err) { setError(err.message); } finally { setSaving(false); }
  };

  return (
    <div className="card p-5 space-y-4">
      {error && <div className="text-xs text-warn bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</div>}

      <input value={wf.name} onChange={(e) => setWf({ ...wf, name: e.target.value })} placeholder="Workflow name (e.g. Escalate big deals)" className={inputClass + ' w-full text-sm font-medium'} />

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="text-xs text-slate-500 font-medium block mb-1">Module</label>
          <select value={wf.module_id} onChange={(e) => setWf({ ...wf, module_id: Number(e.target.value), trigger_field: '' })} className={inputClass + ' w-full'}>
            <option value="">Select a module…</option>
            {modules.map((m) => <option key={m.id} value={m.id}>{m.plural_label}</option>)}
          </select>
        </div>
        <div>
          <label className="text-xs text-slate-500 font-medium block mb-1">When…</label>
          <select value={wf.trigger_type} onChange={(e) => setWf({ ...wf, trigger_type: e.target.value })} className={inputClass + ' w-full'}>
            {TRIGGER_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
          </select>
        </div>
      </div>

      {wf.trigger_type === 'field_changed' && (
        <div>
          <label className="text-xs text-slate-500 font-medium block mb-1">Which field</label>
          <select value={wf.trigger_field} onChange={(e) => setWf({ ...wf, trigger_field: e.target.value })} className={inputClass}>
            <option value="">Select a field…</option>
            {fields.map((f) => <option key={f.api_name} value={f.api_name}>{f.label}</option>)}
          </select>
        </div>
      )}

      <div>
        <div className="flex items-center justify-between mb-1.5">
          <label className="text-xs text-slate-500 font-medium">Only if… (optional)</label>
          <button onClick={addCondition} className="text-xs text-amber font-medium inline-flex items-center gap-1"><Plus className="w-3 h-3" /> Condition</button>
        </div>
        <div className="space-y-2">
          {wf.conditions.map((c, i) => (
            <ConditionRow key={i} cond={c} fields={fields} onChange={(nc) => updateCondition(i, nc)} onRemove={() => removeCondition(i)} />
          ))}
          {wf.conditions.length === 0 && <p className="text-xs text-slate-400">No conditions — runs every time the trigger fires.</p>}
        </div>
      </div>

      <div>
        <div className="flex items-center justify-between mb-1.5">
          <label className="text-xs text-slate-500 font-medium">Then do this</label>
          <button onClick={addAction} className="text-xs text-amber font-medium inline-flex items-center gap-1"><Plus className="w-3 h-3" /> Action</button>
        </div>
        <div className="space-y-2">
          {wf.actions.map((a, i) => (
            <ActionRow key={i} action={a} fields={fields} modules={modules} targetFields={targetFields}
              onLoadTargetFields={loadTargetFields} onChange={(na) => updateAction(i, na)} onRemove={() => removeAction(i)} />
          ))}
          {wf.actions.length === 0 && <p className="text-xs text-slate-400">No actions yet — add at least one.</p>}
        </div>
      </div>

      <label className="text-xs text-slate-500 flex items-center gap-1.5">
        <input type="checkbox" checked={wf.active} onChange={(e) => setWf({ ...wf, active: e.target.checked })} /> Active
      </label>

      <div className="flex gap-2 pt-2 border-t border-line">
        {can('workflows', wf.id ? 'edit' : 'create') && (
          <button onClick={save} disabled={saving} className="btn btn-primary disabled:opacity-50">
            {saving ? 'Saving…' : 'Save workflow'}
          </button>
        )}
        <button onClick={onCancel} className="btn btn-secondary">Cancel</button>
      </div>
    </div>
  );
}

function RunHistory({ workflowId, onClose }) {
  const [runs, setRuns] = useState(null);
  useEffect(() => { api.getWorkflowRuns(workflowId).then(setRuns); }, [workflowId]);
  return (
    <div className="card p-5 mt-3">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-ink">Recent runs</h3>
        <button onClick={onClose} className="text-slate-400 hover:text-ink"><X className="w-4 h-4" /></button>
      </div>
      {!runs && <p className="text-xs text-slate-400">Loading…</p>}
      {runs && runs.length === 0 && <p className="text-xs text-slate-400">Hasn't run yet.</p>}
      {runs && runs.length > 0 && (
        <table className="w-full text-xs">
          <thead><tr className="text-left text-slate-400 border-b border-line">
            <th className="py-1.5 pr-2 font-medium">When</th><th className="py-1.5 pr-2 font-medium">Status</th>
            <th className="py-1.5 pr-2 font-medium">Actions run</th><th className="py-1.5 font-medium">Error</th>
          </tr></thead>
          <tbody>
            {runs.map((r) => (
              <tr key={r.id} className="border-b border-line/60">
                <td className="py-1.5 pr-2 text-slate-500">{r.created_at}</td>
                <td className="py-1.5 pr-2"><span className={r.status === 'success' ? 'text-emerald-600' : 'text-warn'}>{r.status}</span></td>
                <td className="py-1.5 pr-2 text-slate-500">{r.actions_executed}</td>
                <td className="py-1.5 text-slate-500">{r.error || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

export default function SettingsWorkflows() {
  const can = usePermissions();
  const [modules, setModules] = useState([]);
  const [workflows, setWorkflows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(null); // workflow being created/edited, or null
  const [viewingRuns, setViewingRuns] = useState(null);

  const load = () => Promise.all([api.listModulesMeta(), api.listWorkflows()])
    .then(([m, w]) => { setModules(m); setWorkflows(w); }).finally(() => setLoading(false));
  useEffect(() => { load(); }, []);

  const moduleLabel = (id) => modules.find((m) => m.id === id)?.plural_label || `#${id}`;

  const startNew = () => setEditing(emptyWorkflow());
  const startEdit = (wf) => setEditing({
    ...wf,
    conditions: JSON.parse(wf.conditions_json || '[]'),
    actions: JSON.parse(wf.actions_json || '[]'),
    active: !!wf.active,
  });

  const saveWorkflow = async (wf) => {
    const payload = { name: wf.name, module_id: wf.module_id, trigger_type: wf.trigger_type, trigger_field: wf.trigger_field || null, conditions: wf.conditions, actions: wf.actions, active: wf.active };
    if (wf.id) await api.updateWorkflow(wf.id, payload);
    else await api.createWorkflow(payload);
    setEditing(null);
    load();
  };

  const toggleActive = async (wf) => { await api.updateWorkflow(wf.id, { active: wf.active ? 0 : 1 }); load(); };
  const remove = async (wf) => { if (!confirm(`Delete "${wf.name}"?`)) return; await api.deleteWorkflow(wf.id); load(); };

  if (loading) return <div className="py-8 t-meta">Loading…</div>;

  return (
    <div className="max-w-[1600px] mx-auto">
      <PageHeader
        title="Workflows"
        subtitle="Automate what happens when a record is created, updated, or a field changes — no code required."
        icon={Zap}
        accent="settings"
      >
        {can('workflows', 'create') && !editing && (
          <button onClick={startNew} className="btn btn-primary inline-flex items-center gap-1.5">
            <Plus className="w-4 h-4" /> New workflow
          </button>
        )}
      </PageHeader>

      {editing && (
        <div className="mt-6">
          <WorkflowEditor workflow={editing} modules={modules} onSave={saveWorkflow} onCancel={() => setEditing(null)} can={can} />
        </div>
      )}

      {!editing && (
        <div className="space-y-3 mt-6">
          {workflows.map((wf) => (
            <div key={wf.id} className="card p-4">
              <div className="flex items-center justify-between flex-wrap gap-2">
                <div>
                  <div className="text-sm font-medium text-ink flex items-center gap-2">
                    {wf.name}
                    {!wf.active && <span className="text-[10px] bg-slate-100 text-slate-500 px-1.5 py-0.5 rounded-full">Inactive</span>}
                  </div>
                  <div className="text-xs text-slate-400 mt-0.5">
                    {moduleLabel(wf.module_id)} · {TRIGGER_TYPES.find((t) => t.value === wf.trigger_type)?.label}
                    {wf.trigger_field ? ` (${wf.trigger_field})` : ''}
                  </div>
                </div>
                <div className="flex gap-1">
                  <button onClick={() => setViewingRuns(viewingRuns === wf.id ? null : wf.id)} className="text-slate-400 hover:text-ink p-1.5" title="View run history"><Play className="w-4 h-4" /></button>
                  {can('workflows', 'edit') && <button onClick={() => toggleActive(wf)} className="text-xs border border-line rounded-lg px-2.5 py-1 hover:bg-canvas">{wf.active ? 'Pause' : 'Activate'}</button>}
                  {can('workflows', 'edit') && <button onClick={() => startEdit(wf)} className="text-slate-400 hover:text-ink p-1.5"><Pencil className="w-4 h-4" /></button>}
                  {can('workflows', 'delete') && <button onClick={() => remove(wf)} className="text-slate-400 hover:text-warn p-1.5"><Trash2 className="w-4 h-4" /></button>}
                </div>
              </div>
              {viewingRuns === wf.id && <RunHistory workflowId={wf.id} onClose={() => setViewingRuns(null)} />}
            </div>
          ))}
          {workflows.length === 0 && (
            <div className="card p-8 text-center text-sm text-slate-400">
              No workflows yet. Create one to automate a repetitive step.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
