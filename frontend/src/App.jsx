import { lazy } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider } from './context/AuthContext';
import { ThemeProvider } from './context/ThemeContext';
import ProtectedRoute from './components/ProtectedRoute';
import Layout from './components/Layout';

// Eager: these are needed for the very first paint (or to recover from a
// failed one), so code-splitting them would only add a round-trip.
import Login from './pages/Login';
import NotFound from './pages/NotFound';

// Everything else is split per route. Each page becomes its own chunk that
// is fetched the first time the user navigates to it, which keeps the
// initial bundle to the shell plus the landing page. <Suspense> lives
// inside Layout (around <Outlet/>), so the sidebar and header stay on
// screen while a chunk loads instead of the whole app blanking.
const Dashboard = lazy(() => import('./pages/Dashboard'));
const Leads = lazy(() => import('./pages/Leads'));
const LeadDetail = lazy(() => import('./pages/LeadDetail'));
const Payments = lazy(() => import('./pages/Payments'));
const Reports = lazy(() => import('./pages/Reports'));
const CalendarPage = lazy(() => import('./pages/Calendar'));
const TeamChat = lazy(() => import('./pages/TeamChat'));
const ExtensionScreen = lazy(() => import('./extensions/ExtensionScreen'));
const SettingsCalendar = lazy(() => import('./pages/SettingsCalendar'));
const Roles = lazy(() => import('./pages/Roles'));
const Users = lazy(() => import('./pages/Users'));
const Settings = lazy(() => import('./pages/Settings'));
const SettingsModules = lazy(() => import('./pages/SettingsModules'));
const FieldLayoutManager = lazy(() => import('./pages/FieldLayoutManager'));
const SettingsWorkflows = lazy(() => import('./pages/SettingsWorkflows'));
const SettingsPipelines = lazy(() => import('./pages/SettingsPipelines'));
const SettingsTeams = lazy(() => import('./pages/SettingsTeams'));
const SettingsData = lazy(() => import('./pages/SettingsData'));
const SettingsFinance = lazy(() => import('./pages/SettingsFinance'));
const SettingsCompany = lazy(() => import('./pages/SettingsCompany'));
const SettingsTemplates = lazy(() => import('./pages/SettingsTemplates'));
const SettingsTemplateLibrary = lazy(() => import('./pages/SettingsTemplateLibrary'));
const CallReports = lazy(() => import('./pages/CallReports'));
const Customer360 = lazy(() => import('./pages/Customer360'));
const SettingsEmail = lazy(() => import('./pages/SettingsEmail'));
const Inbox = lazy(() => import('./pages/Inbox'));
const EmailCampaigns = lazy(() => import('./pages/EmailCampaigns'));
const Appearance = lazy(() => import('./pages/Appearance'));
const WhatsAppIntegrations = lazy(() => import('./pages/WhatsAppIntegrations'));
const WhatsAppTemplates = lazy(() => import('./pages/WhatsAppTemplates'));
const WhatsAppWorkflows = lazy(() => import('./pages/WhatsAppWorkflows'));
const WhatsAppCampaigns = lazy(() => import('./pages/WhatsAppCampaigns'));
const WhatsAppInbox = lazy(() => import('./pages/WhatsAppInbox'));
const WhatsAppAnalytics = lazy(() => import('./pages/WhatsAppAnalytics'));
const LeadSources = lazy(() => import('./pages/LeadSources'));
const UniversalList = lazy(() => import('./pages/universal/UniversalList'));
const UniversalDetail = lazy(() => import('./pages/universal/UniversalDetail'));
const UniversalKanban = lazy(() => import('./pages/universal/UniversalKanban'));

