const express = require('express');
const cors = require('cors');
require('dotenv').config();
const { requireAuth } = require('./middleware/auth');

// ---- Universal CRM metadata layer (Phases 1–8) — must load before any
// route below that touches modules/fields/accounts/contacts/opportunities/
// quotations/products/subscriptions/tickets, since these files create the
// tables and seed data those routes depend on. ----
require('./db-metadata');
require('./db-phase2');
require('./db-phase3-fields');
require('./db-phase12-activities');
require('./db-phase16-workflows');
require('./db-phase21-generalize');
require('./db-phase24-teams-docs');
require('./db-phase26-taxes-currencies');
require('./db-phase27-call-disposition');
require('./db-phase28-email-accounts');
require('./db-phase29-inbound-email');
require('./db-phase30-email-campaigns');
require('./db-phase31-email-diagnostics');
require('./db-phase32-quotation-discount');
require('./db-phase33-wa-quick-templates');
require('./db-phase34-lead-company');
require('./db-phase35-chat');
require('./db-phase36-reports');
require('./db-phase37-calendar');
require('./db-phase38-numbering');
require('./db-phase39-documents');
require('./db-phase40-template-library');
require('./db-phase41-online-meetings');
require('./db-phase42-security-access');
require('./db-phase43-permission-completeness');
require('./db-phase44-subscriptions-amc');
require('./db-phase45-list-tools');

const app = express();

// Render (and most PaaS hosts) put exactly one reverse proxy in front of
// this app. Without this, req.ip resolves to THAT proxy's internal address,
// not the visitor's real IP — which would make IP-based access control
// (backend/services/accessControl.js) check the wrong address entirely.
// '1' tells Express to trust exactly one hop's X-Forwarded-For entry (the
// nearest one, which is the proxy Render itself controls) rather than
// blindly trusting an arbitrary number of attacker-supplied hops.
app.set('trust proxy', 1);

// Universal lead capture — PUBLIC, called cross-origin from arbitrary customer
// websites, so it needs its OWN permissive CORS and must be registered
// BEFORE the restrictive global cors() below — otherwise that global rule
// (locked to FRONTEND_URL) would block every third-party site's browser
// requests before they ever reach this route.
app.use('/api/capture', cors(), express.json(), require('./routes/leadCapture'));

// In production, set FRONTEND_URL to your Vercel URL (e.g. https://your-crm.vercel.app)
// so only your deployed frontend can call this API. Left open (*) if unset, for local dev.
app.use(cors({ origin: process.env.FRONTEND_URL || '*' }));

// WhatsApp webhook receiver — PUBLIC (providers can't send our JWT) and needs
// the raw request body for signature verification, so it's registered here,
// before the global JSON parser below. Route handlers respond directly and
// never call next(), so express.json() never touches these requests.
app.use('/api/whatsapp/webhook', express.raw({ type: '*/*', limit: '2mb' }), require('./routes/whatsappWebhook'));

// Facebook/Instagram Lead Ads webhook — same reasoning as the WhatsApp one:
// public, needs the raw body for Meta's HMAC signature check, must be
// registered before the global JSON parser.
app.use('/api/social-leads', express.raw({ type: '*/*', limit: '1mb' }), require('./routes/leadSourcesSocial'));

app.use(express.json());

// Public routes
app.use('/api/auth', require('./routes/auth'));
app.get('/api/health', (req, res) => res.json({ ok: true }));

// Required-field enforcement runs before every record route, so a field
// marked mandatory in Settings is actually enforced on save — previously
// the flag was stored and displayed but never checked, so a record could
// be created with every required field blank.
const { enforceRequiredFields } = require('./middleware/requiredFields');
app.use('/api', enforceRequiredFields);

// Everything below requires a valid, active login
app.use('/api/leads', requireAuth, require('./routes/leads'));
app.use('/api/payments', requireAuth, require('./routes/payments'));
app.use('/api/dashboard', requireAuth, require('./routes/dashboard'));
app.use('/api/reports', requireAuth, require('./routes/reports'));
app.use('/api/notifications', requireAuth, require('./routes/notifications'));
app.use('/api/chat', requireAuth, require('./routes/chat'));

// Calendar is mounted with one exception to the login requirement: the OAuth
// callback. Google and Microsoft redirect the user's BROWSER to it, and a
// browser redirect carries no Authorization header, so requiring a token here
// would make it impossible to ever complete a connection. The callback is not
// unprotected — it authenticates the signed `state` parameter it was issued
// with (see routes/calendar.js), which also prevents anyone from attaching
// their calendar account to someone else's CRM user.
app.use('/api/calendar', (req, res, next) => (
  req.path.startsWith('/callback/') ? next() : requireAuth(req, res, next)
), require('./routes/calendar'));
app.use('/api/roles', requireAuth, require('./routes/roles'));
app.use('/api/security', requireAuth, require('./routes/security'));
app.use('/api/users', requireAuth, require('./routes/users'));
app.use('/api/settings', requireAuth, require('./routes/settings'));
app.use('/api/assistant', requireAuth, require('./routes/assistant'));
app.use('/api/dev', requireAuth, require('./routes/dev'));
app.use('/api/whatsapp', requireAuth, require('./routes/whatsapp'));
app.use('/api/whatsapp', requireAuth, require('./routes/whatsappWorkflows'));
app.use('/api/whatsapp', requireAuth, require('./routes/whatsappCampaigns'));
app.use('/api/whatsapp', requireAuth, require('./routes/whatsappConversations'));
app.use('/api/whatsapp', requireAuth, require('./routes/whatsappAnalytics'));
app.use('/api/lead-sources', require('./routes/leadSourcesFacebookOAuth')); // own per-route auth — /facebook/callback must stay public, so this must be mounted BEFORE the blanket-requireAuth router below
app.use('/api/lead-sources', requireAuth, require('./routes/leadSources'));
app.use('/api/backup', requireAuth, require('./routes/backup'));

