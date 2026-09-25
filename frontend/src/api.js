// In local dev, Vite proxies /api to localhost:4000 (see vite.config.js).
// In production, set VITE_API_BASE_URL to your backend URL.
const API_ROOT = import.meta.env.VITE_API_BASE_URL || '';
const BASE = `${API_ROOT}/api`;

// ---------------------------------------------------------------------------
// Authenticated file download.
//
// A plain <a href="/api/…/download"> cannot work here: the JWT lives in
// localStorage and is sent as an Authorization header, but browsers do not
// attach headers to a link navigation — so every such request arrived
// unauthenticated and was rejected with 401.
//
// This fetches the file WITH the header, then hands the browser a blob to
// save. Errors surface as real errors instead of the browser silently
// showing a JSON 401 body in a new tab.
// ---------------------------------------------------------------------------
export async function downloadFile(path, fallbackName = 'download') {
  const token = localStorage.getItem('cd_token');
  const res = await fetch(BASE + path, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });

  if (!res.ok) {
    let message = `Download failed (${res.status})`;
    try {
      const data = await res.json();
      if (data?.error) message = data.error;
    } catch { /* non-JSON error body; keep the status message */ }
    if (res.status === 401) message = 'Your session has expired — please sign in again.';
    if (res.status === 403) message = "You don't have permission to download this file.";
    throw new Error(message);
  }

  // Prefer the filename the server suggests, so downloads keep their real
  // names rather than a generic one.
  let filename = fallbackName;
  const disposition = res.headers.get('Content-Disposition') || '';
  const match = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition);
  if (match) filename = decodeURIComponent(match[1].trim());

  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke on the next tick — revoking immediately can cancel the download
  // in some browsers before it has started reading the blob.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return filename;
}

