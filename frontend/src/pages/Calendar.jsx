/*
 * The calendar.
 *
 * Month, week, day and agenda views over one merged feed: CRM meetings, task
 * due dates, scheduled calls and follow-ups, and events from each user's own
 * connected Google or Outlook calendar.
 *
 * NO CALENDAR LIBRARY
 * The grid is built by hand. react-big-calendar and friends would each add
 * more weight than this whole page, bring their own date library, and then
 * have to be fought to render CRM-specific things like "task due, overdue" or
 * a link back to the account a meeting belongs to. A month grid is six rows of
 * seven cells; the hard part of a calendar is time zones and data, not CSS.
 *
 * TIME ZONES
 * Every instant that arrives from the API is UTC. Every position on this page
 * — which cell, which hour row — is computed in the VIEWER's zone. That is why
 * days are derived with Intl rather than by slicing an ISO string: at 23:30
 * UTC it is already tomorrow in India, and slicing would file the event under
 * the wrong day for the person reading it.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  CalendarDays, ChevronLeft, ChevronRight, Plus, RefreshCw, Users, User, X, Clock, MapPin,
  Video, ExternalLink, Trash2, AlertTriangle, Link2, Download, CheckCircle2, Phone, ListTodo,
} from 'lucide-react';
import { api } from '../api';
import { RecordPicker, AttendeePicker, TypeBadge } from '../components/RecordPicker';
import { PageHeader, EmptyState, friendlyError } from '../components/ui';
import { usePermissions } from '../context/usePermissions';

// ---------------------------------------------------------------------------
// Source colours
// ---------------------------------------------------------------------------
// Colour is how you tell at a glance whether Thursday is full of customer
// meetings or full of your own reminders. Each source keeps one hue
// everywhere — chip, dot, agenda row and legend — so the mapping is learnable
// after about five seconds and never has to be looked up again.
const SOURCE_STYLE = {
  meeting: { label: 'CRM meetings', dot: '#2563EB', bg: '#EFF6FF', border: '#BFDBFE', text: '#1D4ED8' },
  task: { label: 'Task due dates', dot: '#7C3AED', bg: '#F5F3FF', border: '#DDD6FE', text: '#6D28D9' },
  call: { label: 'Calls & follow-ups', dot: '#EA580C', bg: '#FFF7ED', border: '#FED7AA', text: '#C2410C' },
  google: { label: 'Google Calendar', dot: '#059669', bg: '#ECFDF5', border: '#A7F3D0', text: '#047857' },
  microsoft: { label: 'Outlook', dot: '#0284C7', bg: '#F0F9FF', border: '#BAE6FD', text: '#0369A1' },
};
const styleFor = (s) => SOURCE_STYLE[s] || SOURCE_STYLE.meeting;

const VIEWER_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

// ---------------------------------------------------------------------------
// Date helpers, all zone-aware
// ---------------------------------------------------------------------------

// The YYYY-MM-DD an instant falls on, in the viewer's zone.
function dayKey(iso) {
  if (!iso) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(iso))) return String(iso);   // already a date
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: VIEWER_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d);
}

function todayKey() { return dayKey(new Date().toISOString()); }

// A local Date for midnight of a YYYY-MM-DD, used only for grid arithmetic.
function dateFromKey(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
}
function keyFromDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function addDays(key, n) {
  const d = dateFromKey(key);
  d.setDate(d.getDate() + n);
  return keyFromDate(d);
}
function addMonths(key, n) {
  const d = dateFromKey(key);
  d.setMonth(d.getMonth() + n, 1);
  return keyFromDate(d);
}
// Weeks start on Monday, which is how a working week is read here.
function startOfWeek(key) {
  const d = dateFromKey(key);
  const shift = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - shift);
  return keyFromDate(d);
}
function startOfMonth(key) { return `${key.slice(0, 7)}-01`; }

function fmtTime(iso) {
  if (!iso) return '';
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: VIEWER_TZ, hour: 'numeric', minute: '2-digit', hour12: true,
  }).format(new Date(iso));
}
function fmtDateLong(key) {
  return new Intl.DateTimeFormat('en-IN', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  }).format(dateFromKey(key));
}
function fmtMonthTitle(key) {
  return new Intl.DateTimeFormat('en-IN', { month: 'long', year: 'numeric' }).format(dateFromKey(key));
}

// Minutes from local midnight — where an event sits in the day and week grids.
function minutesIntoDay(iso) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: VIEWER_TZ, hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date(iso));
  const h = Number(parts.find((p) => p.type === 'hour').value);
  const m = Number(parts.find((p) => p.type === 'minute').value);
  return h * 60 + m;
}

// A datetime-local input value for a given instant, in the viewer's zone.
function toLocalInput(iso) {
  const d = new Date(iso);
  const parts = new Intl.DateTimeFormat('sv-SE', {
    timeZone: VIEWER_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(d);
  return parts.replace(' ', 'T').slice(0, 16);
}

// ---------------------------------------------------------------------------
// Event chip
// ---------------------------------------------------------------------------

function EventChip({ event, onClick, compact = false }) {
  const s = styleFor(event.source);
  const done = event.status === 'completed' || event.extra?.done;
  const overdue = event.extra?.overdue;
  return (
    <button
      onClick={() => onClick(event)}
      title={`${event.title}${event.start_at && !event.all_day ? ` · ${fmtTime(event.start_at)}` : ''}`}
      className={`w-full text-left rounded-md border px-1.5 py-0.5 truncate transition-colors hover:brightness-95
        ${compact ? 'text-[11px]' : 'text-xs'}`}
      style={{
        background: s.bg,
        borderColor: overdue ? '#FCA5A5' : s.border,
        color: s.text,
        textDecoration: done ? 'line-through' : 'none',
        opacity: done ? 0.65 : 1,
      }}
    >
      <span className="inline-flex items-center gap-1 w-full min-w-0">
        <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: overdue ? '#DC2626' : s.dot }} />
        {!event.all_day && <span className="tabular-nums shrink-0 opacity-80">{fmtTime(event.start_at)}</span>}
        <span className="truncate">{event.title}</span>
      </span>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

function MonthView({ anchor, byDay, onSelectEvent, onSelectDay }) {
  const first = startOfMonth(anchor);
  const gridStart = startOfWeek(first);
  const month = first.slice(0, 7);
  const today = todayKey();

  // Six rows always. A month that fits in five still gets six, because a grid
  // that changes height as you page through the year is unpleasant to use.
  const cells = Array.from({ length: 42 }, (_, i) => addDays(gridStart, i));

  return (
    <div className="card overflow-hidden">
      <div className="grid grid-cols-7 border-b border-line bg-[var(--color-canvas)]">
        {WEEKDAYS.map((d) => (
          <div key={d} className="px-2 py-2 text-[11px] font-semibold text-[var(--color-muted)] text-center">{d}</div>
        ))}
      </div>
      <div className="grid grid-cols-7" style={{ gridAutoRows: 'minmax(104px, auto)' }}>
        {cells.map((key) => {
          const events = byDay.get(key) || [];
          const outside = !key.startsWith(month);
          const isToday = key === today;
          return (
            <div key={key}
              className={`border-b border-r border-line/70 p-1.5 min-w-0 ${outside ? 'bg-[var(--color-canvas)]/50' : ''}`}>
              <button onClick={() => onSelectDay(key)}
                className={`w-6 h-6 rounded-full text-xs font-medium mb-1 flex items-center justify-center
                  ${isToday ? 'text-white' : outside ? 'text-[var(--color-muted)]/60' : 'text-ink hover:bg-canvas'}`}
                style={isToday ? { background: 'var(--color-brand)' } : undefined}>
                {Number(key.slice(8))}
              </button>
              <div className="space-y-0.5">
                {events.slice(0, 3).map((e) => (
                  <EventChip key={e.id} event={e} onClick={onSelectEvent} compact />
                ))}
                {events.length > 3 && (
                  <button onClick={() => onSelectDay(key)}
                    className="text-[11px] text-[var(--color-muted)] hover:text-ink px-1.5">
                    +{events.length - 3} more
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Week and day share one time grid; a day view is a week view with one column.
function TimeGridView({ days, byDay, onSelectEvent, onCreateAt }) {
  const scrollRef = useRef(null);
  const today = todayKey();

  // Open at 7am rather than midnight — nobody's working day starts at the top
  // of the grid, and scrolling past seven empty hours every time is friction.
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 7 * 48;
  }, [days[0]]);

  const allDayRows = days.map((d) => (byDay.get(d) || []).filter((e) => e.all_day));
  const hasAllDay = allDayRows.some((r) => r.length);

  return (
    <div className="card overflow-hidden">
      <div className="grid border-b border-line bg-[var(--color-canvas)]"
        style={{ gridTemplateColumns: `56px repeat(${days.length}, minmax(0, 1fr))` }}>
        <div />
        {days.map((d) => (
          <div key={d} className="px-2 py-2 text-center border-l border-line/70">
            <p className="text-[11px] text-[var(--color-muted)]">{WEEKDAYS[(dateFromKey(d).getDay() + 6) % 7]}</p>
            <p className={`text-sm font-semibold ${d === today ? 'text-[var(--color-brand)]' : 'text-ink'}`}>
              {Number(d.slice(8))}
            </p>
          </div>
        ))}
      </div>

      {hasAllDay && (
        <div className="grid border-b border-line" style={{ gridTemplateColumns: `56px repeat(${days.length}, minmax(0, 1fr))` }}>
          <div className="text-[10px] text-[var(--color-muted)] px-1 py-1.5 text-right">all day</div>
          {days.map((d, i) => (
            <div key={d} className="border-l border-line/70 p-1 space-y-0.5 min-w-0">
              {allDayRows[i].map((e) => <EventChip key={e.id} event={e} onClick={onSelectEvent} compact />)}
            </div>
          ))}
        </div>
      )}

      <div ref={scrollRef} className="overflow-y-auto" style={{ maxHeight: '60vh' }}>
        <div className="grid relative" style={{ gridTemplateColumns: `56px repeat(${days.length}, minmax(0, 1fr))` }}>
          <div>
            {Array.from({ length: 24 }, (_, h) => (
              <div key={h} className="h-12 text-[10px] text-[var(--color-muted)] text-right pr-1.5 -translate-y-1.5">
                {h === 0 ? '' : `${((h + 11) % 12) + 1} ${h < 12 ? 'am' : 'pm'}`}
              </div>
            ))}
          </div>
          {days.map((d) => {
            const timed = (byDay.get(d) || []).filter((e) => !e.all_day);
            return (
              <div key={d} className="relative border-l border-line/70">
                {Array.from({ length: 24 }, (_, h) => (
                  <button key={h} onClick={() => onCreateAt(d, h)}
                    className="h-12 border-b border-line/40 w-full hover:bg-canvas/60 block" />
                ))}
                {timed.map((e) => {
                  const top = (minutesIntoDay(e.start_at) / 60) * 48;
                  const mins = Math.max(20,
                    (new Date(e.end_at || e.start_at) - new Date(e.start_at)) / 60000);
                  const s = styleFor(e.source);
                  return (
                    <button key={e.id} onClick={() => onSelectEvent(e)}
                      className="absolute left-0.5 right-0.5 rounded-md border px-1.5 py-0.5 text-left overflow-hidden hover:brightness-95"
                      style={{
                        top, height: Math.max((mins / 60) * 48 - 2, 18),
                        background: s.bg, borderColor: s.border, color: s.text,
                      }}>
                      <span className="text-[11px] font-medium block truncate">{e.title}</span>
                      {mins >= 45 && <span className="text-[10px] opacity-80 block truncate">{fmtTime(e.start_at)}</span>}
                    </button>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function AgendaView({ events, onSelectEvent }) {
  const groups = useMemo(() => {
    const m = new Map();
    for (const e of events) {
      const k = dayKey(e.start_at);
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(e);
    }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [events]);

  if (!groups.length) {
    return <EmptyState icon={CalendarDays} title="Nothing scheduled"
      description="No meetings, tasks or calendar events in this period." />;
  }

  return (
    <div className="space-y-5">
      {groups.map(([key, items]) => (
        <div key={key}>
          <h3 className={`text-sm font-semibold mb-2 ${key === todayKey() ? 'text-[var(--color-brand)]' : 'text-ink'}`}>
            {fmtDateLong(key)}{key === todayKey() && ' · Today'}
          </h3>
          <div className="card divide-y divide-line/60">
            {items.map((e) => {
              const s = styleFor(e.source);
              return (
                <button key={e.id} onClick={() => onSelectEvent(e)}
                  className="w-full text-left px-4 py-3 flex items-start gap-3 hover:bg-canvas/60">
                  <span className="w-1 self-stretch rounded-full shrink-0" style={{ background: s.dot }} />
                  <span className="w-[86px] shrink-0 text-xs text-[var(--color-muted)] tabular-nums pt-0.5">
                    {e.all_day ? 'All day' : fmtTime(e.start_at)}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium text-ink truncate">{e.title}</span>
                    <span className="block text-xs text-[var(--color-muted)] truncate">
                      {[s.label, e.related_label, e.location, e.owner_name].filter(Boolean).join(' · ')}
                    </span>
                  </span>
                  {e.extra?.overdue && (
                    <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full shrink-0"
                      style={{ background: '#FEF2F2', color: '#B91C1C' }}>overdue</span>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Event detail
// ---------------------------------------------------------------------------

function EventDetail({ event, onClose, onEdit, onDelete, can }) {
  if (!event) return null;
  const s = styleFor(event.source);
  const isCrmMeeting = event.source === 'meeting';
  return (
    <div className="fixed inset-0 z-[70] flex items-end sm:items-center justify-center p-0 sm:p-4">
      <div className="absolute inset-0 bg-ink/30" onClick={onClose} />
      <div className="relative bg-white rounded-t-2xl sm:rounded-2xl shadow-2xl w-full sm:max-w-lg max-h-[88vh] overflow-y-auto">
        <div className="h-1.5 rounded-t-2xl" style={{ background: s.dot }} />
        <div className="p-5">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: s.text }}>{s.label}</p>
              <h2 className="font-display text-lg font-semibold text-ink mt-0.5 break-words">{event.title}</h2>
            </div>
            <button onClick={onClose} className="w-8 h-8 rounded-lg flex items-center justify-center hover:bg-canvas shrink-0">
              <X className="w-4 h-4 text-[var(--color-muted)]" />
            </button>
          </div>

          <dl className="mt-4 space-y-2.5 text-sm">
            <div className="flex gap-2.5">
              <Clock className="w-4 h-4 text-[var(--color-muted)] mt-0.5 shrink-0" />
              <dd className="text-ink">
                {event.all_day
                  ? `${fmtDateLong(dayKey(event.start_at))} · all day`
                  : `${fmtDateLong(dayKey(event.start_at))}, ${fmtTime(event.start_at)} – ${fmtTime(event.end_at)}`}
              </dd>
            </div>
            {event.location && (
              <div className="flex gap-2.5">
                <MapPin className="w-4 h-4 text-[var(--color-muted)] mt-0.5 shrink-0" />
                <dd className="text-ink break-words">{event.location}</dd>
              </div>
            )}
            {event.online_meeting_url && (
              <div className="flex gap-2.5">
                <Video className="w-4 h-4 text-[var(--color-muted)] mt-0.5 shrink-0" />
                <dd><a href={event.online_meeting_url} target="_blank" rel="noreferrer"
                  className="text-[var(--color-brand)] hover:underline break-all">Join the meeting</a></dd>
              </div>
            )}
            {event.related_module && event.related_record_id && (
              <div className="flex gap-2.5">
                <Link2 className="w-4 h-4 text-[var(--color-muted)] mt-0.5 shrink-0" />
                <dd>
                  <Link to={`/records/${event.related_module}/${event.related_record_id}`}
                    className="text-[var(--color-brand)] hover:underline">
                    {event.related_label || `${event.related_module} #${event.related_record_id}`}
                  </Link>
                  <span className="text-[var(--color-muted)] text-xs ml-1">({event.related_module})</span>
                </dd>
              </div>
            )}
            {event.owner_name && (
              <div className="flex gap-2.5">
                <User className="w-4 h-4 text-[var(--color-muted)] mt-0.5 shrink-0" />
                <dd className="text-ink">{event.owner_name}</dd>
              </div>
            )}
            {!!(event.attendees || []).length && (
              <div className="flex gap-2.5">
                <Users className="w-4 h-4 text-[var(--color-muted)] mt-0.5 shrink-0" />
                <dd className="text-ink text-xs break-words">
                  {event.attendees.map((a) => a.name || a.email).join(', ')}
                </dd>
              </div>
            )}
          </dl>

          {event.description && (
            <p className="mt-4 text-sm text-[var(--color-muted)] whitespace-pre-wrap break-words">{event.description}</p>
          )}

          <div className="mt-5 flex gap-2 flex-wrap">
            {isCrmMeeting && can('calendar', 'edit') && (
              <button onClick={() => onEdit(event)}
                className="text-xs font-semibold px-3 py-2 rounded-lg text-white" style={{ background: 'var(--color-ink)' }}>
                Edit
              </button>
            )}
            {isCrmMeeting && can('calendar', 'delete') && (
              <button onClick={() => onDelete(event)}
                className="text-xs font-medium px-3 py-2 rounded-lg border border-line text-[var(--color-danger)] hover:bg-canvas">
                <Trash2 className="w-3.5 h-3.5 inline mr-1" /> Delete
              </button>
            )}
            {event.web_link && (
              <a href={event.web_link} target="_blank" rel="noreferrer"
                className="text-xs font-medium px-3 py-2 rounded-lg border border-line hover:bg-canvas inline-flex items-center gap-1">
                <ExternalLink className="w-3.5 h-3.5" /> Open in {styleFor(event.source).label}
              </a>
            )}
            {!isCrmMeeting && !event.web_link && (
              <p className="text-xs text-[var(--color-muted)]">
                {event.source === 'task' || event.source === 'call'
                  ? 'Edit this from the record it belongs to.'
                  : 'This event lives in your connected calendar and is read-only here.'}
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Create / edit
// ---------------------------------------------------------------------------

// A platform choice reads better as a set of chips than a dropdown — the
// options are few, and which ones exist is itself information.
function PlatformChip({ active, onClick, label, tone }) {
  return (
    <button type="button" onClick={onClick}
      className="text-[12px] font-semibold px-3 py-1.5 rounded-lg transition-colors"
      style={active
        ? { background: tone || 'var(--color-brand)', color: '#fff', border: `1px solid ${tone || 'var(--color-brand)'}` }
        : { background: '#fff', color: 'var(--color-muted)', border: '1px solid var(--color-line)' }}>
      {label}
    </button>
  );
}

function EventForm({ initial, onClose, onSaved }) {
  const [form, setForm] = useState(() => ({
    meeting_title: initial?.meeting_title || '',
    start: initial?.start || toLocalInput(new Date().toISOString()),
    end: initial?.end || toLocalInput(new Date(Date.now() + 3600000).toISOString()),
    all_day: initial?.all_day || false,
    location: initial?.location || '',
    video_link: initial?.video_link || '',
    agenda: initial?.agenda || '',
    meeting_type: initial?.meeting_type || 'Online',
    related_module: initial?.related_module || '',
    related_record_id: initial?.related_record_id || '',
    reminder_minutes: initial?.reminder_minutes ?? 15,
    online_platform: initial?.online_platform || '',
  }));
  // The picked record as a human-readable object. The numeric id still goes
  // to the server; it is simply no longer what the user sees or types.
  const [record, setRecord] = useState(initial?.related_record || null);
  const [attendees, setAttendees] = useState(initial?.attendees || []);
  // Which online platforms this user can actually create a meeting on.
  const [providers, setProviders] = useState(null);
  useEffect(() => {
    api.calendarConnections()
      .then((rows) => setProviders((rows || []).filter((c) => c.status === 'connected' && c.write_enabled)))
      .catch(() => setProviders([]));
  }, []);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [conflicts, setConflicts] = useState([]);
  const meetingId = initial?.meeting_id;

  // Warn about a clash while the form is open, not after saving. Checking as
  // the times change is the only version of this that actually prevents the
  // double-booking rather than reporting it.
  useEffect(() => {
    if (form.all_day || !form.start || !form.end) { setConflicts([]); return undefined; }
    const t = setTimeout(() => {
      const startIso = new Date(form.start).toISOString();
      const endIso = new Date(form.end).toISOString();
      api.calendarConflicts({ start: startIso, end: endIso, ignore_meeting_id: meetingId })
        .then(setConflicts).catch(() => setConflicts([]));
    }, 400);
    return () => clearTimeout(t);
  }, [form.start, form.end, form.all_day, meetingId]);

  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const submit = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      // Times are sent as the wall-clock strings the user typed, with the
      // browser's zone alongside, so the server records what they meant
      // rather than re-interpreting it in its own zone.
      const body = {
        meeting_title: form.meeting_title,
        start_datetime: form.all_day ? `${form.start.slice(0, 10)} 00:00:00` : `${form.start.replace('T', ' ')}:00`,
        end_datetime: form.all_day ? `${(form.end || form.start).slice(0, 10)} 23:59:00` : `${form.end.replace('T', ' ')}:00`,
        all_day: form.all_day ? 1 : 0,
        time_zone: VIEWER_TZ,
        location: form.location || null,
        video_link: form.video_link || null,
        agenda: form.agenda || null,
        meeting_type: form.meeting_type,
        related_module: record ? record.module : null,
        related_record_id: record ? record.id : null,
        reminder_minutes: form.reminder_minutes === '' ? null : Number(form.reminder_minutes),
        attendees: attendees.map((a) => ({
          kind: a.kind, module: a.module, record_id: a.record_id, name: a.name, email: a.email,
        })),
        online_platform: form.online_platform || null,
      };
      if (meetingId) await api.updateCalendarEvent(meetingId, body);
      else await api.createCalendarEvent(body);
      onSaved();
    } catch (err) {
      setError(friendlyError(err, 'The meeting could not be saved.'));
      setSaving(false);
    }
  };

  const field = 'w-full border border-line rounded-lg px-3 py-2 text-sm min-w-0';

  return (
    <div className="fixed inset-0 z-[70] flex items-end sm:items-center justify-center p-0 sm:p-4">
      <div className="absolute inset-0 bg-ink/30" onClick={onClose} />
      <form onSubmit={submit}
        className="relative bg-white rounded-t-2xl sm:rounded-2xl shadow-2xl w-full sm:max-w-lg max-h-[88vh] overflow-y-auto p-5">
        <div className="flex items-center justify-between">
          <h2 className="font-display text-lg font-semibold text-ink">
            {meetingId ? 'Edit meeting' : 'New meeting'}
          </h2>
          <button type="button" onClick={onClose} className="w-8 h-8 rounded-lg flex items-center justify-center hover:bg-canvas">
            <X className="w-4 h-4 text-[var(--color-muted)]" />
          </button>
        </div>

        <div className="space-y-3 mt-4">
          <label className="block">
            <span className="block text-xs font-medium text-ink mb-1">Title *</span>
            <input value={form.meeting_title} onChange={(e) => set('meeting_title', e.target.value)}
              required autoFocus className={field} placeholder="Demo with Sunrise Technologies" />
          </label>

          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={form.all_day} onChange={(e) => set('all_day', e.target.checked)}
              className="w-4 h-4 accent-amber" />
            All day
          </label>

          <div className="grid grid-cols-2 gap-3">
            <label className="block min-w-0">
              <span className="block text-xs font-medium text-ink mb-1">Starts *</span>
              <input type={form.all_day ? 'date' : 'datetime-local'}
                value={form.all_day ? form.start.slice(0, 10) : form.start}
                onChange={(e) => set('start', e.target.value)} required className={field} />
            </label>
            <label className="block min-w-0">
              <span className="block text-xs font-medium text-ink mb-1">Ends</span>
              <input type={form.all_day ? 'date' : 'datetime-local'}
                value={form.all_day ? (form.end || form.start).slice(0, 10) : form.end}
                onChange={(e) => set('end', e.target.value)} className={field} />
            </label>
          </div>

          {conflicts.length > 0 && (
            <div className="rounded-lg border px-3 py-2 flex gap-2"
              style={{ background: '#FFFBEB', borderColor: '#FDE68A' }}>
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" style={{ color: '#B45309' }} />
              <div className="text-xs" style={{ color: '#92400E' }}>
                <p className="font-semibold">
                  That overlaps {conflicts.length} thing{conflicts.length === 1 ? '' : 's'} already in your calendar:
                </p>
                <ul className="mt-1 space-y-0.5">
                  {conflicts.slice(0, 3).map((c) => (
                    <li key={c.id}>• {c.title} ({fmtTime(c.start_at)}–{fmtTime(c.end_at)})</li>
                  ))}
                </ul>
                <p className="mt-1 opacity-80">You can still save it — this is a warning, not a block.</p>
              </div>
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <label className="block min-w-0">
              <span className="block text-xs font-medium text-ink mb-1">Type</span>
              <select value={form.meeting_type} onChange={(e) => set('meeting_type', e.target.value)} className={field}>
                {['Online', 'Onsite', 'Office', 'Call'].map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            </label>
            <label className="block min-w-0">
              <span className="block text-xs font-medium text-ink mb-1">Reminder</span>
              <select value={form.reminder_minutes} onChange={(e) => set('reminder_minutes', e.target.value)} className={field}>
                <option value="">No reminder</option>
                {[5, 10, 15, 30, 60, 120, 1440].map((m) => (
                  <option key={m} value={m}>{m >= 1440 ? '1 day before' : `${m} minutes before`}</option>
                ))}
              </select>
            </label>
          </div>

          <label className="block">
            <span className="block text-xs font-medium text-ink mb-1">Location</span>
            <input value={form.location} onChange={(e) => set('location', e.target.value)} className={field}
              placeholder="Office, customer site, or a city" />
          </label>

          {/* Online meeting (§5, §6). The platform list is exactly what this
              user has connected — offering Google Meet with no Google
              account attached would promise a link the CRM cannot create.
              There is no free-text link box any more: a join URL comes back
              from the provider or it does not exist. */}
          <div className="block">
            <span className="block text-xs font-medium mb-1" style={{ color: 'var(--color-ink)' }}>Online meeting</span>
            {providers === null ? (
              <div className="skeleton h-9 rounded-lg" />
            ) : providers.length === 0 ? (
              <div className="rounded-lg px-3 py-2.5 text-[12px] flex items-start gap-2"
                style={{ background: 'var(--color-warning-soft)', border: '1px solid #FDE68A', color: 'var(--color-warning-strong)' }}>
                <span className="shrink-0">⚠</span>
                <span>
                  No calendar connected, so a Meet or Teams link cannot be created.{' '}
                  <Link to="/settings/calendar" className="font-semibold underline">Connect a calendar</Link>{' '}
                  to schedule online meetings.
                </span>
              </div>
            ) : (
              <div className="flex flex-wrap gap-2">
                <PlatformChip active={!form.online_platform} onClick={() => set('online_platform', '')}
                  label="In person" />
                {providers.some((p) => p.provider === 'google') && (
                  <PlatformChip active={form.online_platform === 'google_meet'}
                    onClick={() => set('online_platform', 'google_meet')} label="Google Meet" tone="#10B981" />
                )}
                {providers.some((p) => p.provider === 'microsoft') && (
                  <PlatformChip active={form.online_platform === 'teams'}
                    onClick={() => set('online_platform', 'teams')} label="Microsoft Teams" tone="#3B82F6" />
                )}
              </div>
            )}
            {form.online_platform && (
              <p className="text-[11px] mt-1.5" style={{ color: 'var(--color-muted)' }}>
                The join link is created by the provider when this meeting syncs, and appears here once it exists.
              </p>
            )}
            {initial?.video_link && (
              <a href={initial.video_link} target="_blank" rel="noreferrer"
                className="inline-flex items-center gap-1.5 text-[12px] font-semibold mt-2"
                style={{ color: 'var(--color-brand)' }}>
                Join meeting →
              </a>
            )}
          </div>

          {/* Participants (§8–§14). */}
          <AttendeePicker value={attendees} onChange={setAttendees} />

          {/* Linking to a record is what makes this a CRM calendar rather than
              a second inbox — the meeting then shows on the account, the deal
              and the customer timeline. */}
          {/* Was two fields: a module dropdown and a box asking for a numeric
              "Record ID (e.g. 412)". One search across every module replaces
              both — search by name, company, email or phone, and the id is
              kept internally (§38–§44). */}
          <RecordPicker value={record} onChange={setRecord} />

          <label className="block">
            <span className="block text-xs font-medium text-ink mb-1">Agenda</span>
            <textarea value={form.agenda} onChange={(e) => set('agenda', e.target.value)} rows={3} className={field}
              placeholder="What needs to be covered" />
          </label>
        </div>

        {error && <p className="text-xs text-[var(--color-danger)] mt-3">{error}</p>}

        <div className="flex gap-2 mt-5">
          <button type="submit" disabled={saving}
            className="text-sm font-semibold px-4 py-2 rounded-lg text-white disabled:opacity-60"
            style={{ background: 'var(--color-ink)' }}>
            {saving ? 'Saving…' : meetingId ? 'Save changes' : 'Create meeting'}
          </button>
          <button type="button" onClick={onClose}
            className="text-sm font-medium px-4 py-2 rounded-lg border border-line hover:bg-canvas">Cancel</button>
        </div>
        <p className="t-meta mt-3">
          Saved to the CRM and pushed to your connected calendars. Times are in {VIEWER_TZ}.
        </p>
      </form>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------

