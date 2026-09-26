// ============================================================================
// Demo data — a whole CRM that looks like it has been in use for a year.
// ============================================================================
// This is what sits behind Settings → Load Demo Data. It exists for showing
// the product to someone, so the bar it has to clear is not "every table has
// rows" but "every screen a prospect might click on has something worth
// looking at, and every number on it is arithmetically true".
//
// Three things that seem like detail but decide whether a demo lands:
//
//   * Activities are attached to records. Calls, meetings, tasks, notes and
//     emails all carry related_module + related_record_id. An account with a
//     twelve-month history and an empty Activities tab is the single most
//     obvious tell that a demo is staged, and it was exactly what the old
//     seeder produced — 420 calls, every one of them related to nothing.
//
//   * Money is calculated, never typed. Proformas and invoices are created
//     through documentService and paid through documentPayments, the same
//     code paths the UI uses. So the GST split, the rounding, the balance and
//     the document numbering are all real. If a prospect adds a line to a
//     seeded invoice, the total moves the way it should.
//
//   * The spread is deliberate. Invoices are paid, part-paid, unpaid and
//     overdue in realistic proportions; deals are won, lost and open; tickets
//     breach SLA sometimes. Reports with one tall bar and eleven empty ones
//     demo worse than no reports.
//
// Everything written here is tagged, and wipe() removes exactly what seed()
// created. Records a real user made are never touched.
// ============================================================================

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const db = require('../db');
const documentService = require('./documentService');
const documentPayments = require('./documentPayments');

const TAG = '[demo]';

// How many of each to make. Every module a prospect can open in the sidebar
// clears 30 comfortably; the busier ones are higher because reports that
// group by month need enough rows to put something in each bucket.
const VOLUME = {
  users: 4,
  products: 32,
  accounts: 42,
  leads: 130,
  opportunities: 85,
  quotations: 64,
  proformas: 40,
  invoices: 66,
  looseP: 70,
  subscriptions: 40,
  tickets: 60,
  calls: 320,
  meetings: 150,
  tasks: 190,
  notes: 120,
  emails: 240,
  documents: 40,
};

// How many activity slots each kind of record is guaranteed. Accounts and
// deals are what someone opens during a demo, so they get a real history
// rather than the one-or-two a uniform scatter would leave them with.
const ACTIVITY_WEIGHT = { accounts: 7, opportunities: 4, contacts: 2, leads: 1 };

// Roughly 15 months of history. Long enough that a "last 12 months" report
// has a full twelve buckets and the edges are not cut off.
const HISTORY_DAYS = 450;

// ---------------------------------------------------------------------------
// Deterministic randomness
// ---------------------------------------------------------------------------
// Seeded, so two people loading demo data see the same CRM and a bug found in
// a demo can be reproduced. Reset at the start of every run.