export default function App() {
  return (
    <AuthProvider>
      <ThemeProvider>
        <BrowserRouter>
          <Routes>
            <Route path="/login" element={<Login />} />
            <Route element={<ProtectedRoute><Layout /></ProtectedRoute>}>
              <Route path="/" element={<Dashboard />} />
              {/* Common aliases — these previously matched nothing and
                  rendered a blank page. */}
              <Route path="/dashboard" element={<Navigate to="/" replace />} />
              <Route path="/accounts" element={<Navigate to="/records/accounts" replace />} />
              <Route path="/customers" element={<Navigate to="/records/accounts" replace />} />
              <Route path="/contacts" element={<Navigate to="/records/contacts" replace />} />
              <Route path="/opportunities" element={<Navigate to="/records/opportunities" replace />} />
              <Route path="/deals" element={<Navigate to="/records/opportunities" replace />} />
              <Route path="/quotations" element={<Navigate to="/records/quotations" replace />} />
              <Route path="/subscriptions" element={<Navigate to="/records/subscriptions" replace />} />
              <Route path="/tickets" element={<Navigate to="/records/tickets" replace />} />
              <Route path="/tasks" element={<Navigate to="/records/tasks" replace />} />
              <Route path="/leads" element={<Leads />} />
              <Route path="/leads/:id" element={<LeadDetail />} />
              <Route path="/payments" element={<Payments />} />
              <Route path="/payments/:id" element={<Payments />} />
              <Route path="/reports" element={<Reports />} />
              <Route path="/call-reports" element={<CallReports />} />
              <Route path="/customer-360/:id" element={<Customer360 />} />
              <Route path="/roles" element={<Roles />} />
              <Route path="/users" element={<Users />} />
              <Route path="/settings" element={<Settings />} />
              <Route path="/settings/modules" element={<SettingsModules />} />
              <Route path="/settings/layout" element={<FieldLayoutManager />} />
              <Route path="/settings/workflows" element={<SettingsWorkflows />} />
              <Route path="/settings/pipelines" element={<SettingsPipelines />} />
              <Route path="/settings/teams" element={<SettingsTeams />} />
              <Route path="/settings/data" element={<SettingsData />} />
              <Route path="/settings/finance" element={<SettingsFinance />} />
              <Route path="/settings/company" element={<SettingsCompany />} />
              <Route path="/settings/templates" element={<SettingsTemplates />} />
              <Route path="/settings/template-library" element={<SettingsTemplateLibrary />} />
              <Route path="/settings/email" element={<SettingsEmail />} />
              <Route path="/inbox" element={<Inbox />} />
              <Route path="/email-campaigns" element={<EmailCampaigns />} />
              <Route path="/appearance" element={<Appearance />} />
              <Route path="/whatsapp" element={<WhatsAppIntegrations />} />
              <Route path="/whatsapp/templates" element={<WhatsAppTemplates />} />
              <Route path="/whatsapp/workflows" element={<WhatsAppWorkflows />} />
              <Route path="/whatsapp/campaigns" element={<WhatsAppCampaigns />} />
              <Route path="/whatsapp/inbox" element={<WhatsAppInbox />} />
              <Route path="/whatsapp/inbox/:id" element={<WhatsAppInbox />} />
              <Route path="/whatsapp/analytics" element={<WhatsAppAnalytics />} />
              <Route path="/lead-sources" element={<LeadSources />} />
              {/* Universal CRM modules (Accounts, Contacts, Opportunities, Quotations,
                  Products, Subscriptions, Tickets, and any admin-created custom module)
                  all share these three routes, driven by module/field metadata. */}
              <Route path="/records/:moduleApiName" element={<UniversalList />} />
              <Route path="/records/:moduleApiName/kanban" element={<UniversalKanban />} />
              <Route path="/records/:moduleApiName/:id" element={<UniversalDetail />} />
              {/* Catch-all: without this, any unmatched path renders an
                  empty tree, which looks identical to a crashed app. */}
              <Route path="/calendar" element={<CalendarPage />} />
              <Route path="/chat" element={<TeamChat />} />
          {/* Screens from features built for this customer only. One route
              serves them all; which exist is decided at runtime by what is
              installed on this customer's server. */}
          <Route path="/x/:route" element={<ExtensionScreen />} />
          <Route path="/settings/calendar" element={<SettingsCalendar />} />
          <Route path="*" element={<NotFound />} />
            </Route>
          </Routes>
        </BrowserRouter>
      </ThemeProvider>
    </AuthProvider>
  );
}
