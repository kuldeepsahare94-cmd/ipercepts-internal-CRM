/* ------------------------------------------------------------------
   Per-entity list KPIs (brief §9 summary strip, §10 entity-specific
   fields). Each module gets metrics that mean something for THAT
   business entity — deliberately not the same set copied everywhere.

   Every metric is computed from the records already loaded for the
   list, so this adds no extra request and can never show a number
   that disagrees with the table beneath it.
   ------------------------------------------------------------------ */

import {
  Building2, UserCheck, Target, Users, Mail, Phone, TrendingUp, Trophy, IndianRupee,
  FileText, CheckCircle2, Repeat, CalendarClock, LifeBuoy, AlertTriangle, CheckSquare,
  Clock, Package, Wallet, PhoneCall, Paperclip, Link2,
} from 'lucide-react';

const inr = (n) => `₹${Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
const count = (rows, fn) => rows.filter(fn).length;
const sum = (rows, fn, get) => rows.filter(fn).reduce((s, r) => s + (Number(get(r)) || 0), 0);
const isOpenStage = (r) => !r.is_won && !r.is_lost && !['Won', 'Lost', 'Closed'].includes(r.stage || r.status);
// The viewer's own calendar date, not UTC's — at 00:30 IST the UTC date is
// still yesterday, which would show today's tasks as not yet due.
const today = () => new Date().toLocaleDateString('en-CA');

export const LIST_KPIS = {
  // "Active" was near-duplicate of "Total accounts" in practice — almost
  // everything is Active — so it earned its slot poorly. Replaced with open
  // pipeline value, which is the number a sales manager actually opens this
  // page for. Computed from open_pipeline_value, which the accounts list
  // endpoint now returns per row.
  accounts: (rows) => [
    { label: 'Total accounts', icon: Building2, value: rows.length, tone: 'info' },
    { label: 'Customers', icon: UserCheck, value: count(rows, (r) => r.account_type === 'Customer'), tone: 'success',
      filter: (r) => r.account_type === 'Customer' },
    { label: 'Prospects', icon: Target, value: count(rows, (r) => r.account_type === 'Prospect'), tone: 'warning',
      filter: (r) => r.account_type === 'Prospect' },
    { label: 'Open pipeline', icon: IndianRupee, value: inr(sum(rows, () => true, (r) => r.open_pipeline_value)), tone: 'special' },
  ],
  contacts: (rows) => [
    { label: 'Total contacts', icon: Users, value: rows.length, tone: 'info' },
    { label: 'Active', icon: CheckCircle2, value: count(rows, (r) => r.contact_status === 'Active'), tone: 'success',
      filter: (r) => r.contact_status === 'Active' },
    { label: 'With email', icon: Mail, value: count(rows, (r) => r.email), tone: 'neutral' },
    { label: 'With phone', icon: Phone, value: count(rows, (r) => r.mobile || r.phone), tone: 'neutral' },
  ],
  opportunities: (rows) => [
    { label: 'Open deals', icon: TrendingUp, value: count(rows, isOpenStage), tone: 'info', filter: isOpenStage },
    { label: 'Open value', icon: IndianRupee, value: inr(sum(rows, isOpenStage, (r) => r.amount)), tone: 'special' },
    { label: 'Weighted', icon: Target, value: inr(rows.filter(isOpenStage).reduce((s, r) => s + (Number(r.amount) || 0) * ((r.probability ?? 0) / 100), 0)), tone: 'warning' },
    { label: 'Won', icon: Trophy, value: count(rows, (r) => r.is_won || r.stage === 'Won'), tone: 'success',
      filter: (r) => r.is_won || r.stage === 'Won' },
  ],
  quotations: (rows) => [
    { label: 'Total quotes', icon: FileText, value: rows.length, tone: 'info' },
    { label: 'Sent', icon: Mail, value: count(rows, (r) => r.status === 'Sent'), tone: 'warning',
      filter: (r) => r.status === 'Sent' },
    { label: 'Accepted', icon: CheckCircle2, value: count(rows, (r) => r.status === 'Accepted'), tone: 'success',
      filter: (r) => r.status === 'Accepted' },
    { label: 'Total value', icon: IndianRupee, value: inr(sum(rows, () => true, (r) => r.grand_total)), tone: 'special' },
  ],
  // A proforma is a request for payment that has not been accepted yet, so
  // what matters is how much is sitting unconverted, not how many exist.
  proforma_invoices: (rows) => [
    { label: 'Proformas', icon: FileText, value: rows.length, tone: 'info' },
    { label: 'Awaiting', icon: Clock,
      value: count(rows, (r) => !['Converted', 'Cancelled', 'Expired'].includes(r.status)), tone: 'warning',
      filter: (r) => !['Converted', 'Cancelled', 'Expired'].includes(r.status) },
    { label: 'Converted', icon: CheckCircle2, value: count(rows, (r) => r.status === 'Converted'), tone: 'success',
      filter: (r) => r.status === 'Converted' },
    { label: 'Value awaiting', icon: IndianRupee,
      value: inr(sum(rows, (r) => !['Converted', 'Cancelled', 'Expired'].includes(r.status), (r) => r.grand_total)),
      tone: 'special' },
  ],

  // For invoices the question is never "how many" — it is how much is owed
  // and how much of that is late. Overdue is derived from the due date rather
  // than the status, so it is right even before the nightly sweep has run.
  invoices: (rows) => {
    const live = (r) => !['Cancelled', 'Draft', 'Written Off'].includes(r.status);
    const overdue = (r) => live(r) && r.due_date && String(r.due_date).slice(0, 10) < today() && r.payment_status !== 'Paid';
    return [
      { label: 'Invoiced', icon: FileText, value: inr(sum(rows, live, (r) => r.grand_total)), tone: 'info' },
      { label: 'Collected', icon: Wallet, value: inr(sum(rows, live, (r) => r.amount_paid)), tone: 'success' },
      { label: 'Outstanding', icon: Clock, value: inr(sum(rows, live, (r) => r.balance_due)), tone: 'warning',
        filter: (r) => live(r) && r.payment_status !== 'Paid' },
      { label: 'Overdue', icon: AlertTriangle, value: inr(sum(rows, overdue, (r) => r.balance_due)), tone: 'danger',
        filter: overdue },
    ];
  },

  subscriptions: (rows) => {
    // Same definition as the dashboard's Renewals Due: an Active cycle that
    // has not been renewed, renewing between today and 30 days from now.
    const t = today();
    const in30 = new Date(Date.parse(`${t}T00:00:00Z`) + 30 * 86400000).toISOString().slice(0, 10);
    const renewalDue = (r) => r.status === 'Active' && !r.renewed_by_id && r.renewal_date
      && String(r.renewal_date).slice(0, 10) >= t && String(r.renewal_date).slice(0, 10) <= in30;
    const monthly = (r) => (Number(r.subscription_value) && Number(r.term_months)
      ? Number(r.subscription_value) / Number(r.term_months)
      : (Number(r.recurring_amount) || 0) / (r.billing_cycle === 'Yearly' ? 12 : r.billing_cycle === 'Quarterly' ? 3 : 1));
    return [
      { label: 'Subscriptions', icon: Repeat, value: rows.length, tone: 'info' },
      { label: 'Active', icon: CheckCircle2, value: count(rows, (r) => r.status === 'Active'), tone: 'success',
        filter: (r) => r.status === 'Active' },
      // Normalised to a monthly figure so cycles are comparable.
      { label: 'MRR', icon: IndianRupee, value: inr(rows.filter((r) => r.status === 'Active').reduce((s, r) => s + monthly(r), 0)), tone: 'success' },
      { label: 'Renewal due ≤30d', icon: CalendarClock, value: count(rows, renewalDue), tone: 'warning', filter: renewalDue },
    ];
  },
  tickets: (rows) => [
    { label: 'Total tickets', icon: LifeBuoy, value: rows.length, tone: 'info' },
    { label: 'Open', icon: AlertTriangle, value: count(rows, (r) => !['Resolved', 'Closed'].includes(r.status)), tone: 'warning',
      filter: (r) => !['Resolved', 'Closed'].includes(r.status) },
    { label: 'High / critical', icon: AlertTriangle, value: count(rows, (r) => ['High', 'Urgent', 'Critical'].includes(r.priority) && !['Resolved', 'Closed'].includes(r.status)), tone: 'danger',
      filter: (r) => ['High', 'Urgent', 'Critical'].includes(r.priority) && !['Resolved', 'Closed'].includes(r.status) },
    { label: 'Resolved', icon: CheckCircle2, value: count(rows, (r) => ['Resolved', 'Closed'].includes(r.status)), tone: 'success',
      filter: (r) => ['Resolved', 'Closed'].includes(r.status) },
  ],
  tasks: (rows) => [
    { label: 'Total tasks', icon: CheckSquare, value: rows.length, tone: 'info' },
    { label: 'Open', icon: AlertTriangle, value: count(rows, (r) => r.status !== 'Completed'), tone: 'warning',
      filter: (r) => r.status !== 'Completed' },
    { label: 'Overdue', icon: Clock, value: count(rows, (r) => r.status !== 'Completed' && r.due_date && String(r.due_date).slice(0, 10) < today()), tone: 'danger',
      filter: (r) => r.status !== 'Completed' && r.due_date && String(r.due_date).slice(0, 10) < today() },
    { label: 'Completed', icon: CheckCircle2, value: count(rows, (r) => r.status === 'Completed'), tone: 'success',
      filter: (r) => r.status === 'Completed' },
  ],
  products: (rows) => [
    { label: 'Products', icon: Package, value: rows.length, tone: 'info' },
    { label: 'Active', icon: CheckCircle2, value: count(rows, (r) => r.status === 'Active' || r.active), tone: 'success' },
  ],
  payments: (rows) => [
    { label: 'Payments', icon: Wallet, value: rows.length, tone: 'info' },
    { label: 'Collected', icon: IndianRupee, value: inr(sum(rows, (r) => r.status === 'Paid', (r) => r.amount)), tone: 'success' },
    { label: 'Pending', icon: Clock, value: count(rows, (r) => r.status === 'Pending'), tone: 'warning' },
  ],
  calls: (rows) => [
    { label: 'Calls', icon: PhoneCall, value: rows.length, tone: 'info' },
    { label: 'Connected', icon: CheckCircle2, value: count(rows, (r) => r.connected === 1), tone: 'success' },
  ],
  meetings: (rows) => [
    { label: 'Meetings', icon: CalendarClock, value: rows.length, tone: 'info' },
    { label: 'Upcoming', icon: Clock, value: count(rows, (r) => r.start_datetime && new Date(r.start_datetime) > new Date()), tone: 'warning' },
  ],
  documents: (rows) => [
    { label: 'Documents', icon: Paperclip, value: rows.length, tone: 'info' },
    { label: 'Files', icon: FileText, value: count(rows, (r) => r.file_name), tone: 'neutral' },
    { label: 'Links', icon: Link2, value: count(rows, (r) => r.external_url), tone: 'neutral' },
  ],
};

// Returns null for modules with no defined KPIs (including custom modules),
// so the strip is simply omitted rather than showing meaningless counters.
export function kpisFor(moduleApiName, rows) {
  const fn = LIST_KPIS[moduleApiName];
  if (!fn || rows.length === 0) return null;
  try { return fn(rows); } catch { return null; }
}