let seedState = 20260919;
function resetRandom() { seedState = 20260919; }
function rnd() { seedState = (seedState * 1103515245 + 12345) % 2147483648; return seedState / 2147483648; }
function pick(arr) { return arr[Math.floor(rnd() * arr.length)]; }
function int(min, max) { return Math.floor(rnd() * (max - min + 1)) + min; }
function chance(p) { return rnd() < p; }
function shuffle(arr) {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rnd() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function stamp(daysBack, hour) {
  const d = new Date();
  d.setDate(d.getDate() - daysBack);
  if (hour !== undefined) d.setHours(hour, int(0, 59), 0, 0);
  return d.toISOString().slice(0, 19).replace('T', ' ');
}
function day(daysBack) { return stamp(daysBack).slice(0, 10); }
function plusHours(from, hours) {
  const d = new Date(`${from.replace(' ', 'T')}Z`);
  d.setHours(d.getHours() + hours);
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

// A date weighted towards the recent past. Real pipelines are busier this
// month than they were fourteen months ago, and a flat distribution makes
// every trend chart look like a ruler.
function weightedDay() {
  const r = rnd();
  return Math.floor(HISTORY_DAYS * r * r);
}

// ---------------------------------------------------------------------------
// Reference data
// ---------------------------------------------------------------------------

const INDUSTRIES = ['Education', 'Manufacturing', 'IT Services', 'Healthcare', 'Retail',
  'Logistics', 'Finance', 'Real Estate', 'Hospitality', 'Pharma'];
const SOURCES = ['Website', 'Referral', 'Facebook Ads', 'Google Ads', 'Cold Call',
  'Exhibition', 'Partner', 'LinkedIn', 'Walk-in'];
const CAMPAIGNS = ['Q1 Webinar', 'Diwali Offer', 'LinkedIn Outreach', 'Trade Show Mumbai',
  'Email Nurture', 'New Year Promo', 'Education Expo'];
const RATINGS = ['Hot', 'Warm', 'Cold'];
const LEAD_STATUSES = ['New', 'Contacted', 'Qualified', 'Demo Done', 'Proposal Sent', 'Negotiation', 'Lost'];
const MODES = ['UPI', 'Bank Transfer', 'Cheque', 'Cash', 'Card'];
const TICKET_CATEGORIES = ['Billing', 'Technical', 'Onboarding', 'Feature Request', 'Data Import', 'Training'];
const PRIORITIES = ['Low', 'Medium', 'High', 'Critical'];
const LOSS_REASONS = ['Price too high', 'Chose competitor', 'No budget', 'No decision taken', 'Bad timing', 'Lost to in-house build'];

// State code drives CGST+SGST versus IGST. A demo that only ever shows one of
// the two is not showing GST handling at all, so accounts are spread across
// states on purpose — roughly half in-state, matching a regional business.
const PLACES = [
  ['27', 'Maharashtra', 'Nagpur'], ['27', 'Maharashtra', 'Pune'], ['27', 'Maharashtra', 'Mumbai'],
  ['27', 'Maharashtra', 'Nashik'], ['27', 'Maharashtra', 'Amravati'],
  ['29', 'Karnataka', 'Bengaluru'], ['36', 'Telangana', 'Hyderabad'],
  ['07', 'Delhi', 'New Delhi'], ['24', 'Gujarat', 'Ahmedabad'], ['33', 'Tamil Nadu', 'Chennai'],
  ['23', 'Madhya Pradesh', 'Indore'], ['08', 'Rajasthan', 'Jaipur'],
  ['19', 'West Bengal', 'Kolkata'], ['03', 'Punjab', 'Ludhiana'],
];

const COMPANY_BASES = ['Sunrise', 'Vertex', 'Blue Orbit', 'Sharma', 'Greenfield', 'Nova', 'Pinnacle',
  'Kumar', 'Orion', 'Silverline', 'Deccan', 'Everest', 'Lotus', 'Vega', 'Summit', 'Crestwood',
  'Aurora', 'Meridian', 'Northwind', 'Solstice', 'Ironbridge', 'Cedar', 'Trident', 'Harbour',
  'Skyline', 'Granite', 'Falcon', 'Maple', 'Quantum', 'Rivermist', 'Ashford', 'Bluestone',
  'Cobalt', 'Emerald', 'Frontier', 'Galaxy', 'Heritage', 'Indus', 'Jubilee', 'Kinetic',
  'Landmark', 'Monarch'];
const COMPANY_SUFFIXES = ['Technologies', 'Industries', 'Solutions', 'Enterprises', 'Systems',
  'Group', 'Academy', 'Institute', 'Services', 'Labs'];

const FIRST_NAMES = ['Rahul', 'Priya', 'Amit', 'Sneha', 'Vikram', 'Anita', 'Rajesh', 'Meera',
  'Arjun', 'Kavita', 'Deepak', 'Neha', 'Sanjay', 'Pooja', 'Manish', 'Divya', 'Karan', 'Shreya',
  'Nitin', 'Anjali', 'Suresh', 'Ritu', 'Gaurav', 'Swati'];
const LAST_NAMES = ['Sharma', 'Patel', 'Reddy', 'Nair', 'Joshi', 'Desai', 'Kulkarni', 'Iyer',
  'Verma', 'Gupta', 'Singh', 'Mehta', 'Rao', 'Bose', 'Chopra', 'Malhotra'];
const JOB_TITLES = ['Director', 'IT Manager', 'Owner', 'Operations Head', 'Finance Manager',
  'Principal', 'Managing Director', 'Purchase Head', 'Academic Head', 'Centre Manager'];

// ---------------------------------------------------------------------------
// Catalogue
// ---------------------------------------------------------------------------
// Real SAC codes for software and training services, because an Indian
// invoice with a blank HSN/SAC column is the first thing a buyer's accountant
// points at.

const CATALOGUE = [
  ['CRM Professional Licence', 'Software', 'Product', 45000, '997331', 'Licence', 18, 0, null],
  ['CRM Enterprise Licence', 'Software', 'Product', 180000, '997331', 'Licence', 18, 0, null],
  ['CRM Starter Licence', 'Software', 'Product', 18000, '997331', 'Licence', 18, 0, null],
  ['Institute ERP — Single Branch', 'Software', 'Product', 35000, '997331', 'Licence', 18, 0, null],
  ['Institute ERP — Multi Branch', 'Software', 'Product', 90000, '997331', 'Licence', 18, 0, null],
  ['Student Portal Module', 'Software', 'Product', 25000, '997331', 'Module', 18, 0, null],
  ['Parent App Module', 'Software', 'Product', 20000, '997331', 'Module', 18, 0, null],
  ['Test Generator Add-on', 'Software', 'Product', 30000, '997331', 'Module', 18, 0, null],
  ['Attendance & Biometric Sync', 'Software', 'Product', 22000, '997331', 'Module', 18, 0, null],
  ['Fee Management Module', 'Software', 'Product', 28000, '997331', 'Module', 18, 0, null],
  ['Implementation & Setup', 'Services', 'Service', 60000, '998314', 'Project', 18, 0, null],
  ['Data Migration', 'Services', 'Service', 25000, '998314', 'Project', 18, 0, null],
  ['Onsite Training (2 days)', 'Services', 'Service', 30000, '999293', 'Days', 18, 0, null],
  ['Online Training (per session)', 'Services', 'Service', 6000, '999293', 'Session', 18, 0, null],
  ['Custom Report Development', 'Services', 'Service', 18000, '998314', 'Report', 18, 0, null],
  ['API Integration', 'Services', 'Service', 40000, '998314', 'Project', 18, 0, null],
  ['Website Integration', 'Services', 'Service', 15000, '998314', 'Project', 18, 0, null],
  ['Whitelabel Branding', 'Services', 'Service', 50000, '998314', 'Project', 18, 0, null],
  ['Annual Support Plan — Basic', 'Support', 'Service', 36000, '998313', 'Year', 18, 1, 'Annual'],
  ['Annual Support Plan — Premium', 'Support', 'Service', 72000, '998313', 'Year', 18, 1, 'Annual'],
  ['Monthly Support Retainer', 'Support', 'Service', 8000, '998313', 'Month', 18, 1, 'Monthly'],
  ['Priority Support Upgrade', 'Support', 'Service', 24000, '998313', 'Year', 18, 1, 'Annual'],
  ['Cloud Hosting — Standard', 'Hosting', 'Service', 24000, '998315', 'Year', 18, 1, 'Annual'],
  ['Cloud Hosting — Dedicated', 'Hosting', 'Service', 96000, '998315', 'Year', 18, 1, 'Annual'],
  ['Extra Storage 100 GB', 'Hosting', 'Service', 6000, '998315', 'Year', 18, 1, 'Annual'],
  ['SMS Credits (10,000)', 'Add-on', 'Product', 9000, '998412', 'Pack', 18, 0, null],
  ['WhatsApp Business Credits', 'Add-on', 'Product', 12000, '998412', 'Pack', 18, 0, null],
  ['Additional User Licence', 'Add-on', 'Product', 4500, '997331', 'User', 18, 0, null],
  ['Biometric Device', 'Hardware', 'Product', 14000, '84714900', 'Unit', 18, 0, null],
  ['ID Card Printer', 'Hardware', 'Product', 32000, '84433250', 'Unit', 18, 0, null],
  ['Barcode Scanner', 'Hardware', 'Product', 3500, '84716060', 'Unit', 18, 0, null],
  ['Books & Study Material Kit', 'Content', 'Product', 2500, '49011010', 'Kit', 5, 0, null],
];

// ---------------------------------------------------------------------------
// Wipe
// ---------------------------------------------------------------------------
// Ordered children-before-parents. Each statement matches on the tagged text
// column of its own table rather than on a date or an id range, so a row a
// real user created can never be caught by it.

const WIPE_STATEMENTS = [
  ['payments', "DELETE FROM payments WHERE remarks LIKE ?"],
  ['sales_document_items', "DELETE FROM sales_document_items WHERE document_id IN (SELECT id FROM sales_documents WHERE notes LIKE ?)"],
  ['sales_documents', "DELETE FROM sales_documents WHERE notes LIKE ?"],
  ['quotation_items', "DELETE FROM quotation_items WHERE quotation_id IN (SELECT id FROM quotations WHERE notes LIKE ?)"],
  ['quotations', "DELETE FROM quotations WHERE notes LIKE ?"],
  ['payments', "DELETE FROM payments WHERE subscription_id IN (SELECT id FROM subscriptions WHERE notes LIKE ?)"],
  ['subscription_payments', "DELETE FROM subscription_payments WHERE subscription_id IN (SELECT id FROM subscriptions WHERE notes LIKE ?)"],
  ['subscriptions (unlink)', "UPDATE subscriptions SET renewed_by_id=NULL, parent_subscription_id=NULL WHERE notes LIKE ?"],
  ['subscriptions', "DELETE FROM subscriptions WHERE notes LIKE ?"],
  ['ticket_replies', "DELETE FROM ticket_replies WHERE ticket_id IN (SELECT id FROM tickets WHERE description LIKE ?)"],
  ['incident_updates', "DELETE FROM incident_updates WHERE incident_id IN (SELECT id FROM major_incidents WHERE impact LIKE ?)"],
  ['major_incidents', "DELETE FROM major_incidents WHERE impact LIKE ?"],
  ['problems', "DELETE FROM problems WHERE root_cause LIKE ?"],
  ['kb_articles', "DELETE FROM kb_articles WHERE body LIKE ?"],
  ['service_catalog', "DELETE FROM service_catalog_items WHERE description LIKE ?"],
  ['assets', "DELETE FROM assets WHERE notes LIKE ?"],
  ['tickets', "DELETE FROM tickets WHERE description LIKE ?"],
  ['teams', "DELETE FROM teams WHERE description LIKE ?"],
  ['lead_activities', "DELETE FROM lead_activities WHERE note LIKE ?"],
  ['calls', "DELETE FROM calls WHERE notes LIKE ?"],
  ['meetings', "DELETE FROM meetings WHERE agenda LIKE ?"],
  ['tasks', "DELETE FROM tasks WHERE description LIKE ?"],
  ['notes', "DELETE FROM notes WHERE body LIKE ?"],
  ['emails', "DELETE FROM emails WHERE body LIKE ?"],
  ['documents', "DELETE FROM documents WHERE description LIKE ?"],
  ['leads', "DELETE FROM leads WHERE remarks LIKE ?"],
  // leads.converted_opportunity_id and converted_account_id are NO ACTION, so
  // a lead still pointing at a demo deal blocks its deletion. Demo leads are
  // gone by now, but a real lead converted against a demo account during a
  // trial would otherwise wedge the wipe — release those pointers instead of
  // deleting somebody's real lead.
  ['leads (unlink)', `UPDATE leads SET converted_opportunity_id=NULL
      WHERE converted_opportunity_id IN (SELECT id FROM opportunities WHERE description LIKE ?)`],
  ['leads (unlink)', `UPDATE leads SET converted_account_id=NULL
      WHERE converted_account_id IN (SELECT id FROM accounts WHERE description LIKE ?)`],
  ['opportunity_stage_history', "DELETE FROM opportunity_stage_history WHERE opportunity_id IN (SELECT id FROM opportunities WHERE description LIKE ?)"],
  ['opportunities', "DELETE FROM opportunities WHERE description LIKE ?"],
  ['contacts', "DELETE FROM contacts WHERE notes LIKE ?"],
  ['accounts', "DELETE FROM accounts WHERE description LIKE ?"],
  ['products', "DELETE FROM products WHERE description LIKE ?"],
  ['users', "DELETE FROM users WHERE username LIKE 'demo.%'"],
];

function wipe() {
  const counts = {};
  const run = db.transaction(() => {
    for (const [name, sql] of WIPE_STATEMENTS) {
      try {
        const info = sql.includes('?') ? db.prepare(sql).run(`%${TAG}%`) : db.prepare(sql).run();
        if (info.changes) counts[name] = (counts[name] || 0) + info.changes;
      } catch (err) {
        // A table that does not exist on this instance is not an error worth
        // failing the whole wipe for — it simply has nothing to remove.
        if (!/no such table|no such column/.test(err.message)) throw err;
      }
    }
  });
  run();
  return counts;
}

function hasDemoData() {
  const row = db.prepare("SELECT COUNT(*) c FROM accounts WHERE description LIKE ?").get(`%${TAG}%`);
  return row.c > 0;
}

// ---------------------------------------------------------------------------
// Seed
// ---------------------------------------------------------------------------

function seed() {
  resetRandom();
  const counts = {};
  const add = (key, n = 1) => { counts[key] = (counts[key] || 0) + n; };

  // --- people who own the records ------------------------------------------
  // Owner-based reports (leaderboards, workload, win rate by rep) need more
  // than one name to say anything. These accounts cannot be logged into: the
  // password is random bytes nobody holds, since a demo login with a guessable
  // password on a live instance is a genuine way in.
  const realUsers = db.prepare('SELECT id, COALESCE(full_name, username) AS name FROM users WHERE active=1').all();
  if (!realUsers.length) throw new Error('Create at least one user before loading demo data.');

  const demoUserDefs = [
    ['demo.rohit', 'Rohit Deshmukh'], ['demo.sana', 'Sana Shaikh'],
    ['demo.vivek', 'Vivek Menon'], ['demo.farah', 'Farah Qureshi'],
  ];
  const insUser = db.prepare(`INSERT INTO users (username, password_hash, full_name, role_id, active, created_at)
    VALUES (?, ?, ?, ?, 1, ?)`);
  const salesRole = db.prepare("SELECT id FROM roles WHERE name IN ('Counselor','Admin') ORDER BY CASE name WHEN 'Counselor' THEN 0 ELSE 1 END LIMIT 1").get();
  for (const [username, fullName] of demoUserDefs) {
    if (db.prepare('SELECT id FROM users WHERE username=?').get(username)) continue;
    insUser.run(username, bcrypt.hashSync(crypto.randomBytes(24).toString('hex'), 10),
      fullName, salesRole?.id || null, stamp(HISTORY_DAYS));
    add('users');
  }
  const users = db.prepare('SELECT id, COALESCE(full_name, username) AS name FROM users WHERE active=1').all();
  const userIds = users.map((u) => u.id);

  const stages = db.prepare(`
    SELECT s.id, s.name, s.is_won, s.is_lost, s.sort_order, s.probability
      FROM module_pipeline_stages s
      JOIN module_pipelines p ON p.id = s.pipeline_id
      JOIN modules m ON m.id = p.module_id
     WHERE m.api_name = 'opportunities'
     ORDER BY s.sort_order
  `).all();
  if (!stages.length) throw new Error('No opportunity pipeline is configured, so deals cannot be created.');
  const pipelineId = db.prepare(`
    SELECT p.id FROM module_pipelines p JOIN modules m ON m.id = p.module_id
     WHERE m.api_name='opportunities' ORDER BY p.is_default DESC LIMIT 1
  `).get()?.id || null;

  // --- products ------------------------------------------------------------
  const insProduct = db.prepare(`INSERT INTO products (product_name, sku, product_type, category,
    description, unit, selling_price, cost_price, tax_percent, currency, recurring,
    billing_frequency, active, owner_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'INR', ?, ?, 1, ?, ?)`);
  const products = CATALOGUE.slice(0, VOLUME.products).map(([name, category, type, price, hsn, unit, tax, recurring, freq], i) => {
    const id = insProduct.run(
      name, `SKU-${1000 + i}`, type, category,
      `${TAG} ${category} catalogue item. HSN/SAC ${hsn}.`,
      unit, price, Math.round(price * (0.3 + rnd() * 0.25)), tax,
      recurring, freq, pick(userIds), stamp(HISTORY_DAYS - int(0, 30)),
    ).lastInsertRowid;
    add('products');
    return { id, name, price, hsn, unit, tax, recurring, freq, category };
  });

  // --- accounts and contacts -----------------------------------------------
  const insAccount = db.prepare(`INSERT INTO accounts (account_name, account_type, industry, website,
    email, phone, whatsapp, tax_number, employees_count, annual_revenue, country, state, city,
    address, postal_code, status, customer_since, owner_id, lead_source, payment_terms,
    description, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'India', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const insContact = db.prepare(`INSERT INTO contacts (first_name, last_name, job_title, account_id,
    email, phone, mobile, city, contact_type, contact_status, owner_id, lead_source,
    last_contacted, notes, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

  const accounts = [];
  const contacts = [];
  const bases = shuffle(COMPANY_BASES).slice(0, VOLUME.accounts);
  bases.forEach((base, i) => {
    const created = int(45, HISTORY_DAYS);
    const slug = base.toLowerCase().replace(/\s/g, '');
    const [stateCode, stateName, city] = PLACES[i % PLACES.length];
    const name = `${base} ${COMPANY_SUFFIXES[i % COMPANY_SUFFIXES.length]}`;
    // A GSTIN whose first two digits agree with the state, because the tax
    // engine reads the state off it and a mismatch is rejected on save.
    const gstin = `${stateCode}AA${String.fromCharCode(65 + (i % 26))}CT${6000 + i}B1Z${String.fromCharCode(65 + (i % 9))}`;
    const isCustomer = i % 5 !== 0;
    const ownerId = pick(userIds);

    const id = insAccount.run(
      name, isCustomer ? 'Customer' : 'Prospect', pick(INDUSTRIES),
      `https://${slug}.example.com`, `contact@${slug}.example.com`,
      `0712${String(4000000 + i * 1337).slice(0, 7)}`, `98${String(60000000 + i * 7919).slice(0, 8)}`,
      gstin, int(8, 900), int(40, 950) * 100000,
      stateName, city,
      `${int(1, 90)}, ${pick(['MIDC Road', 'Civil Lines', 'Ring Road', 'Station Road', 'IT Park'])}, ${city}`,
      `4${String(40000 + i * 13).slice(0, 5)}`,
      i % 11 === 0 ? 'Inactive' : 'Active',
      isCustomer ? day(created) : null,
      ownerId, pick(SOURCES), pick(['Net 15', 'Net 30', 'Net 30', 'Net 45', 'Advance']),
      `${TAG} demo account`, stamp(created), stamp(int(0, Math.min(created, 40))),
    ).lastInsertRowid;

    const account = { id, name, stateCode, stateName, city, gstin, ownerId, created, isCustomer, contactIds: [] };
    accounts.push(account);

    for (let c = 0; c < int(2, 3); c += 1) {
      const first = pick(FIRST_NAMES);
      const last = pick(LAST_NAMES);
      const cid = insContact.run(
        first, last, pick(JOB_TITLES), id,
        `${first.toLowerCase()}.${last.toLowerCase()}@${slug}.example.com`,
        `0712${String(5000000 + i * 91 + c).slice(0, 7)}`,
        `9${String(810000000 + i * 7919 + c * 137).slice(0, 9)}`,
        city, c === 0 ? 'Primary' : pick(['Billing', 'Technical', 'Decision Maker']),
        'Active', ownerId, pick(SOURCES),
        // A slice with no contact ever recorded, so the engagement report has
        // a real "never contacted" bucket instead of a fabricated empty one.
        c === 2 && chance(0.5) ? null : day(int(1, 180)),
        `${TAG} demo contact`, stamp(int(0, created)),
      ).lastInsertRowid;
      account.contactIds.push(cid);
      contacts.push({ id: cid, accountId: id, name: `${first} ${last}` });
      add('contacts');
    }
    add('accounts');
  });

  // Picking a customer at random for each deal, quotation and invoice leaves
  // a quarter of the book with nothing on it, and during a demo the account
  // someone clicks is chosen at random too. Dealing them round-robin from a
  // shuffled pack instead gives every customer a history while keeping the
  // order unpredictable.
  let accountQueue = [];
  function nextAccount() {
    if (!accountQueue.length) accountQueue = shuffle(accounts);
    return accountQueue.pop();
  }

  // --- opportunities -------------------------------------------------------
  const insOpp = db.prepare(`INSERT INTO opportunities (opportunity_name, account_id, primary_contact_id,
    pipeline_id, stage_id, opportunity_type, lead_source, owner_id, amount, currency, probability,
    expected_close_date, next_step, product_service, competitor, description, lost_reason,
    last_activity_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'INR', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const insHistory = db.prepare(`INSERT INTO opportunity_stage_history
    (opportunity_id, from_stage_id, to_stage_id, changed_by, changed_at) VALUES (?, ?, ?, ?, ?)`);

  const opportunities = [];
  for (let i = 0; i < VOLUME.opportunities; i += 1) {
    const account = nextAccount();
    const created = int(5, HISTORY_DAYS - 20);
    const ownerId = pick(userIds);
    // Weighted so the pipeline narrows towards the end the way a real one
    // does, rather than sitting evenly across every column of the Kanban.
    const target = pick([stages[0], stages[1], stages[1], stages[2], stages[2], stages[3],
      stages[3], stages[4], stages[5], stages[5], stages[5], stages[6]]);
    const won = !!target.is_won;
    const lost = !!target.is_lost;
    const closed = won || lost;
    const closedDays = closed ? int(0, Math.max(1, created - 10)) : 0;
    const amount = pick([25000, 35000, 45000, 60000, 90000, 120000, 180000, 240000, 320000, 450000, 680000, 900000]);

    const id = insOpp.run(
      `${pick(['CRM rollout', 'ERP implementation', 'Licence renewal', 'Branch expansion',
        'Support contract', 'Portal upgrade', 'Multi-branch migration'])} — ${account.name}`,
      account.id, account.contactIds.length ? pick(account.contactIds) : null,
      pipelineId, target.id, pick(['New Business', 'New Business', 'Renewal', 'Upsell']),
      pick(SOURCES), ownerId, amount, target.probability ?? int(10, 90),
      closed ? day(closedDays) : day(-int(5, 120)),
      closed ? null : pick(['Send revised quote', 'Schedule demo', 'Await purchase order',
        'Commercial discussion', 'Technical evaluation call']),
      pick(products).name,
      chance(0.4) ? pick(['Zoho', 'Salesforce', 'In-house build', 'Local vendor', 'Freshsales']) : null,
      `${TAG} demo opportunity`, lost ? pick(LOSS_REASONS) : null,
      stamp(closed ? closedDays : int(0, 30)),
      stamp(created), stamp(closed ? closedDays : int(0, Math.min(created, 25))),
    ).lastInsertRowid;

    // Walk the deal through every stage up to where it ended, leaving the
    // history the velocity and funnel reports read. Without this, "average
    // days in stage" has nothing to average.
    const path = stages.filter((s) => s.sort_order <= target.sort_order && !s.is_lost && !s.is_won);
    let prev = null;
    let at = created;
    for (const s of path) {
      insHistory.run(id, prev, s.id, ownerId, stamp(at));
      prev = s.id;
      at = Math.max(closedDays, at - int(3, 22));
    }
    if (closed) insHistory.run(id, prev, target.id, ownerId, stamp(closedDays));

    opportunities.push({ id, accountId: account.id, account, amount, won, lost, closed, ownerId, created });
    add('opportunities');
  }

  // --- leads ---------------------------------------------------------------
  const insLead = db.prepare(`INSERT INTO leads (student_name, account_name, mobile, alternate_mobile,
    email, city, address, source, status, assigned_counselor, follow_up_date, lead_rating, lead_score,
    campaign, product_interest, remarks, created_at, converted_account_id, converted_contact_id,
    converted_opportunity_id, converted_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const insLeadActivity = db.prepare(`INSERT INTO lead_activities (lead_id, type, note, created_by, created_at)
    VALUES (?, ?, ?, ?, ?)`);

  const leads = [];
  for (let i = 0; i < VOLUME.leads; i += 1) {
    const created = weightedDay();
    const owner = pick(users);
    const converted = chance(0.26) && opportunities.length > 0;
    const opp = converted ? pick(opportunities) : null;
    const [, , city] = PLACES[i % PLACES.length];
    const first = pick(FIRST_NAMES);
    const last = pick(LAST_NAMES);
    const status = converted ? 'Qualified' : pick(LEAD_STATUSES);

    const id = insLead.run(
      `${first} ${last}`,
      `${pick(COMPANY_BASES)} ${pick(COMPANY_SUFFIXES)}`,
      `9${String(700000000 + i * 1373).slice(0, 9)}`,
      chance(0.3) ? `8${String(800000000 + i * 977).slice(0, 9)}` : null,
      `${first.toLowerCase()}${i}@example.com`, city,
      chance(0.5) ? `${pick(['Shop', 'Office', 'Plot'])} ${int(1, 99)}, ${city}` : null,
      pick(SOURCES), status, owner.name,
      ['New', 'Contacted', 'Demo Done'].includes(status) ? day(-int(0, 14)) : null,
      pick(RATINGS), int(10, 100), pick(CAMPAIGNS), pick(products).name,
      `${TAG} demo lead`, stamp(created),
      opp ? opp.accountId : null, null, opp ? opp.id : null,
      opp ? stamp(Math.max(0, created - int(2, 20))) : null,
    ).lastInsertRowid;
    leads.push({ id, created, ownerName: owner.name, ownerId: owner.id, status });
    add('leads');

    // The per-lead timeline. A lead detail page with an empty history is the
    // screen a prospect looks at longest, because it is the one that looks
    // most like their own day.
    const entries = int(1, 4);
    for (let a = 0; a < entries; a += 1) {
      const type = pick(['call', 'whatsapp', 'email', 'note', 'status_change']);
      insLeadActivity.run(id, type, `${TAG} ${{
        call: 'Called — discussed requirement and branch count.',
        whatsapp: 'Sent product brochure and pricing on WhatsApp.',
        email: 'Emailed the proposal with the comparison sheet.',
        note: 'Wants to see the fee module before deciding.',
        status_change: `Status moved to ${status}.`,
      }[type]}`, owner.name, stamp(Math.max(0, created - a * int(1, 9))));
      add('lead_activities');
    }
  }

  // --- quotations ----------------------------------------------------------
  // Written directly rather than through the quotations route, because the
  // route allocates from the live numbering counter and a demo load would
  // push a real series forward by sixty. The figures are computed the same
  // way the route computes them.
  const insQuote = db.prepare(`INSERT INTO quotations (quote_number, quote_date, valid_until, account_id,
    contact_id, opportunity_id, billing_address, currency, payment_terms, salesperson_id,
    customer_gstin, place_of_supply, subtotal, total_discount, taxable_value, tax_total,
    cgst_total, sgst_total, igst_total, grand_total, notes, terms, status, sent_at, accepted_at,
    rejected_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'INR', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const insQuoteItem = db.prepare(`INSERT INTO quotation_items (quotation_id, product_id, description,
    hsn_sac, quantity, unit, unit_price, discount_percent, tax_percent, line_total, sort_order)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

  const COMPANY_STATE = documentService.companyStateCode() || '27';
  const DEFAULT_TERMS = [
    '1. Prices are valid for 30 days from the date of this quotation.',
    '2. Payment: 50% advance with the purchase order, balance on delivery.',
    '3. GST as applicable is shown separately above.',
    '4. Implementation begins within 7 working days of receiving the advance.',
  ].join('\n');

  // Build the priced lines once, then reuse the shape for whichever document
  // the lines end up on. The quotation and the invoice raised from it must
  // agree to the paisa, and the surest way to guarantee that is one source.
  function buildLines(count) {
    const chosen = shuffle(products).slice(0, count);
    return chosen.map((p, idx) => ({
      product_id: p.id, description: p.name, hsn_sac: p.hsn,
      quantity: p.category === 'Hardware' || p.category === 'Content' ? int(1, 12) : int(1, 3),
      unit: p.unit, unit_price: p.price,
      discount_percent: pick([0, 0, 0, 5, 10, 12.5, 15, 20]),
      tax_percent: p.tax, sort_order: idx,
    }));
  }

  function totalsFor(lines, placeOfSupply) {
    let subtotal = 0; let discount = 0; let taxable = 0; let tax = 0;
    const priced = lines.map((l) => {
      const gross = l.quantity * l.unit_price;
      const disc = gross * (l.discount_percent / 100);
      const net = gross - disc;
      const t = net * (l.tax_percent / 100);
      subtotal += gross; discount += disc; taxable += net; tax += t;
      return { ...l, line_total: Math.round((net + t) * 100) / 100 };
    });
    const intra = placeOfSupply === COMPANY_STATE;
    const r2 = (n) => Math.round(n * 100) / 100;
    return {
      priced,
      subtotal: r2(subtotal), discount: r2(discount), taxable: r2(taxable), tax: r2(tax),
      cgst: intra ? r2(tax / 2) : 0, sgst: intra ? r2(tax / 2) : 0, igst: intra ? 0 : r2(tax),
      grand: r2(taxable + tax),
    };
  }

  const quotations = [];
  for (let i = 0; i < VOLUME.quotations; i += 1) {
    const account = nextAccount();
    const created = weightedDay();
    const status = pick(['Draft', 'Sent', 'Sent', 'Sent', 'Accepted', 'Accepted', 'Accepted', 'Rejected', 'Expired']);
    const lines = buildLines(int(1, 4));
    const t = totalsFor(lines, account.stateCode);
    const linkedOpp = opportunities.find((o) => o.accountId === account.id);

    const id = insQuote.run(
      // A series of its own so a demo load never advances the real counter.
      `QT-D${String(1000 + i)}`, day(created), day(created - 30), account.id,
      account.contactIds.length ? account.contactIds[0] : null, linkedOpp ? linkedOpp.id : null,
      `${account.name}\n${account.city}, ${account.stateName}`,
      pick(['Net 15', 'Net 30', 'Net 30', '50% advance']), pick(userIds),
      account.gstin, account.stateCode,
      t.subtotal, t.discount, t.taxable, t.tax, t.cgst, t.sgst, t.igst, t.grand,
      `${TAG} demo quotation`, DEFAULT_TERMS, status,
      status === 'Draft' ? null : stamp(Math.max(0, created - 1)),
      status === 'Accepted' ? stamp(Math.max(0, created - int(3, 12))) : null,
      status === 'Rejected' ? stamp(Math.max(0, created - int(3, 15))) : null,
      stamp(created), stamp(Math.max(0, created - int(0, 5))),
    ).lastInsertRowid;

    t.priced.forEach((l, idx) => insQuoteItem.run(id, l.product_id, l.description, l.hsn_sac,
      l.quantity, l.unit, l.unit_price, l.discount_percent, l.tax_percent, l.line_total, idx));

    quotations.push({ id, account, status, lines, created, grand: t.grand, oppId: linkedOpp?.id || null });
    add('quotations');
    add('quotation_items', t.priced.length);
  }

  // --- proforma invoices and invoices --------------------------------------
  // These go through documentService, so numbering, the GST split, rounding
  // and the payment totals are produced by the same code the UI runs. A demo
  // invoice that was hand-written into the table would stop agreeing with
  // itself the moment a prospect edited a line.
  const accepted = quotations.filter((q) => q.status === 'Accepted');
  const proformas = [];
  const invoices = [];

  const docNotes = `${TAG} demo document`;

  function docPayload(account, lines, created, extra = {}) {
    return {
      account_id: account.id,
      contact_id: account.contactIds.length ? account.contactIds[0] : null,
      billing_address: `${account.name}\n${account.city}, ${account.stateName}`,
      shipping_address: null,
      customer_gstin: account.gstin,
      place_of_supply: account.stateCode,
      currency: 'INR',
      payment_terms: pick(['Net 15', 'Net 30', 'Net 30', 'Net 45']),
      salesperson_id: pick(userIds),
      doc_date: day(created),
      notes: docNotes,
      terms: DEFAULT_TERMS,
      items: lines,
      ...extra,
    };
  }

  // Half the proformas come from an accepted quotation so the document trail
  // on screen has something in it; the rest are raised directly, which is
  // just as common when a customer asks for a proforma to release payment.
  const fromQuote = shuffle(accepted).slice(0, Math.min(accepted.length, Math.floor(VOLUME.proformas / 2)));
  for (let i = 0; i < VOLUME.proformas; i += 1) {
    const source = fromQuote[i];
    const account = source ? source.account : nextAccount();
    const created = source ? Math.max(0, source.created - int(2, 15)) : weightedDay();
    const lines = source ? source.lines : buildLines(int(1, 3));
    // create() hands back the new id, not the row.
    const docId = documentService.create('proforma', docPayload(account, lines, created, {
      quotation_id: source ? source.id : null,
      valid_until: day(created - 21),
      status: pick(['Draft', 'Sent', 'Sent', 'Sent', 'Accepted', 'Accepted', 'Cancelled']),
    }), pick(userIds));
    if (source) {
      db.prepare("UPDATE quotations SET converted_to_document_id=? WHERE id=?").run(docId, source.id);
    }
    proformas.push({ id: docId, account, lines, created, source });
    add('proforma_invoices');
  }

  // Invoices: some converted from a proforma, some straight from an accepted
  // quotation, the rest raised on their own.
  const proformaSeeds = shuffle(proformas).slice(0, Math.floor(VOLUME.invoices * 0.35));
  const quoteSeeds = shuffle(accepted.filter((q) => !fromQuote.includes(q)))
    .slice(0, Math.floor(VOLUME.invoices * 0.25));

  for (let i = 0; i < VOLUME.invoices; i += 1) {
    const fromProforma = proformaSeeds[i];
    const fromQuotation = !fromProforma ? quoteSeeds[i - proformaSeeds.length] : null;
    const account = fromProforma ? fromProforma.account : (fromQuotation ? fromQuotation.account : nextAccount());
    const lines = fromProforma ? fromProforma.lines : (fromQuotation ? fromQuotation.lines : buildLines(int(1, 4)));
    const base = fromProforma ? fromProforma.created : (fromQuotation ? fromQuotation.created : weightedDay());
    const created = Math.max(0, base - int(1, 12));
    const termDays = pick([15, 30, 30, 45]);

    const docId = documentService.create('invoice', docPayload(account, lines, created, {
      quotation_id: fromQuotation ? fromQuotation.id : (fromProforma?.source?.id || null),
      source_document_id: fromProforma ? fromProforma.id : null,
      due_date: day(created - termDays),
      payment_terms: `Net ${termDays}`,
      status: 'Sent',
    }), pick(userIds));

    // Read the total back rather than reusing the figure the lines implied:
    // the engine rounds invoices to the rupee, so the amount a payment has to
    // settle is the one it stored, not the one arithmetic here would produce.
    const grand = db.prepare('SELECT grand_total FROM sales_documents WHERE id=?').get(docId).grand_total;
    invoices.push({ id: docId, account, created, grand, dueDays: created - termDays });
    add('invoices');
  }

  // --- payments ------------------------------------------------------------
  // Recorded through documentPayments, which recalculates the invoice after
  // each one. That is what makes balance_due, payment_status and the document
  // status agree with each other instead of being three separate guesses.
  //
  // The mix is chosen for the receivables reports: settled invoices give the
  // collection trend something to plot, part-paid ones give the ageing report
  // its middle buckets, and the unpaid overdue ones are the call list.
  const insPayment = db.prepare(`INSERT INTO payments (payment_number, payment_date, account_id,
    contact_id, opportunity_id, payer_name, description, amount, payment_mode, transaction_number,
    status, remarks, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

  invoices.forEach((inv, i) => {
    const roll = rnd();
    const overdue = inv.dueDays < 0;
    // Overdue invoices are less likely to be settled — that is what makes
    // them overdue, and a demo where every late invoice is paid shows nothing.
    const settle = overdue ? roll < 0.35 : roll < 0.62;
    const partial = !settle && (overdue ? roll < 0.65 : roll < 0.82);

    if (settle) {
      // A third of settled invoices arrive in two instalments, so the
      // payment history on the invoice is not always a single line.
      if (chance(0.34)) {
        const first = Math.round(inv.grand * (0.3 + rnd() * 0.3) * 100) / 100;
        documentPayments.record(inv.id, {
          amount: first, payment_date: day(Math.max(0, inv.created - int(2, 20))),
          payment_mode: pick(MODES), transaction_number: `TXN${700000 + i * 7}`,
          remarks: `${TAG} demo payment — part 1`, status: 'Paid',
        }, pick(userIds));
        add('payments');
        const remaining = db.prepare('SELECT grand_total, amount_paid FROM sales_documents WHERE id=?').get(inv.id);
        documentPayments.record(inv.id, {
          amount: Math.round((remaining.grand_total - remaining.amount_paid) * 100) / 100,
          payment_date: day(Math.max(0, inv.created - int(21, 50))),
          payment_mode: pick(MODES), transaction_number: `TXN${700001 + i * 7}`,
          remarks: `${TAG} demo payment — final`, status: 'Paid',
        }, pick(userIds));
        add('payments');
      } else {
        documentPayments.record(inv.id, {
          amount: inv.grand, payment_date: day(Math.max(0, inv.created - int(3, 40))),
          payment_mode: pick(MODES), transaction_number: `TXN${700000 + i * 7}`,
          remarks: `${TAG} demo payment`, status: 'Paid',
        }, pick(userIds));
        add('payments');
      }
    } else if (partial) {
      documentPayments.record(inv.id, {
        amount: Math.round(inv.grand * (0.2 + rnd() * 0.5) * 100) / 100,
        payment_date: day(Math.max(0, inv.created - int(2, 25))),
        payment_mode: pick(MODES), transaction_number: `TXN${700000 + i * 7}`,
        remarks: `${TAG} demo payment — advance`, status: 'Paid',
      }, pick(userIds));
      add('payments');
    }
  });

  // Payments not tied to an invoice — renewals, advances, subscription
  // collections. The Payments module existed before invoices did and is still
  // used on its own, so it has to look populated in its own right.
  for (let i = 0; i < VOLUME.looseP; i += 1) {
    const account = nextAccount();
    const days = weightedDay();
    insPayment.run(
      `PMT-D${String(4000 + i)}`, day(days), account.id,
      account.contactIds.length ? pick(account.contactIds) : null, null,
      account.name, pick(['Licence renewal', 'Implementation milestone', 'Annual support',
        'Training fee', 'Hosting renewal', 'Advance against order']),
      pick([9000, 15000, 24000, 36000, 45000, 60000, 90000, 120000, 180000]),
      pick(MODES), `TXN${820000 + i * 13}`,
      pick(['Paid', 'Paid', 'Paid', 'Paid', 'Pending', 'Partial']),
      `${TAG} demo payment`, stamp(days),
    );
    add('payments');
  }

  // --- subscriptions / AMC ---------------------------------------------------
  // Each has a term and a separate billing frequency; its instalments are
  // generated into the Payments module by the same code the Subscriptions
  // route uses, and the ones already due are marked received. Some are
  // renewed once, so renewal history has something to show.
  const billing = require('./subscriptionBilling');
  const insSub = db.prepare(`INSERT INTO subscriptions (subscription_number, account_id, contact_id,
    opportunity_id, product_id, plan, start_date, end_date, billing_cycle, quantity, unit_price,
    tax_percent, recurring_amount, currency, payment_terms, auto_renewal, renewal_date, status,
    owner_id, notes, created_at, term_months, billing_frequency_months, subscription_value, renewal_number)
    VALUES (@number, @account_id, @contact_id, NULL, @product_id, @plan, @start_date, @end_date, @billing_cycle,
      @qty, @unit_price, 18, @recurring_amount, 'INR', @payment_terms, @auto_renewal, @renewal_date, @status,
      @owner_id, @notes, @created_at, @term_months, @billing_frequency_months, @subscription_value, 0)`);
  const today = day(0);
  const markDuePaid = db.prepare(`UPDATE payments SET status='Paid', payment_date=due_date,
      payment_mode=?, transaction_number=? WHERE subscription_id=? AND date(due_date) <= date(?) AND status='Pending'`);

  const recurring = products.filter((p) => p.recurring);
  for (let i = 0; i < VOLUME.subscriptions; i += 1) {
    const account = nextAccount();
    const product = recurring.length ? pick(recurring) : pick(products);
    const term = pick([12, 12, 12, 6, 24]);
    const freq = pick([1, 3, 3, 6, 12].filter((f) => term % f === 0));
    const qty = int(1, 4);
    const value = product.price * qty * (term / 12) * (freq === 1 ? 12 : 1);
    // Ends spread either side of today, so "renewals due in the next 30 days"
    // is never an empty screen.
    const endsIn = int(-60, 240);
    const startDate = billing.addDays(billing.addMonths(day(-endsIn), -term), 1);
    const values = billing.normalise({ start_date: startDate, term_months: term, billing_frequency_months: freq, subscription_value: value, status: 'Active' });
    const status = endsIn < -30 ? pick(['Inactive', 'Active']) : pick(['Active', 'Active', 'Active', 'Active', 'Hold']);
    const id = insSub.run({
      number: `SUB-D${String(600 + i)}`, account_id: account.id,
      contact_id: account.contactIds.length ? account.contactIds[0] : null, product_id: product.id,
      plan: pick(['Starter', 'Professional', 'Enterprise']),
      start_date: values.start_date, end_date: values.end_date, billing_cycle: values.billing_cycle,
      qty, unit_price: product.price, recurring_amount: values.recurring_amount,
      payment_terms: pick(['Net 15', 'Net 30', 'Advance']), auto_renewal: chance(0.7) ? 1 : 0,
      renewal_date: values.renewal_date, status: 'Active', owner_id: pick(userIds), notes: `${TAG} demo subscription`,
      created_at: values.start_date < today ? `${values.start_date} 10:00:00` : stamp(int(1, 20)),
      term_months: term, billing_frequency_months: freq, subscription_value: values.subscription_value,
    }).lastInsertRowid;
    add('subscriptions');
    add('payments', billing.generateSchedule(id));
    markDuePaid.run(pick(MODES), `SUB${900000 + i * 31}`, id, billing.addDays(today, -int(0, 20)));
    if (status !== 'Active') db.prepare('UPDATE subscriptions SET status=? WHERE id=?').run(status, id);

    // Roughly one in four older cycles has already been renewed, on a
    // different frequency, so the chain and its separate schedules show.
    if (status === 'Active' && endsIn < 20 && chance(0.35)) {
      const renewed = billing.renew(id, { billing_frequency_months: freq === 1 ? 3 : 1, notes: `${TAG} demo subscription` },
        null, () => `SUB-D${String(600 + i)}-R1`);
      add('subscriptions');
      add('payments', db.prepare('SELECT COUNT(*) c FROM payments WHERE subscription_id=?').get(renewed.id).c);
      markDuePaid.run(pick(MODES), `SUB${950000 + i * 31}`, renewed.id, billing.addDays(today, -int(5, 25)));
    }
  }

  // --- tickets -------------------------------------------------------------
  const insTicket = db.prepare(`INSERT INTO tickets (ticket_number, subject, account_id, contact_id,
    email, phone, category, priority, status, source, assigned_agent_id, sla_tier, sla_due_at,
    first_response_at, resolution_at, resolved_at, closed_at, resolution, description, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const insReply = db.prepare(`INSERT INTO ticket_replies (ticket_id, is_internal, body, created_by, created_at)
    VALUES (?, ?, ?, ?, ?)`);

  const TICKET_SUBJECTS = [
    'Cannot log in after password reset', 'Invoice total does not match the quotation',
    'Student import failed halfway', 'Need two extra user licences',
    'Attendance report shows wrong totals', 'Request for refresher training',
    'Email notifications not going out', 'Fee receipt prints without GST',
    'Parent app showing old timetable', 'Backup download link expired',
    'Biometric device not syncing', 'WhatsApp messages stuck in queue',
  ];
  for (let i = 0; i < VOLUME.tickets; i += 1) {
    const account = nextAccount();
    const created = weightedDay();
    const createdAt = stamp(created, int(9, 18));
    const resolved = chance(0.72);
    const respHours = int(1, 30);
    const resHours = respHours + int(2, 90);
    const slaHours = pick([8, 24, 48]);
    const priority = pick(PRIORITIES);

    const id = insTicket.run(
      `TKT-D${String(2000 + i)}`, pick(TICKET_SUBJECTS), account.id,
      account.contactIds.length ? pick(account.contactIds) : null,
      `support@${account.name.toLowerCase().split(' ')[0]}.example.com`,
      `98${String(60000000 + i * 7919).slice(0, 8)}`,
      pick(TICKET_CATEGORIES), priority,
      resolved ? pick(['Resolved', 'Resolved', 'Closed']) : pick(['Open', 'In Progress', 'Pending']),
      pick(['Email', 'Phone', 'Portal', 'WhatsApp']), pick(userIds),
      `${slaHours}h`, plusHours(createdAt, slaHours), plusHours(createdAt, respHours),
      resolved ? plusHours(createdAt, resHours) : null,
      resolved ? plusHours(createdAt, resHours) : null,
      resolved && chance(0.6) ? plusHours(createdAt, resHours + 6) : null,
      resolved ? pick(['Configuration corrected and verified with the customer.',
        'Patch applied on their instance; confirmed working.',
        'Explained the setting and shared a short walkthrough.',
        'Data re-imported after fixing the source file.']) : null,
      `${TAG} demo ticket`, createdAt,
    ).lastInsertRowid;
    add('tickets');

    insReply.run(id, 0, `${TAG} Thanks for writing in — we are looking at this now and will update you shortly.`,
      pick(userIds), plusHours(createdAt, respHours));
    add('ticket_replies');
    if (resolved) {
      insReply.run(id, 0, `${TAG} This is sorted now. Please confirm at your end and we will close the ticket.`,
        pick(userIds), plusHours(createdAt, resHours));
      add('ticket_replies');
    }
    if (chance(0.3)) {
      insReply.run(id, 1, `${TAG} Internal: reproduced on staging. Root cause was a stale cache entry.`,
        pick(userIds), plusHours(createdAt, respHours + 2));
      add('ticket_replies');
    }
  }

  // --- support desk ----------------------------------------------------------
  // Teams to route to, configured categories, CSAT on resolved tickets, and
  // the support records (knowledge base, catalog, incident, problem, assets)
  // so the Support Command Center has something real to show.
  {
    const teamIds = [];
    const insTeam = db.prepare('INSERT INTO teams (name, description, lead_user_id, active) VALUES (?,?,?,1)');
    const insMember = db.prepare('INSERT OR IGNORE INTO team_members (team_id, user_id) VALUES (?,?)');
    [['L1 Support', 'Technical'], ['Technical Support', 'Installation'], ['Billing Support', 'Billing']].forEach(([name], i) => {
      const existing = db.prepare('SELECT id FROM teams WHERE name=?').get(name);
      const id = existing ? existing.id : insTeam.run(name, `${TAG} demo support team`, userIds[i % userIds.length], ).lastInsertRowid;
      userIds.forEach((u, j) => { if (j % 3 === i || j === i) insMember.run(id, u); });
      teamIds.push(id);
      if (!existing) add('teams');
    });
    const CATS = [['Technical', 'Error / Bug', 0], ['Technical', 'Performance', 0], ['Billing', 'Invoice', 2], ['Product', 'How-to', 0],
      ['Installation', 'New Setup', 1], ['Account', 'Users & Licences', 0], ['Other', null, 0]];
    const demoTickets = db.prepare('SELECT id, status, created_at, resolved_at FROM tickets WHERE description LIKE ?').all(`%${TAG}%`);
    const upd = db.prepare(`UPDATE tickets SET category=?, subcategory=?, team_id=?, ticket_type='Incident',
      csat_rating=?, csat_comment=?, csat_at=?, status=CASE WHEN status='Open' AND ?=1 THEN 'Assigned' ELSE status END WHERE id=?`);
    demoTickets.forEach((t, i) => {
      const [cat, sub, team] = CATS[i % CATS.length];
      const done = ['Resolved', 'Closed'].includes(t.status);
      const rated = done && chance(0.65);
      upd.run(cat, sub, teamIds[team], rated ? pick([5, 5, 4, 4, 4, 3, 2]) : null,
        rated ? pick(['Quick and helpful.', 'Solved on the first call.', 'Took a while but resolved.', null]) : null,
        rated ? (t.resolved_at || t.created_at) : null, i % 4 === 0 ? 1 : 0, t.id);
    });

    const insKb = db.prepare(`INSERT INTO kb_articles (article_number, title, article_type, category, status, summary, body, tags, views, owner_id)
      VALUES (?,?,?,?,?,?,?,?,?,?)`);
    [
      ['How to reset a user password', 'FAQ', 'Account', 'Reset a locked or forgotten password from Settings → Users.', 'password, login, reset'],
      ['Fixing "session expired" on login', 'Troubleshooting', 'Technical', 'Clear the browser cache and check the device clock.', 'login, session, error'],
      ['Importing students from Excel', 'Article', 'Product', 'Use the import template and map each column before importing.', 'import, excel, data'],
      ['Setting up the biometric device', 'Product Documentation', 'Installation', 'Connect the device to the same network and pair it from Devices.', 'biometric, device, setup'],
      ['Why does my invoice total differ from the quote?', 'FAQ', 'Billing', 'Taxes and discounts are recalculated at invoicing time.', 'invoice, quotation, tax, billing'],
      ['Adding user licences', 'Article', 'Account', 'Additional licences are added from Billing → Licences.', 'licence, users, billing'],
      ['Speeding up slow reports', 'Troubleshooting', 'Technical', 'Narrow the date range and archive old records.', 'performance, reports, slow'],
      ['WhatsApp messages stuck in queue', 'Troubleshooting', 'Technical', 'Check the provider template approval and the number’s quality rating.', 'whatsapp, queue, messages'],
    ].forEach(([title, type, cat, summary, tags], i) => {
      insKb.run(`KB-D${String(100 + i)}`, title, type, cat, 'Published', summary,
        `${TAG} ${summary}\n\nSteps:\n1. Open the relevant screen.\n2. Follow the on-screen instructions.\n3. Contact support if the issue continues.`, tags, int(5, 240), pick(userIds));
      add('kb_articles');
    });

    const insItem = db.prepare(`INSERT INTO service_catalog_items (name, category, description, form_schema, approval_required, approver_id, default_team_id, default_priority, active)
      VALUES (?,?,?,?,?,?,?,?,1)`);
    [
      ['New user access', 'Account', 'Create a login for a new staff member.', [
        { key: 'full_name', label: 'Full name', type: 'text', required: true },
        { key: 'email', label: 'Work email', type: 'text', required: true },
        { key: 'role', label: 'Role', type: 'dropdown', required: true, options: ['Staff', 'Manager', 'Admin'] },
        { key: 'reason', label: 'Why is Admin access needed?', type: 'textarea', required: true, show_if: { key: 'role', equals: 'Admin' } },
      ], 1, 0, 'Medium'],
      ['On-site installation visit', 'Installation', 'Book an engineer visit.', [
        { key: 'site_address', label: 'Site address', type: 'textarea', required: true },
        { key: 'preferred_date', label: 'Preferred date', type: 'date', required: true },
        { key: 'devices', label: 'Number of devices', type: 'number', required: false },
      ], 1, 1, 'High'],
      ['Data export request', 'Product', 'Export your data as Excel.', [
        { key: 'modules', label: 'What should be exported?', type: 'text', required: true },
        { key: 'from_date', label: 'From date', type: 'date', required: false },
      ], 0, 0, 'Low'],
      ['Invoice correction', 'Billing', 'Request a corrected invoice.', [
        { key: 'invoice_number', label: 'Invoice number', type: 'text', required: true },
        { key: 'correction', label: 'What needs correcting?', type: 'textarea', required: true },
      ], 0, 2, 'Medium'],
    ].forEach(([name, cat, desc, schema, approval, team, prio]) => {
      insItem.run(name, cat, `${desc} ${TAG}`, JSON.stringify(schema), approval, approval ? userIds[0] : null, teamIds[team], prio);
      add('service_catalog');
    });

    const openIds = demoTickets.filter((t) => !['Resolved', 'Closed'].includes(t.status)).map((t) => t.id);
    const inc = db.prepare(`INSERT INTO major_incidents (incident_number, title, status, severity, commander_id, started_at, impact, affected_customers)
      VALUES (?,?,?,?,?,?,?,?)`).run('INC-D001', 'WhatsApp message delivery delayed', 'Monitoring', 'SEV2', userIds[0], stamp(2),
      `${TAG} Outbound WhatsApp messages delayed by up to 40 minutes.`, 'Customers using WhatsApp notifications').lastInsertRowid;
    db.prepare('INSERT INTO incident_updates (incident_id, status, body, user_id, created_at) VALUES (?,?,?,?,?)').run(inc, 'Identified', 'Provider-side throttling identified; failover route enabled.', userIds[0], stamp(1));
    openIds.slice(0, 3).forEach((id) => db.prepare('UPDATE tickets SET major_incident_id=? WHERE id=?').run(inc, id));
    add('major_incidents');
    const prb = db.prepare(`INSERT INTO problems (problem_number, title, status, priority, category, owner_id, root_cause, workaround)
      VALUES (?,?,?,?,?,?,?,?)`).run('PRB-D001', 'Import fails on files with merged cells', 'Known Error', 'High', 'Product', pick(userIds),
      `${TAG} The parser stops at the first merged cell.`, 'Unmerge cells before importing.').lastInsertRowid;
    openIds.slice(3, 5).forEach((id) => db.prepare('UPDATE tickets SET problem_id=? WHERE id=?').run(prb, id));
    add('problems');

    const subsForAssets = db.prepare('SELECT id, account_id, product_id FROM subscriptions WHERE notes LIKE ? LIMIT 12').all(`%${TAG}%`);
    subsForAssets.forEach((sub, i) => {
      db.prepare(`INSERT INTO assets (asset_tag, asset_name, serial_number, account_id, product_id, subscription_id, status, install_date, warranty_end, notes)
        VALUES (?,?,?,?,?,?,?,?,?,?)`).run(`AST-D${String(500 + i)}`, pick(['Biometric Terminal', 'ID Card Printer', 'On-prem Server', 'Barcode Scanner']),
        `SN${880000 + i * 37}`, sub.account_id, sub.product_id, sub.id, i % 7 === 0 ? 'In Repair' : 'Active', day(int(60, 400)), day(-int(30, 500)), `${TAG} demo asset`);
      add('assets');
    });
  }

  // --- activities ----------------------------------------------------------
  // Every one of these is attached to something. The universal Activities tab
  // reads related_module + related_record_id, so an activity with a null
  // record is invisible everywhere in the product — which is what the old
  // seeder produced, in bulk.
  const targets = [
    ...accounts.map((a) => ({ module: 'accounts', id: a.id, label: a.name, account: a })),
    ...contacts.map((c) => ({ module: 'contacts', id: c.id, label: c.name })),
    ...opportunities.map((o) => ({ module: 'opportunities', id: o.id, label: o.account.name })),
    ...leads.map((l) => ({ module: 'leads', id: l.id, label: 'lead' })),
  ];

  // Drawing a target at random leaves coverage to luck: with ~1,000
  // activities over ~370 records, a good number of accounts end up with one
  // entry and some with none, and the one a prospect happens to click is as
  // likely as not to be a bare one. Instead every record is put into a queue
  // as many times as its weight, the queue is shuffled, and activities draw
  // from it in order — so coverage is guaranteed while the order still looks
  // arbitrary. The queue refills when it runs out.
  let queue = [];
  function nextTarget() {
    if (!queue.length) {
      queue = shuffle(targets.flatMap((t) => Array(ACTIVITY_WEIGHT[t.module] || 1).fill(t)));
    }
    return queue.pop();
  }

  const insCall = db.prepare(`INSERT INTO calls (call_subject, related_module, related_record_id,
    phone_number, call_type, direction, start_time, duration_minutes, duration_seconds, connected,
    assigned_user_id, status, call_outcome, notes, follow_up_date, next_action, created_by, created_at)
    VALUES (?, ?, ?, ?, 'Voice', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (let i = 0; i < VOLUME.calls; i += 1) {
    const t = nextTarget();
    const days = weightedDay();
    const connected = chance(0.58);
    const mins = connected ? int(1, 26) : 0;
    const u = pick(userIds);
    const at = stamp(days, int(10, 19));
    insCall.run(
      pick(['Follow-up call', 'Demo scheduling', 'Renewal discussion', 'Cold outreach',
        'Payment reminder', 'Requirement gathering', 'Post-implementation check']),
      t.module, t.id, `98${String(70000000 + i * 313).slice(0, 8)}`,
      chance(0.25) ? 'Inbound' : 'Outbound', at, mins, mins * 60, connected ? 1 : 0, u,
      'Completed',
      connected ? pick(['Interested', 'Demo Scheduled', 'Call Back Later', 'Not Interested',
        'Converted', 'Needs Approval']) : pick(['No Answer', 'Busy', 'Switched Off', 'Wrong Number']),
      `${TAG} demo call`,
      connected && chance(0.4) ? day(-int(1, 14)) : null,
      connected && chance(0.4) ? pick(['Send quotation', 'Schedule demo', 'Share case study']) : null,
      u, at,
    );
    add('calls');
  }

  const insMeeting = db.prepare(`INSERT INTO meetings (meeting_title, related_module, related_record_id,
    meeting_type, location, video_link, start_datetime, end_datetime, organizer_id, assigned_user_id,
    status, agenda, meeting_notes, outcome, created_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (let i = 0; i < VOLUME.meetings; i += 1) {
    const t = nextTarget();
    // A quarter of meetings are in the future, so the calendar and the
    // "upcoming" widgets are not looking at an empty week.
    const days = chance(0.25) ? -int(1, 21) : weightedDay();
    const u = pick(userIds);
    const start = stamp(days, int(10, 17));
    const type = pick(['Online', 'Onsite', 'Office']);
    insMeeting.run(
      pick(['Product demo', 'Requirement discussion', 'Commercial negotiation',
        'Quarterly review', 'Implementation kick-off', 'Training session']),
      t.module, t.id, type,
      type === 'Online' ? 'Google Meet' : pick(PLACES)[2],
      // Deliberately null. This used to seed 'https://meet.google.com/demo-link',
      // which put a Join button in front of a URL that joins nothing. A real
      // join link only ever comes back from Google or Microsoft when a
      // connected calendar creates the conference.
      null,
      start, plusHours(start, 1), u, u,
      days < 0 ? 'Scheduled' : pick(['Held', 'Held', 'Held', 'Held', 'Cancelled', 'No Show']),
      `${TAG} demo meeting`,
      days >= 0 && chance(0.6) ? 'Walked through the modules they asked about; pricing shared on the call.' : null,
      days >= 0 ? pick(['Positive', 'Needs follow-up', 'Awaiting decision', 'Not a fit']) : null,
      u, stamp(Math.max(0, days)),
    );
    add('meetings');
  }

  const insTask = db.prepare(`INSERT INTO tasks (task_title, related_module, related_record_id,
    assigned_to_id, priority, status, start_date, due_date, description, completed_date,
    created_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (let i = 0; i < VOLUME.tasks; i += 1) {
    const t = nextTarget();
    const days = weightedDay();
    const done = chance(0.6);
    // Some open tasks are deliberately past their due date, because "overdue
    // tasks" is a number every sales manager looks at first.
    const dueOffset = done ? int(-5, 20) : pick([-12, -6, -3, 2, 5, 9, 15]);
    const u = pick(userIds);
    insTask.run(
      pick(['Send proposal', 'Call back', 'Share brochure', 'Schedule demo', 'Collect payment',
        'Prepare quotation', 'Send renewal reminder', 'Arrange training slot', 'Follow up on PO']),
      t.module, t.id, u, pick(PRIORITIES),
      done ? 'Completed' : pick(['Open', 'In Progress', 'Pending']),
      day(days), day(days - dueOffset), `${TAG} demo task`,
      done ? day(Math.max(0, days - int(0, 12))) : null, u, stamp(days),
    );
    add('tasks');
  }

  const insNote = db.prepare(`INSERT INTO notes (title, body, related_module, related_record_id,
    pinned, visibility, created_by, created_at)
    VALUES (?, ?, ?, ?, ?, 'Everyone', ?, ?)`);
  const NOTE_BODIES = [
    'Decision maker is the director; the centre manager only evaluates.',
    'Budget approval happens at the start of the financial year — plan the follow-up for April.',
    'They are comparing us against a local vendor who quoted noticeably lower but has no support desk.',
    'Wants the fee module and the parent app first; the rest can wait for phase two.',
    'Has three branches, two of them on very slow internet — offline sync came up twice.',
    'Prefers WhatsApp to email. Calls after 7 PM go unanswered.',
    'Asked for a reference from another institute of a similar size before signing.',
    'Renewal is due next quarter; start the conversation a month early this time.',
  ];
  for (let i = 0; i < VOLUME.notes; i += 1) {
    const t = nextTarget();
    const days = weightedDay();
    insNote.run(
      pick(['Discovery call', 'Requirement note', 'Commercial note', 'Internal note', 'Site visit']),
      `${TAG} ${pick(NOTE_BODIES)}`, t.module, t.id, chance(0.15) ? 1 : 0,
      pick(userIds), stamp(days),
    );
    add('notes');
  }

  const insEmail = db.prepare(`INSERT INTO emails (subject, from_address, to_address, related_module,
    related_record_id, direction, status, body, sent_at, received_at, is_read, created_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (let i = 0; i < VOLUME.emails; i += 1) {
    const t = nextTarget();
    const days = weightedDay();
    const inbound = chance(0.42);
    const at = stamp(days, int(9, 20));
    const counterparty = t.account
      ? `contact@${t.account.name.toLowerCase().split(' ')[0]}.example.com`
      : 'customer@example.com';
    insEmail.run(
      pick(['Proposal attached', 'Re: Pricing for 2 branches', 'Meeting confirmation',
        'Invoice for this quarter', 'Following up on our call', 'Renewal due next month',
        'Implementation schedule', 'Re: Feature clarification']),
      inbound ? counterparty : 'sales@techior.com',
      inbound ? 'sales@techior.com' : counterparty,
      t.module, t.id, inbound ? 'Inbound' : 'Outbound',
      inbound ? 'Received' : 'Sent',
      `${TAG} demo email body — full thread content is not stored for demo records.`,
      inbound ? null : at, inbound ? at : null,
      chance(0.7) ? 1 : 0, pick(userIds), at,
    );
    add('emails');
  }

  // --- documents (attachments) ---------------------------------------------
  // Link-only records. A stored-file row with no file behind it would 404 the
  // moment someone clicked download during a demo, which is worse than the
  // row not existing.
  const insDocument = db.prepare(`INSERT INTO documents (title, file_name, mime_type, size_bytes,
    external_url, related_module, related_record_id, description, uploaded_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const DOC_KINDS = [
    ['Signed proposal', 'signed-proposal.pdf', 'application/pdf'],
    ['Purchase order', 'purchase-order.pdf', 'application/pdf'],
    ['Requirement sheet', 'requirements.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
    ['GST certificate', 'gst-certificate.pdf', 'application/pdf'],
    ['Implementation plan', 'implementation-plan.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
    ['Site photos', 'site-photos.zip', 'application/zip'],
    ['Training attendance', 'training-attendance.pdf', 'application/pdf'],
  ];
  for (let i = 0; i < VOLUME.documents; i += 1) {
    const t = pick(targets.filter((x) => x.module === 'accounts' || x.module === 'opportunities'));
    const [title, file, mime] = pick(DOC_KINDS);
    insDocument.run(
      title, file, mime, int(40, 4200) * 1024,
      'https://example.com/demo-document', t.module, t.id,
      `${TAG} demo document (link only)`, pick(userIds), stamp(weightedDay()),
    );
    add('documents');
  }

  // Bring invoice statuses in line with their due dates, the same sweep the
  // server runs hourly. Without it the seeded invoices would all read "Sent"
  // until the next sweep and the overdue reports would disagree with the list.
  try { documentService.markOverdue(); } catch { /* sweep is best-effort */ }

  // Support desk: give the demo tickets their SLA policies and bring SLA
  // states and escalations up to date (silently — no notification burst).
  try { require('./supportEngine').backfillPolicies(); } catch (e) { console.warn('[demo] support backfill skipped:', e.message); }
  return counts;
}

// One transaction for the whole load. Demo data is only useful as a complete
// set — a half-seeded CRM with accounts but no invoices is worse to look at
// than an empty one, and impossible to wipe cleanly.
function seedAll() {
  return db.transaction(seed)();
}

function summary() {
  const q = (sql, ...p) => db.prepare(sql).get(...p).c;
  const like = `%${TAG}%`;
  return {
    accounts: q('SELECT COUNT(*) c FROM accounts WHERE description LIKE ?', like),
    contacts: q('SELECT COUNT(*) c FROM contacts WHERE notes LIKE ?', like),
    leads: q('SELECT COUNT(*) c FROM leads WHERE remarks LIKE ?', like),
    opportunities: q('SELECT COUNT(*) c FROM opportunities WHERE description LIKE ?', like),
    quotations: q('SELECT COUNT(*) c FROM quotations WHERE notes LIKE ?', like),
    proforma_invoices: q("SELECT COUNT(*) c FROM sales_documents WHERE doc_type='proforma' AND notes LIKE ?", like),
    invoices: q("SELECT COUNT(*) c FROM sales_documents WHERE doc_type='invoice' AND notes LIKE ?", like),
    payments: q('SELECT COUNT(*) c FROM payments WHERE remarks LIKE ?', like),
    products: q('SELECT COUNT(*) c FROM products WHERE description LIKE ?', like),
    subscriptions: q('SELECT COUNT(*) c FROM subscriptions WHERE notes LIKE ?', like),
    tickets: q('SELECT COUNT(*) c FROM tickets WHERE description LIKE ?', like),
    calls: q('SELECT COUNT(*) c FROM calls WHERE notes LIKE ?', like),
    meetings: q('SELECT COUNT(*) c FROM meetings WHERE agenda LIKE ?', like),
    tasks: q('SELECT COUNT(*) c FROM tasks WHERE description LIKE ?', like),
    notes: q('SELECT COUNT(*) c FROM notes WHERE body LIKE ?', like),
    emails: q('SELECT COUNT(*) c FROM emails WHERE body LIKE ?', like),
    documents: q('SELECT COUNT(*) c FROM documents WHERE description LIKE ?', like),
  };
}

module.exports = { seed: seedAll, wipe, summary, hasDemoData, TAG, VOLUME };