// ---- Universal CRM (Phases 1–8) ----
// Metadata layer: module + field registry, generic relationships, and CRUD
// for admin-created custom modules that have no dedicated table yet.
app.use('/api/modules', requireAuth, require('./routes/modules'));
app.use('/api/modules', requireAuth, require('./routes/fields'));
app.use('/api/modules', requireAuth, require('./routes/layouts'));
app.use('/api/relationships', requireAuth, require('./routes/relationships'));
app.use('/api/records', requireAuth, require('./routes/customRecords'));
// Core modules with their own real tables + dedicated routes.
app.use('/api/accounts', requireAuth, require('./routes/accounts'));
app.use('/api/contacts', requireAuth, require('./routes/contacts'));
app.use('/api/opportunities', requireAuth, require('./routes/opportunities'));
app.use('/api/products', requireAuth, require('./routes/products'));
app.use('/api/quotations', requireAuth, require('./routes/quotations'));
app.use('/api/document-numbering', requireAuth, require('./routes/documentNumbering'));
// Proforma Invoices and Invoices: the same router built twice, because they
// are the same document with different wording. See routes/documents.factory.js.
const documentRouter = require('./routes/documents.factory');
const proformaRouter = documentRouter({ docType: 'proforma', permission: 'proforma_invoices' });
// Mounted under BOTH spellings on purpose. The universal record UI builds its
// URL straight from the module's api_name, which is `proforma_invoices` with
// an underscore; a hyphenated mount alone gave every proforma page a 404.
// The hyphenated path is the readable one and stays as an alias.
app.use('/api/proforma_invoices', requireAuth, proformaRouter);
app.use('/api/proforma-invoices', requireAuth, proformaRouter);
app.use('/api/invoices', requireAuth, documentRouter({ docType: 'invoice', permission: 'invoices' }));
app.use('/api/document-templates', requireAuth, require('./routes/documentTemplates'));
app.use('/api/company-profile', requireAuth, require('./routes/companyProfile'));
app.use('/api/subscriptions', requireAuth, require('./routes/subscriptions'));
app.use('/api/tickets', requireAuth, require('./routes/tickets'));
app.use('/api/calls', requireAuth, require('./routes/callDisposition'));
app.use('/api/calls', requireAuth, require('./routes/calls'));
app.use('/api/meetings', requireAuth, require('./routes/meetings'));
app.use('/api/tasks', requireAuth, require('./routes/tasks'));
app.use('/api/notes', requireAuth, require('./routes/notes'));
app.use('/api/emails', requireAuth, require('./routes/emails'));
app.use('/api/activities', requireAuth, require('./routes/activities'));
app.use('/api/search', requireAuth, require('./routes/search'));
app.use('/api/workflows', requireAuth, require('./routes/workflows'));
app.use('/api/pipelines', requireAuth, require('./routes/pipelines'));
app.use('/api/teams', requireAuth, require('./routes/teams'));
app.use('/api/documents', requireAuth, require('./routes/documents'));
app.use('/api/admin', requireAuth, require('./routes/admin'));
app.use('/api/finance', requireAuth, require('./routes/finance'));
app.use('/api/c360', requireAuth, require('./routes/customer360'));
app.use('/api/email-settings', requireAuth, require('./routes/emailSettings'));
app.use('/api/wa-quick-templates', requireAuth, require('./routes/waQuickTemplates'));
app.use('/api/inbox', requireAuth, require('./routes/inbox'));
// Public: hit by recipients' mail clients, which have no CRM session.
app.use('/api/track', require('./routes/tracking'));
app.use('/api/email-campaigns', requireAuth, require('./routes/emailCampaigns'));
app.use('/api/ai-actions', requireAuth, require('./routes/aiActions'));
app.use('/api/saved-filters', requireAuth, require('./routes/savedFilters'));

// ---------------------------------------------------------------------------
// Per-customer extensions — features built for ONE customer.
// ---------------------------------------------------------------------------
// Loaded last, on purpose: an extension adds to the CRM and can never shadow a
// core route, so upgrading the core cannot silently change a customer's
// bespoke behaviour. Bespoke code lives beside that customer's DATA, not in
// this shared tree, which is what lets a core fix be deployed once and reach
// every customer — including the heavily customised ones.
//
// See services/extensions.js for the contract and why it is shaped this way.
const extensions = require('./services/extensions');
extensions.load(app);

// A read-only view of what this instance has loaded, so "which bespoke
// features does this customer have?" is answerable without an SSH session.
app.get('/api/extensions', requireAuth, (req, res) => res.json(extensions.status()));

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`Placement CRM API running on port ${PORT}`);
  // Background inbound-mail polling. Failure here must never stop the API
  // from serving — it's an optional feature.
  try {
    require('./services/inboundEmail').startPolling();
    require('./services/emailCampaignEngine').startScheduler();
  } catch (e) {
    console.warn('Inbound email polling not started:', e.message);
  }

  // Overdue is a fact about today, not a state anyone sets, so invoices that
  // passed their due date overnight are swept into Overdue on boot and once
  // an hour after. Without this, a workflow or report filtering on status
  // would disagree with what the list plainly shows.
  const sweepOverdue = () => {
    try {
      const changed = require('./services/documentService').markOverdue();
      if (changed) console.log(`[invoices] ${changed} invoice(s) marked overdue`);
    } catch (e) {
      console.warn('[invoices] overdue sweep failed:', e.message);
    }
  };
  sweepOverdue();
  setInterval(sweepOverdue, 60 * 60 * 1000).unref();
});