const VIEWS = [['month', 'Month'], ['week', 'Week'], ['day', 'Day'], ['agenda', 'Agenda']];

export default function CalendarPage() {
  const can = usePermissions();
  const [params, setParams] = useSearchParams();
  const [view, setView] = useState(params.get('view') || 'month');
  const [anchor, setAnchor] = useState(params.get('date') || todayKey());
  const [scope, setScope] = useState('mine');
  const [sources, setSources] = useState(['meeting', 'task', 'call', 'external']);
  const [events, setEvents] = useState([]);
  const [connections, setConnections] = useState([]);
  const [syncIssues, setSyncIssues] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [selected, setSelected] = useState(null);
  const [editing, setEditing] = useState(null);

  // The instants bounding the current view. The month grid shows six weeks, so
  // the range is the grid's, not the calendar month's — otherwise events in
  // the leading and trailing days are silently missing.
  const range = useMemo(() => {
    if (view === 'month') {
      const gridStart = startOfWeek(startOfMonth(anchor));
      return { fromKey: gridStart, toKey: addDays(gridStart, 42) };
    }
    if (view === 'week') {
      const s = startOfWeek(anchor);
      return { fromKey: s, toKey: addDays(s, 7) };
    }
    if (view === 'day') return { fromKey: anchor, toKey: addDays(anchor, 1) };
    return { fromKey: anchor, toKey: addDays(anchor, 30) };     // agenda
  }, [view, anchor]);

  const load = useCallback((withSync = true) => {
    setLoading(true);
    // Local midnight of each boundary, as an instant.
    const from = dateFromKey(range.fromKey).toISOString();
    const to = dateFromKey(range.toKey).toISOString();
    api.calendarEvents({ from, to, scope, sources: sources.join(','), sync: withSync ? undefined : '0' })
      .then((res) => {
        setEvents(res.events || []);
        setConnections(res.connections || []);
        setSyncIssues(res.sync || []);
        setError(null);
      })
      .catch((e) => setError(friendlyError(e, 'The calendar could not be loaded.')))
      .finally(() => setLoading(false));
  }, [range.fromKey, range.toKey, scope, sources]);

  useEffect(() => { load(); }, [load]);

  // Keep the view in the URL so a calendar can be linked to and survives a
  // refresh on the day someone was looking at.
  useEffect(() => {
    setParams({ view, date: anchor }, { replace: true });
  }, [view, anchor, setParams]);

  const byDay = useMemo(() => {
    const m = new Map();
    for (const e of events) {
      // A multi-day event belongs in every day it covers, or a three-day
      // conference only appears on the day it starts.
      const start = dayKey(e.start_at);
      const end = dayKey(e.end_at) || start;
      if (!start) continue;
      let k = start;
      let guard = 0;
      while (k <= end && guard < 90) {
        if (!m.has(k)) m.set(k, []);
        m.get(k).push(e);
        k = addDays(k, 1);
        guard += 1;
      }
    }
    for (const list of m.values()) {
      list.sort((a, b) => (a.all_day === b.all_day
        ? String(a.start_at).localeCompare(String(b.start_at))
        : (a.all_day ? -1 : 1)));
    }
    return m;
  }, [events]);

  const title = view === 'month' ? fmtMonthTitle(anchor)
    : view === 'day' ? fmtDateLong(anchor)
      : view === 'week' ? `${fmtDateLong(startOfWeek(anchor)).replace(/^\w+, /, '')} – ${fmtDateLong(addDays(startOfWeek(anchor), 6)).replace(/^\w+, /, '')}`
        : 'Next 30 days';

  const step = (dir) => {
    if (view === 'month') setAnchor(addMonths(anchor, dir));
    else if (view === 'week') setAnchor(addDays(anchor, dir * 7));
    else setAnchor(addDays(anchor, dir));
  };

  const toggleSource = (key) => {
    setSources((s) => (s.includes(key) ? s.filter((x) => x !== key) : [...s, key]));
  };

  const openCreate = (dayKeyValue, hour) => {
    if (!can('calendar', 'create')) return;
    const start = new Date(dateFromKey(dayKeyValue));
    start.setHours(hour ?? 10, 0, 0, 0);
    const end = new Date(start.getTime() + 3600000);
    setEditing({ start: toLocalInput(start.toISOString()), end: toLocalInput(end.toISOString()) });
  };

  const removeEvent = async (event) => {
    // eslint-disable-next-line no-alert
    if (!window.confirm(`Delete "${event.title}"? It will also be removed from your connected calendars.`)) return;
    await api.deleteCalendarEvent(event.meeting_id);
    setSelected(null);
    load(false);
  };

  const legendSources = ['meeting', 'task', 'call'];
  const connectedProviders = [...new Set(connections.map((c) => c.provider))];

  return (
    <div className="max-w-[1600px] mx-auto">
      <PageHeader
        title="Calendar"
        subtitle="Meetings, task deadlines and calls, alongside your own Google or Outlook calendar."
        icon={CalendarDays}
        accent="meetings"
      >
        {can('calendar', 'create') && (
          <button onClick={() => openCreate(todayKey(), 10)}
            className="flex items-center gap-1.5 text-xs font-semibold px-3 py-2 rounded-lg text-white"
            style={{ background: 'var(--color-ink)' }}>
            <Plus className="w-4 h-4" /> New meeting
          </button>
        )}
      </PageHeader>

      {/* Connection state: the one thing that explains "why can't I see my
          Google events". Only shown when there is something to say. */}
      {(connections.some((c) => c.status !== 'connected') || syncIssues.length > 0) && (
        <div className="rounded-xl border px-4 py-3 mt-5 flex items-start gap-2.5"
          style={{ background: '#FFFBEB', borderColor: '#FDE68A' }}>
          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" style={{ color: '#B45309' }} />
          <div className="text-xs min-w-0" style={{ color: '#92400E' }}>
            <p className="font-semibold">Some calendars are not syncing.</p>
            <p className="mt-0.5">
              {connections.filter((c) => c.status !== 'connected').map((c) => c.last_sync_error).filter(Boolean)[0]
                || syncIssues[0]?.error
                || 'The last sync did not complete.'}
            </p>
            <Link to="/settings/calendar" className="underline font-medium mt-1 inline-block">
              Open calendar settings
            </Link>
          </div>
        </div>
      )}

      {/* Toolbar */}
      <div className="flex items-center gap-2 flex-wrap mt-5">
        <div className="flex items-center gap-1">
          <button onClick={() => step(-1)} className="w-8 h-8 rounded-lg border border-line flex items-center justify-center hover:bg-canvas">
            <ChevronLeft className="w-4 h-4" />
          </button>
          <button onClick={() => setAnchor(todayKey())}
            className="text-xs font-medium px-3 h-8 rounded-lg border border-line hover:bg-canvas">Today</button>
          <button onClick={() => step(1)} className="w-8 h-8 rounded-lg border border-line flex items-center justify-center hover:bg-canvas">
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>

        <h2 className="font-display text-lg font-semibold text-ink mx-1 min-w-0 truncate">{title}</h2>

        <div className="flex gap-1 ml-auto">
          {VIEWS.map(([key, label]) => (
            <button key={key} onClick={() => setView(key)}
              className={`text-xs font-medium px-2.5 h-8 rounded-lg border ${
                view === key ? 'bg-ink text-white border-ink' : 'border-line text-[var(--color-muted)] hover:border-ink/40'}`}>
              {label}
            </button>
          ))}
        </div>

        <div className="flex gap-1">
          <button onClick={() => setScope(scope === 'mine' ? 'team' : 'mine')}
            title={scope === 'mine' ? 'Showing only your items' : 'Showing the whole team'}
            className="text-xs font-medium px-2.5 h-8 rounded-lg border border-line hover:bg-canvas inline-flex items-center gap-1.5">
            {scope === 'mine' ? <User className="w-3.5 h-3.5" /> : <Users className="w-3.5 h-3.5" />}
            {scope === 'mine' ? 'Mine' : 'Team'}
          </button>
          <button onClick={() => load(true)} title="Sync now"
            className="w-8 h-8 rounded-lg border border-line flex items-center justify-center hover:bg-canvas">
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          </button>
          <button onClick={() => api.downloadCalendarIcs().catch((e) => setError(friendlyError(e, 'The export failed.')))}
            title="Download as .ics for another calendar app"
            className="w-8 h-8 rounded-lg border border-line flex items-center justify-center hover:bg-canvas">
            <Download className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Legend doubles as the source filter. */}
      <div className="flex items-center gap-2 flex-wrap mt-3">
        {legendSources.map((key) => {
          const s = SOURCE_STYLE[key];
          const on = sources.includes(key);
          const Icon = key === 'task' ? ListTodo : key === 'call' ? Phone : CalendarDays;
          return (
            <button key={key} onClick={() => toggleSource(key)}
              className={`text-[11px] font-medium px-2 py-1 rounded-full border inline-flex items-center gap-1.5 ${
                on ? '' : 'opacity-45'}`}
              style={{ background: on ? s.bg : 'transparent', borderColor: s.border, color: s.text }}>
              <Icon className="w-3 h-3" /> {s.label}
            </button>
          );
        })}
        <button onClick={() => toggleSource('external')}
          className={`text-[11px] font-medium px-2 py-1 rounded-full border inline-flex items-center gap-1.5 ${
            sources.includes('external') ? '' : 'opacity-45'}`}
          style={{
            background: sources.includes('external') ? '#F8FAFC' : 'transparent',
            borderColor: 'var(--color-line)',
            color: 'var(--color-muted)',
          }}>
          {connectedProviders.length ? (
            <>
              {connectedProviders.map((p) => (
                <span key={p} className="w-2 h-2 rounded-full" style={{ background: styleFor(p).dot }} />
              ))}
              Connected calendars
            </>
          ) : 'Connected calendars'}
        </button>
        {connections.length === 0 && (
          <Link to="/settings/calendar"
            className="text-[11px] font-medium px-2 py-1 rounded-full border border-dashed border-line text-[var(--color-brand)] hover:bg-canvas">
            + Connect Google or Outlook
          </Link>
        )}
      </div>

      {error && <p className="text-sm text-[var(--color-danger)] mt-4">{error}</p>}

      <div className="mt-4">
        {view === 'month' && (
          <MonthView anchor={anchor} byDay={byDay}
            onSelectEvent={setSelected}
            onSelectDay={(k) => { setAnchor(k); setView('day'); }} />
        )}
        {view === 'week' && (
          <TimeGridView days={Array.from({ length: 7 }, (_, i) => addDays(startOfWeek(anchor), i))}
            byDay={byDay} onSelectEvent={setSelected} onCreateAt={openCreate} />
        )}
        {view === 'day' && (
          <TimeGridView days={[anchor]} byDay={byDay} onSelectEvent={setSelected} onCreateAt={openCreate} />
        )}
        {view === 'agenda' && <AgendaView events={events} onSelectEvent={setSelected} />}
      </div>

      {!loading && events.length === 0 && view !== 'agenda' && (
        <p className="t-meta text-center mt-4">
          Nothing scheduled in this period.
          {connections.length === 0 && ' Connect a calendar in settings to see your existing events here.'}
        </p>
      )}

      {selected && (
        <EventDetail event={selected} can={can}
          onClose={() => setSelected(null)}
          onEdit={(e) => {
            setEditing({
              meeting_id: e.meeting_id,
              meeting_title: e.title,
              start: toLocalInput(e.start_at),
              end: toLocalInput(e.end_at || e.start_at),
              all_day: e.all_day,
              location: e.location || '',
              video_link: e.online_meeting_url || '',
              agenda: e.description || '',
              related_module: e.related_module || '',
              related_record_id: e.related_record_id || '',
            });
            setSelected(null);
          }}
          onDelete={removeEvent} />
      )}

      {editing && (
        <EventForm initial={editing} onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); load(false); }} />
      )}
    </div>
  );
}