// Opens a PDF in a new tab (rather than saving it), still authenticated.
export async function openFileInTab(path) {
  const token = localStorage.getItem('cd_token');
  const res = await fetch(BASE + path, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  if (!res.ok) {
    let message = `Could not open the file (${res.status})`;
    try { const d = await res.json(); if (d?.error) message = d.error; } catch { /* keep status */ }
    if (res.status === 401) message = 'Your session has expired — please sign in again.';
    throw new Error(message);
  }
  const url = URL.createObjectURL(await res.blob());
  const win = window.open(url, '_blank');
  if (!win) {
    // Pop-up blocked — fall back to saving it so the click still does
    // something useful rather than appearing to do nothing.
    const a = document.createElement('a');
    a.href = url; a.download = 'document.pdf';
    document.body.appendChild(a); a.click(); a.remove();
  }
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

async function req(method, path, body) {
  const token = localStorage.getItem('cd_token');
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(BASE + path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  if (res.status === 401) {
    localStorage.removeItem('cd_token');
    localStorage.removeItem('cd_user');
    if (!window.location.pathname.startsWith('/login')) {
      window.location.href = '/login';
    }
    throw new Error('Session expired, please log in again');
  }

  if (res.status === 204) return null;
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    // Attach the full error payload, not just its message. Some endpoints
    // (email test-send) return a request_id and the raw underlying error
    // alongside the friendly one specifically so a failure can be diagnosed
    // without needing hosting-dashboard access — discarding everything but
    // .error would throw that away.
    const err = new Error(data?.error || res.statusText);
    err.status = res.status;
    err.requestId = data?.request_id;
    err.rawError = data?.raw_error;
    throw err;
  }
  return data;
}

const qs = (params) => {
  const clean = Object.fromEntries(Object.entries(params || {}).filter(([, v]) => v !== undefined && v !== null && v !== ''));
  const q = new URLSearchParams(clean).toString();
  return q ? `?${q}` : '';
};

// Base path for a module's records: modules with a real physical table
// (table_name set) use their dedicated REST route (/api/accounts, ...);
// modules with no table yet (admin-created custom modules) use the generic
// JSON-backed route from the metadata layer.
const recordsBase = (module) => (module.table_name ? `/${module.api_name}` : `/records/${module.api_name}`);

export const api = {
  // auth
  login: (username, password) => req('POST', '/auth/login', { username, password }),
  me: () => req('GET', '/auth/me'),

  // leads
  listLeads: (params) => req('GET', '/leads' + qs(params)),
  getLead: (id) => req('GET', `/leads/${id}`),
  createLead: (body) => req('POST', '/leads', body),
  updateLead: (id, body) => req('PUT', `/leads/${id}`, body),
  deleteLead: (id) => req('DELETE', `/leads/${id}`),
  addLeadActivity: (id, body) => req('POST', `/leads/${id}/activities`, body),
  convertLead: (id, body) => req('POST', `/leads/${id}/convert`, body),

  // payments — generic, linked to an Account/Opportunity/Quotation, or a
  // one-off payer_name when there's no specific linked record
  listPayments: (params) => req('GET', '/payments' + qs(params)),
  getPayment: (id) => req('GET', `/payments/${id}`),
  createPayment: (body) => req('POST', '/payments', body),
  updatePayment: (id, body) => req('PUT', `/payments/${id}`, body),
  deletePayment: (id) => req('DELETE', `/payments/${id}`),
  downloadReceipt: (id, institute) => downloadFile(`/payments/${id}/receipt?institute=${institute}`, `receipt-${id}.pdf`),

  // dashboard
  dashboard: () => req('GET', '/dashboard'),
  dashboardCrm: (params) => req('GET', '/dashboard/crm' + qs(params)),
  // The records behind one dashboard figure — same metric, same filters.
  dashboardDrill: (params) => req('GET', '/dashboard/drill' + qs(params)),

  // reports
  //
  // The per-report endpoints that used to live here (students, admissions,
  // course-wise admissions, fee collection, placements, interviews) went with
  // the education modules they reported on. Reports are now driven by a
  // catalogue the backend publishes, so adding a report needs no change here.
  reportCatalogue: () => req('GET', '/reports/catalogue'),
  runReport: (key, params) => req('GET', `/reports/run/${key}` + qs(params)),

  // report builder
  reportBuilderModules: () => req('GET', '/reports/builder/modules'),
  reportFieldValues: (module, field) => req('GET', '/reports/builder/values' + qs({ module, field })),
  runCustomReport: (config) => req('POST', '/reports/custom/run', config),

  // saved reports
  listSavedReports: () => req('GET', '/reports/saved'),
  createSavedReport: (body) => req('POST', '/reports/saved', body),
  runSavedReport: (id, params) => req('GET', `/reports/saved/${id}/run` + qs(params)),
  updateSavedReport: (id, body) => req('PUT', `/reports/saved/${id}`, body),
  deleteSavedReport: (id) => req('DELETE', `/reports/saved/${id}`),

  // per-customer extensions (features built for one customer only)
  extensionStatus: () => req('GET', '/extensions'),

  // calendar
  calendarProviders: () => req('GET', '/calendar/providers'),
  calendarConnections: () => req('GET', '/calendar/connections'),
  calendarConnectUrl: (provider) => req('GET', `/calendar/connect/${provider}`),
  syncCalendarConnection: (id, full) => req('POST', `/calendar/connections/${id}/sync`, { full: !!full }),
  updateCalendarConnection: (id, body) => req('PATCH', `/calendar/connections/${id}`, body),
  deleteCalendarConnection: (id) => req('DELETE', `/calendar/connections/${id}`),
  calendarEvents: (params) => req('GET', '/calendar/events' + qs(params)),
  createCalendarEvent: (body) => req('POST', '/calendar/events', body),
  updateCalendarEvent: (id, body) => req('PATCH', `/calendar/events/${id}`, body),
  deleteCalendarEvent: (id) => req('DELETE', `/calendar/events/${id}`),
  calendarConflicts: (params) => req('GET', '/calendar/conflicts' + qs(params)),
  calendarSuggest: (params) => req('GET', '/calendar/suggest' + qs(params)),
  calendarAgenda: (days) => req('GET', '/calendar/agenda' + qs({ days })),
  // Downloaded WITH the auth header, like every other file in this app. A
  // plain <a href> would arrive unauthenticated and hand the user a JSON 401
  // instead of a calendar file — the same trap the chat attachments fell into.
  downloadCalendarIcs: () => downloadFile('/calendar/export.ics', 'icrm-calendar.ics'),

  // notifications
  listNotifications: () => req('GET', '/notifications'),
  markNotificationRead: (key) => req('POST', `/notifications/${key}/read`),
  markAllNotificationsRead: () => req('POST', '/notifications/read-all'),

  // roles & users
  listRoles: () => req('GET', '/roles'),
  createRole: (body) => req('POST', '/roles', body),
  updateRolePermissions: (id, permissions) => req('PUT', `/roles/${id}/permissions`, { permissions }),
  deleteRole: (id) => req('DELETE', `/roles/${id}`),

  // security — IP & time-based access control
  securityMyIp: () => req('GET', '/security/my-ip'),
  securityPolicies: (params) => req('GET', '/security/policies' + qs(params)),
  securityPolicy: (id) => req('GET', `/security/policies/${id}`),
  createSecurityPolicy: (body) => req('POST', '/security/policies', body),
  updateSecurityPolicy: (id, body) => req('PATCH', `/security/policies/${id}`, body),
  deleteSecurityPolicy: (id) => req('DELETE', `/security/policies/${id}`),
  securityMatrix: (params) => req('GET', '/security/matrix' + qs(params)),
  securityUserDetail: (id) => req('GET', `/security/users/${id}/detail`),
  securityDashboard: () => req('GET', '/security/dashboard'),
  securityAuditLog: (params) => req('GET', '/security/audit-log' + qs(params)),

  listUsers: () => req('GET', '/users'),
  createUser: (body) => req('POST', '/users', body),
  updateUser: (id, body) => req('PUT', `/users/${id}`, body),
  deleteUser: (id) => req('DELETE', `/users/${id}`),

  // settings
  listReceiptTemplates: () => req('GET', '/settings/receipt-templates'),
  updateReceiptTemplate: (id, body) => req('PUT', `/settings/receipt-templates/${id}`, body),
  listMasterOptions: (listType) => req('GET', `/settings/master-options${listType ? `?list_type=${listType}` : ''}`),
  createMasterOption: (body) => req('POST', '/settings/master-options', body),
  updateMasterOption: (id, body) => req('PUT', `/settings/master-options/${id}`, body),
  deleteMasterOption: (id) => req('DELETE', `/settings/master-options/${id}`),

  // AI assistant
  listConversations: () => req('GET', '/assistant/conversations'),
  createConversation: () => req('POST', '/assistant/conversations', {}),
  getConversation: (id) => req('GET', `/assistant/conversations/${id}`),
  sendAssistantMessage: (id, message) => req('POST', `/assistant/conversations/${id}/message`, { message }),
  confirmAssistantAction: (id, approve) => req('POST', `/assistant/conversations/${id}/confirm`, { approve }),
  assistantAuditLog: () => req('GET', '/assistant/audit-log'),

  // demo data
  seedDemoData: () => req('POST', '/dev/seed-demo-data'),
  demoDataStatus: () => req('GET', '/dev/demo-data'),
  wipeDemoData: () => req('DELETE', '/dev/demo-data'),
  repairPermissions: () => req('POST', '/dev/repair-permissions'),

  // WhatsApp integrations
  waProviderTypes: () => req('GET', '/whatsapp/provider-types'),
  waListProviders: () => req('GET', '/whatsapp/providers'),
  waConnectProvider: (body) => req('POST', '/whatsapp/providers', body),
  waUpdateProvider: (id, body) => req('PUT', `/whatsapp/providers/${id}`, body),
  waDeleteProvider: (id) => req('DELETE', `/whatsapp/providers/${id}`),
  waSetDefaultProvider: (id) => req('POST', `/whatsapp/providers/${id}/set-default`),
  waTestProvider: (id) => req('POST', `/whatsapp/providers/${id}/test`),
  waSyncTemplates: (id) => req('POST', `/whatsapp/providers/${id}/sync-templates`),
  waListTemplates: (params) => req('GET', '/whatsapp/templates' + qs(params)),
  waAuditLog: () => req('GET', '/whatsapp/audit-log'),

  // WhatsApp workflows
  waListEvents: () => req('GET', '/whatsapp/events'),
  waListWorkflows: () => req('GET', '/whatsapp/workflows'),
  waCreateWorkflow: (body) => req('POST', '/whatsapp/workflows', body),
  waUpdateWorkflow: (id, body) => req('PUT', `/whatsapp/workflows/${id}`, body),
  waActivateWorkflow: (id) => req('POST', `/whatsapp/workflows/${id}/activate`),
  waDeactivateWorkflow: (id) => req('POST', `/whatsapp/workflows/${id}/deactivate`),
  waDeleteWorkflow: (id) => req('DELETE', `/whatsapp/workflows/${id}`),
  waWorkflowRuns: (id) => req('GET', `/whatsapp/workflows/${id}/runs`),
  waRunScheduledChecks: () => req('POST', '/whatsapp/workflows/run-scheduled-checks'),

  // WhatsApp campaigns
  waPreviewRecipients: (body) => req('POST', '/whatsapp/campaigns/preview-recipients', body),
  waListCampaigns: () => req('GET', '/whatsapp/campaigns'),
  waCreateCampaign: (body) => req('POST', '/whatsapp/campaigns', body),
  waGetCampaign: (id) => req('GET', `/whatsapp/campaigns/${id}`),
  waDeleteCampaign: (id) => req('DELETE', `/whatsapp/campaigns/${id}`),
  waSendCampaign: (id, body) => req('POST', `/whatsapp/campaigns/${id}/send`, body || {}),
  waListOptouts: () => req('GET', '/whatsapp/optouts'),
  waAddOptout: (body) => req('POST', '/whatsapp/optouts', body),
  waRemoveOptout: (id) => req('DELETE', `/whatsapp/optouts/${id}`),

  // WhatsApp conversations
  waListConversations: (params) => req('GET', '/whatsapp/conversations' + qs(params)),
  waGetConversation: (id) => req('GET', `/whatsapp/conversations/${id}`),
  waMarkConversationRead: (id) => req('POST', `/whatsapp/conversations/${id}/read`),
  waReplyConversation: (id, text) => req('POST', `/whatsapp/conversations/${id}/reply`, { text }),

  // WhatsApp analytics
  waAnalytics: (params) => req('GET', '/whatsapp/analytics' + qs(params)),
  waAnalyticsCampaignOptions: () => req('GET', '/whatsapp/analytics/campaign-options'),

  // Lead source integrations
  leadSourceTypes: () => req('GET', '/lead-sources/source-types'),
  listLeadSources: () => req('GET', '/lead-sources/sources'),
  createLeadSource: (body) => req('POST', '/lead-sources/sources', body),
  updateLeadSource: (id, body) => req('PUT', `/lead-sources/sources/${id}`, body),
  regenerateLeadSourceKey: (id) => req('POST', `/lead-sources/sources/${id}/regenerate-key`),
  deleteLeadSource: (id) => req('DELETE', `/lead-sources/sources/${id}`),
  leadSourceLogs: (id) => req('GET', `/lead-sources/sources/${id}/logs`),
  leadSourceEmbedSnippet: (id) => req('GET', `/lead-sources/sources/${id}/embed-snippet`),

  // Facebook OAuth connect flow
  fbConnectUrl: () => req('GET', '/lead-sources/facebook/connect'),
  fbConnections: () => req('GET', '/lead-sources/facebook/connections'),
  fbDeleteConnection: (id) => req('DELETE', `/lead-sources/facebook/connections/${id}`),
  fbPages: (connectionId) => req('GET', `/lead-sources/facebook/connections/${connectionId}/pages`),
  fbForms: (connectionId, pageId) => req('GET', `/lead-sources/facebook/connections/${connectionId}/pages/${pageId}/forms`),
  fbConnectForm: (body) => req('POST', '/lead-sources/facebook/connect-form', body),

  // Universal CRM — module + field metadata
  listModulesMeta: (includeDisabled) => req('GET', '/modules' + (includeDisabled ? '?include_disabled=1' : '')),
  getModuleMeta: (apiName) => req('GET', `/modules/${apiName}`),
  listModuleFields: (moduleId) => req('GET', `/modules/${moduleId}/fields`),
  createModuleMeta: (body) => req('POST', '/modules', body),
  updateModuleMeta: (id, body) => req('PUT', `/modules/${id}`, body),
  deleteModuleMeta: (id) => req('DELETE', `/modules/${id}`),
  createModuleField: (moduleId, body) => req('POST', `/modules/${moduleId}/fields`, body),
  updateModuleField: (moduleId, fieldId, body) => req('PUT', `/modules/${moduleId}/fields/${fieldId}`, body),
  moduleFieldUsage: (moduleId, fieldId) => req('GET', `/modules/${moduleId}/fields/${fieldId}/usage`),
  deleteModuleField: (moduleId, fieldId) => req('DELETE', `/modules/${moduleId}/fields/${fieldId}`),

  // Lookup pickers — searching a module by name, and resolving stored ids
  // back to names so a record never shows "Customer: 47".
  lookupSearch: (module, q, limit) => req('GET', `/search/lookup/${module}` + qs({ q, limit })),
  lookupResolve: (module, ids) => req('GET', `/search/lookup/${module}` + qs({ ids: ids.join(',') })),

  // Sales documents — proforma invoices and invoices share one router, so
  // `base` is '/proforma-invoices' or '/invoices' (and '/quotations', which
  // supports the same PDF, preview and convert actions).
  documentLineage: (moduleApiName, id) => req('GET', `/${moduleApiName}/${id}/lineage`),
  convertDocument: (base, id, target) => req('POST', `${base}/${id}/convert/${target}`, {}),
  sendDocument: (base, id, body) => req('POST', `${base}/${id}/send`, body),
  documentSummary: (base) => req('GET', `${base}/summary/stats`),

  // The PDF is fetched WITH the auth header and handed back as a blob. A
  // window.open of the URL would carry no header and show a 401 body instead.
  documentPdfBlob: async (base, id, templateId) => {
    const token = localStorage.getItem('cd_token');
    const res = await fetch(`${BASE}${base}/${id}/preview${templateId ? `?template_id=${templateId}` : ''}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) throw new Error(`Could not build the document (${res.status})`);
    return res.blob();
  },

  recordInvoicePayment: (invoiceId, body) => req('POST', `/invoices/${invoiceId}/payments`, body),
  updateInvoicePayment: (invoiceId, paymentId, body) => req('PUT', `/invoices/${invoiceId}/payments/${paymentId}`, body),
  deleteInvoicePayment: (invoiceId, paymentId) => req('DELETE', `/invoices/${invoiceId}/payments/${paymentId}`),

  // Document templates
  listDocumentTemplates: (params) => req('GET', '/document-templates' + qs(params)),
  getDocumentTemplate: (id) => req('GET', `/document-templates/${id}`),
  createDocumentTemplate: (body) => req('POST', '/document-templates', body),
  updateDocumentTemplate: (id, body) => req('PUT', `/document-templates/${id}`, body),
  duplicateDocumentTemplate: (id, body) => req('POST', `/document-templates/${id}/duplicate`, body || {}),
  deleteDocumentTemplate: (id) => req('DELETE', `/document-templates/${id}`),
  makeTemplateDefault: (id) => req('POST', `/document-templates/${id}/default`, {}),
  restoreTemplateVersion: (id, version) => req('POST', `/document-templates/${id}/restore/${version}`, {}),
  // One search behind the attendee picker and the record selector.
  calendarPeople: (params) => req('GET', '/calendar/people' + qs(params)),
  templateCatalog: () => req('GET', '/document-templates/catalog'),
  // The ready-made library: every template plus its config (the browser draws
  // the thumbnails from those), facets, recents and recommendations, in one
  // request rather than one per card.
  templateLibrary: (params) => req('GET', '/document-templates/library' + qs(params)),
  favoriteTemplate: (id) => req('POST', `/document-templates/${id}/favorite`, {}),
  useTemplate: (id, body) => req('POST', `/document-templates/${id}/use`, body || {}),
  templatePreviewBlob: async (body) => {
    const token = localStorage.getItem('cd_token');
    const res = await fetch(`${BASE}/document-templates/preview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      let message = `Preview failed (${res.status})`;
      try { const d = await res.json(); if (d?.error) message = d.error; } catch { /* keep status */ }
      throw new Error(message);
    }
    return res.blob();
  },

  // Company profile — the letterhead every document prints with
  getCompanyProfile: () => req('GET', '/company-profile'),
  updateCompanyProfile: (body) => req('PUT', '/company-profile', body),

  // Settings → Document Numbering
  listDocumentSequences: () => req('GET', '/document-numbering'),
  previewDocumentSequence: (docType, body) => req('POST', `/document-numbering/${docType}/preview`, body),
  updateDocumentSequence: (docType, body) => req('PUT', `/document-numbering/${docType}`, body),

  // Universal CRM — generic record CRUD (works for standard + custom modules)
  universalList: (module, params) => req('GET', recordsBase(module) + qs(params)),

  // Subscriptions / AMC — schedule, renewal cycles and history
  listSubscriptions: (params) => req('GET', '/subscriptions' + qs(params)),
  subscriptionSchedule: (id) => req('GET', `/subscriptions/${id}/schedule`),
  previewSubscription: (body) => req('POST', '/subscriptions/preview', body),
  createSubscription: (body) => req('POST', '/subscriptions', body),
  renewSubscription: (id, body) => req('POST', `/subscriptions/${id}/renew`, body),
  universalGet: (module, id) => req('GET', `${recordsBase(module)}/${id}`),
  universalCreate: (module, body) => req('POST', recordsBase(module), body),
  universalUpdate: (module, id, body) => req('PUT', `${recordsBase(module)}/${id}`, body),
  universalDelete: (module, id) => req('DELETE', `${recordsBase(module)}/${id}`),

  // Custom fields on a STANDARD module's record (EAV values, separate from
  // the record's real columns) — only meaningful when module.table_name is
  // set; custom (JSON-backed) modules keep all their fields in record.data
  // via the universal* methods above instead.
  getCustomFieldValues: (moduleApiName, recordId) => req('GET', `/records/${moduleApiName}/${recordId}/custom-fields`),
  saveCustomFieldValues: (moduleApiName, recordId, body) => req('PUT', `/records/${moduleApiName}/${recordId}/custom-fields`, body),

  // Universal CRM — relationships + kanban
  listRelated: (moduleApiName, recordId) => req('GET', `/relationships/${moduleApiName}/${recordId}`),
  linkRecords: (body) => req('POST', '/relationships', body),
  unlinkRecords: (body) => req('DELETE', '/relationships', body),
  kanban: (moduleApiName) => req('GET', `/${moduleApiName}/kanban`),
  moveOpportunityStage: (id, stageId) => req('PUT', `/opportunities/${id}/stage`, { stage_id: stageId }),

  // Universal CRM — global search across every enabled module the user can view
  globalSearch: (q, limit) => req('GET', `/search?q=${encodeURIComponent(q)}${limit ? `&limit=${limit}` : ''}`),

  // Universal CRM — general Workflow Automation engine
  listWorkflows: () => req('GET', '/workflows'),
  getWorkflow: (id) => req('GET', `/workflows/${id}`),
  createWorkflow: (body) => req('POST', '/workflows', body),
  updateWorkflow: (id, body) => req('PUT', `/workflows/${id}`, body),
  deleteWorkflow: (id) => req('DELETE', `/workflows/${id}`),
  getWorkflowRuns: (id) => req('GET', `/workflows/${id}/runs`),

  // Universal CRM — Pipeline Builder
  // Universal CRM — Pipeline Builder
  listPipelines: (moduleApiName) => req('GET', '/pipelines' + (moduleApiName ? `?module=${moduleApiName}` : '')),
  getPipeline: (id) => req('GET', `/pipelines/${id}`),
  createPipeline: (body) => req('POST', '/pipelines', body),
  updatePipeline: (id, body) => req('PUT', `/pipelines/${id}`, body),
  deletePipeline: (id) => req('DELETE', `/pipelines/${id}`),

  // Universal CRM — quotation PDF + send
  downloadQuotationPdf: (id, institute) => downloadFile(`/quotations/${id}/pdf?institute=${institute || 'A'}`, `quotation-${id}.pdf`),
  openQuotationPdf: (id, institute) => openFileInTab(`/quotations/${id}/pdf?institute=${institute || 'A'}`),
  sendQuotation: (id, body) => req('POST', `/quotations/${id}/send`, body),

  // Universal CRM — Audit log + Import/Export
  listAudit: (params) => req('GET', '/admin/audit' + qs(params)),
  exportUrl: (moduleApiName) => `${BASE}/admin/export/${moduleApiName}`,
  importTemplateUrl: (moduleApiName) => `${BASE}/admin/import-template/${moduleApiName}`,
  importCsv: (moduleApiName, csv, dryRun, createMissingFields) =>
    req('POST', `/admin/import/${moduleApiName}`, {
      csv, dry_run: !!dryRun, create_missing_fields: !!createMissingFields,
    }),
  importAnalyze: (moduleApiName, csv) => req('POST', `/admin/import-analyze/${moduleApiName}`, { csv }),

  // Customer 360 + scoring
  customer360: (accountId) => req('GET', `/c360/accounts/${accountId}`),
  accountScore: (accountId) => req('GET', `/c360/accounts/${accountId}/score`),
  leadScore: (leadId) => req('GET', `/c360/leads/${leadId}/score`),
  // Email campaigns
  listCampaigns: () => req('GET', '/email-campaigns'),
  getCampaign: (id) => req('GET', `/email-campaigns/${id}`),
  createCampaign: (body) => req('POST', '/email-campaigns', body),
  updateCampaign: (id, body) => req('PUT', `/email-campaigns/${id}`, body),
  deleteCampaign: (id) => req('DELETE', `/email-campaigns/${id}`),
  sendCampaign: (id) => req('POST', `/email-campaigns/${id}/send`, {}),
  testCampaign: (id, to) => req('POST', `/email-campaigns/${id}/test`, { to }),
  pauseCampaign: (id) => req('POST', `/email-campaigns/${id}/pause`, {}),
  resumeCampaign: (id) => req('POST', `/email-campaigns/${id}/resume`, {}),
  duplicateCampaign: (id) => req('POST', `/email-campaigns/${id}/duplicate`, {}),
  campaignAudiences: () => req('GET', '/email-campaigns/audiences'),
  previewAudience: (recipientSource, filters) =>
    req('POST', '/email-campaigns/preview-audience', { recipient_source: recipientSource, filters }),
  listCampaignTemplates: () => req('GET', '/email-campaigns/templates'),
  createCampaignTemplate: (body) => req('POST', '/email-campaigns/templates', body),
  listUnsubscribes: () => req('GET', '/email-campaigns/unsubscribes/list'),
  addUnsubscribe: (email, reason) => req('POST', '/email-campaigns/unsubscribes/list', { email, reason }),

  // Inbox (inbound email)
  listInbox: (params) => req('GET', '/inbox' + qs(params)),
  getEmail: (id) => req('GET', `/inbox/${id}`),
  markEmailRead: (id) => req('POST', `/inbox/${id}/read`, { read: true }),
  linkEmail: (id, relatedModule, relatedRecordId) =>
    req('POST', `/inbox/${id}/link`, { related_module: relatedModule, related_record_id: relatedRecordId }),
  replyEmail: (id, body) => req('POST', `/inbox/${id}/reply`, body),
  syncInbox: (accountId) => req('POST', '/inbox/sync', accountId ? { account_id: accountId } : {}),
  inboxSyncStatus: () => req('GET', '/inbox/sync/status'),
  downloadEmailAttachment: (id, name) => downloadFile(`/inbox/attachments/${id}/download`, name || 'attachment'),

  // Email account configuration
  getOrgEmail: () => req('GET', '/email-settings/org'),
  saveOrgEmail: (body) => req('PUT', '/email-settings/org', body),
  getMyEmail: () => req('GET', '/email-settings/me'),
  emailDiagnostics: (params) => req('GET', '/email-settings/diagnostics' + qs(params)),
  saveMyEmail: (body) => req('PUT', '/email-settings/me', body),
  testEmail: (scope) => req('POST', '/email-settings/test', { scope }),

  listWaQuickTemplates: () => req('GET', '/wa-quick-templates'),
  createWaQuickTemplate: (body) => req('POST', '/wa-quick-templates', body),

  addNote: (relatedModule, relatedRecordId, body) =>
    req('POST', '/notes', { body, related_module: relatedModule, related_record_id: relatedRecordId }),
  aiCustomerSummary: (accountId, question) => req('POST', `/c360/accounts/${accountId}/ai-summary`, { question }),

  // Call disposition + call analytics
  disposeCall: (body) => req('POST', '/calls/dispose', body),
  callReport: (params) => req('GET', '/calls/report' + qs(params)),

  // Universal CRM — Taxes & Currencies
  listTaxes: () => req('GET', '/finance/taxes'),
  createTax: (body) => req('POST', '/finance/taxes', body),
  updateTax: (id, body) => req('PUT', `/finance/taxes/${id}`, body),
  deleteTax: (id) => req('DELETE', `/finance/taxes/${id}`),
  listCurrencies: () => req('GET', '/finance/currencies'),
  createCurrency: (body) => req('POST', '/finance/currencies', body),
  updateCurrency: (code, body) => req('PUT', `/finance/currencies/${code}`, body),
  deleteCurrency: (code) => req('DELETE', `/finance/currencies/${code}`),

  // Universal CRM — Teams
  listTeams: () => req('GET', '/teams'),
  createTeam: (body) => req('POST', '/teams', body),
  updateTeam: (id, body) => req('PUT', `/teams/${id}`, body),
  deleteTeam: (id) => req('DELETE', `/teams/${id}`),

  // Universal CRM — Documents
  listDocuments: (params) => req('GET', '/documents' + qs(params)),
  createDocumentLink: (body) => req('POST', '/documents', body),
  deleteDocument: (id) => req('DELETE', `/documents/${id}`),
  downloadDocument: (id, name) => downloadFile(`/documents/${id}/download`, name || 'document'),
  uploadDocument: async (formData) => {
    // Multipart — can't go through req(), which sets a JSON content-type.
    const res = await fetch(`${BASE}/documents`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${localStorage.getItem('cd_token')}` },
      body: formData,
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Upload failed');
    return res.json();
  },

  // Universal CRM — generative AI Actions
  aiAnalyze: (moduleApiName, id, saveAsNote) => req('POST', `/ai-actions/${moduleApiName}/${id}/analyze`, { save_as_note: !!saveAsNote }),
  aiSummarize: (moduleApiName, id, createTasks) => req('POST', `/ai-actions/${moduleApiName}/${id}/summarize`, { create_tasks: !!createTasks }),
  aiAskDashboard: (question) => req('POST', '/ai-actions/dashboard/ask', { question }),

  // Universal CRM — WhatsApp conversation for a specific record (any module)
  getRecordConversation: (entityType, entityId) => req('GET', `/whatsapp/conversations?entity_type=${entityType}&entity_id=${entityId}`),
  getConversationDetail: (conversationId) => req('GET', `/whatsapp/conversations/${conversationId}`),
  replyToConversation: (conversationId, text) => req('POST', `/whatsapp/conversations/${conversationId}/reply`, { text }),

  // Universal CRM — Layout Builder (layoutType: 'create' | 'edit' | 'detail')
  getModuleLayout: (moduleId, layoutType) => req('GET', `/modules/${moduleId}/layout/${layoutType}`),
  saveModuleLayout: (moduleId, layoutType, layoutJson) => req('PUT', `/modules/${moduleId}/layout/${layoutType}`, layoutJson),

  // Database backup
  emailBackupNow: (to) => req('POST', '/backup/email-now', { to }),
  backupStatus: () => req('GET', '/backup/status'),

  // Restore is a multipart upload, so it can't go through req() — that sets
  // a JSON content-type, which would break the file boundary.
  restoreBackup: async (file) => {
    const token = localStorage.getItem('cd_token');
    const body = new FormData();
    body.append('file', file);
    const res = await fetch(`${BASE}/backup/restore`, {
      method: 'POST',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      body,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Restore failed (${res.status})`);
    return data;
  },
  downloadBackup: async () => {
    const token = localStorage.getItem('cd_token');
    const res = await fetch(`${BASE}/backup/download`, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) { const data = await res.json().catch(() => null); throw new Error(data?.error || 'Download failed'); }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `crm-backup-${new Date().toISOString().slice(0, 10)}.db`;
    a.click();
    URL.revokeObjectURL(url);
  },

  // ===== Internal team chat =====
  chatUsers: () => req('GET', '/chat/users'),
  chatConversations: () => req('GET', '/chat/conversations'),
  chatConversation: (id) => req('GET', `/chat/conversations/${id}`),
  chatOpenDirect: (userId) => req('POST', '/chat/direct', { user_id: userId }),
  chatCreateGroup: (name, memberIds) => req('POST', '/chat/groups', { name, member_ids: memberIds }),
  chatAddMembers: (id, memberIds) => req('POST', `/chat/conversations/${id}/members`, { member_ids: memberIds }),
  chatRemoveMember: (id, userId) => req('DELETE', `/chat/conversations/${id}/members/${userId}`),
  chatRenameGroup: (id, name) => req('PUT', `/chat/conversations/${id}/name`, { name }),
  chatLeave: (id) => req('POST', `/chat/conversations/${id}/leave`),
  chatMute: (id, muted) => req('POST', `/chat/conversations/${id}/mute`, { muted }),
  chatMessages: (id, before) => req('GET', `/chat/conversations/${id}/messages${before ? `?before=${before}` : ''}`),
  chatMarkRead: (id, upto) => req('POST', `/chat/conversations/${id}/read`, { upto_message_id: upto }),
  chatEditMessage: (id, body) => req('PUT', `/chat/messages/${id}`, { body }),
  chatDeleteMessage: (id) => req('DELETE', `/chat/messages/${id}`),
  chatSearch: (q) => req('GET', `/chat/search?q=${encodeURIComponent(q)}`),
  chatPoll: (since, conversationId) => req(
    'GET',
    `/chat/poll?since=${since || 0}${conversationId ? `&conversation_id=${conversationId}` : ''}`,
  ),
  // NOT a plain URL. The JWT lives in localStorage and browsers do not attach
  // headers to <a href> navigations or <img src> loads, so linking straight
  // to the endpoint returned {"error":"Not logged in"} in a new tab and
  // showed broken images. Fetch it WITH the header, then hand the browser a
  // blob it can render or save. Same approach as downloadFile() above.
  chatAttachmentBlob: async (id) => {
    const token = localStorage.getItem('cd_token');
    const res = await fetch(`${BASE}/chat/attachments/${id}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) {
      let message = `Could not open the file (${res.status})`;
      try { const d = await res.json(); if (d?.error) message = d.error; } catch { /* non-JSON */ }
      if (res.status === 401) message = 'Your session has expired — please sign in again.';
      if (res.status === 403) message = "You don't have access to this file.";
      throw new Error(message);
    }
    const blob = await res.blob();
    let filename = 'attachment';
    const disposition = res.headers.get('Content-Disposition') || '';
    const m = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition);
    if (m) filename = decodeURIComponent(m[1].trim());
    return { url: URL.createObjectURL(blob), filename, type: blob.type };
  },

  // Attachments need multipart, which req() cannot send (it sets a JSON
  // content-type, which would break the file boundary).
  chatSend: async (conversationId, { body, files = [], replyToId, ref } = {}) => {
    const token = localStorage.getItem('cd_token');
    if (!files.length) {
      return req('POST', `/chat/conversations/${conversationId}/messages`, {
        body, reply_to_id: replyToId || null,
        ref_module: ref?.module, ref_record_id: ref?.record_id, ref_label: ref?.label,
      });
    }
    const fd = new FormData();
    if (body) fd.append('body', body);
    if (replyToId) fd.append('reply_to_id', replyToId);
    if (ref?.module) { fd.append('ref_module', ref.module); fd.append('ref_record_id', ref.record_id); fd.append('ref_label', ref.label || ''); }
    for (const f of files) fd.append('files', f);
    const res = await fetch(`${BASE}/chat/conversations/${conversationId}/messages`, {
      method: 'POST', headers: token ? { Authorization: `Bearer ${token}` } : {}, body: fd,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Send failed (${res.status})`);
    return data;
  },

  chatBroadcast: async (userIds, { body, files = [] } = {}) => {
    const token = localStorage.getItem('cd_token');
    if (!files.length) return req('POST', '/chat/broadcast', { user_ids: userIds, body });
    const fd = new FormData();
    fd.append('user_ids', JSON.stringify(userIds));
    if (body) fd.append('body', body);
    for (const f of files) fd.append('files', f);
    const res = await fetch(`${BASE}/chat/broadcast`, {
      method: 'POST', headers: token ? { Authorization: `Bearer ${token}` } : {}, body: fd,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Broadcast failed (${res.status})`);
    return data;
  },
};
