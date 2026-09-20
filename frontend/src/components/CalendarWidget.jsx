/*
 * Global Calendar — quick popup.
 *
 * Deliberately the small-dropdown pattern (see NotificationBell.jsx), not the
 * full slide-over ChatWidget uses. The full Calendar module at /calendar
 * already exists for actually working with a month/week view; this is the
 * "what's coming up" glance from anywhere in the CRM, the way a phone's
 * calendar widget sits next to notifications rather than replacing the app.
 *
 * No new backend route: GET /calendar/agenda already returns the unified feed
 * (CRM meetings + tasks + calls + external Google/Microsoft events) for the
 * signed-in user, which is exactly what a quick popup needs. See
 * backend/routes/calendar.js and backend/services/calendar/feed.js.
 */
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { CalendarDays, MapPin, Video, ChevronRight } from 'lucide-react';
import { api } from '../api';

const SOURCE_DOT = {
  meeting: 'bg-[var(--color-brand)]',
  task: 'bg-amber',
  call: 'bg-sky-500',
  google: 'bg-emerald-500',
  microsoft: 'bg-sky-600',
};

// Events arrive as UTC ISO (timed) or a plain YYYY-MM-DD (all-day) — see
// db-phase37-calendar.js's note on why. Both need to render as a friendly
// time and be bucketed into Today / Tomorrow / a weekday, the same three
// buckets a person actually thinks in when glancing at what's next.
function dayLabel(dateStr) {
  const d = new Date(`${dateStr}T00:00:00`);
  const today = new Date();
  const startOf = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate());
  const diffDays = Math.round((startOf(d) - startOf(today)) / 86400000);
  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Tomorrow';
  return d.toLocaleDateString([], { weekday: 'short', day: '2-digit', month: 'short' });
}

function timeLabel(event) {
  if (event.all_day) return 'All day';
  const d = new Date(event.start_at);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function dateKey(event) {
  return event.all_day ? event.start_at : String(event.start_at).slice(0, 10);
}

export default function CalendarWidget() {
  const [open, setOpen] = useState(false);
  const [events, setEvents] = useState([]);
  const [todayCount, setTodayCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const ref = useRef(null);
  const navigate = useNavigate();

  // This renders on every page (it lives in the header), so a failed fetch
  // must degrade to an empty popup rather than take the app down — same
  // reasoning as NotificationBell's load().
  const load = () => {
    setLoading(true);
    api.calendarAgenda(7)
      .then((d) => {
        const items = (d.events || []).slice().sort((a, b) => String(a.start_at).localeCompare(String(b.start_at)));
        setEvents(items);
        const todayKey = new Date().toISOString().slice(0, 10);
        setTodayCount(items.filter((e) => dateKey(e) === todayKey).length);
        setError('');
      })
      .catch(() => { setEvents([]); setTodayCount(0); setError("Couldn't load your calendar."); })
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    load();
    // Calendar events change far less often than chat/notifications, and
    // every open of this popup already refreshes on demand (see toggle
    // below) — a 3-minute background refresh is enough to keep the badge
    // honest without adding load for something this low-urgency.
    const interval = setInterval(load, 3 * 60000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    const onClickOutside = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, []);

  const toggle = () => {
    setOpen((s) => {
      if (!s) load(); // refresh the moment it's opened, not just every 3 min
      return !s;
    });
  };

  const openEvent = (event) => {
    setOpen(false);
    if (event.related_module && event.related_record_id) {
      navigate(`/records/${event.related_module}/${event.related_record_id}`);
    } else {
      navigate('/calendar');
    }
  };

  // Group the flat, sorted list into day buckets for display without losing
  // the sort order within each day.
  const groups = [];
  for (const event of events) {
    const key = dateKey(event);
    const last = groups[groups.length - 1];
    if (last && last.key === key) last.items.push(event);
    else groups.push({ key, items: [event] });
  }

  return (
    <div ref={ref} className="relative shrink-0">
      <button onClick={toggle} aria-label="Calendar" aria-haspopup="dialog" aria-expanded={open}
        className="relative p-2 text-slate-500 hover:text-ink">
        <CalendarDays className="w-5 h-5" />
        {todayCount > 0 && (
          <span className="absolute top-1 right-1 min-w-[16px] h-4 px-1 rounded-full bg-[var(--color-brand)] text-white text-[10px] font-semibold flex items-center justify-center">
            {todayCount > 9 ? '9+' : todayCount}
          </span>
        )}
      </button>

      {open && (
        <div role="dialog" aria-label="Upcoming events"
          className="absolute top-full right-0 mt-2 w-80 bg-white border border-line rounded-xl shadow-lg overflow-hidden z-50">
          <div className="flex items-center justify-between px-4 py-3 border-b border-line">
            <span className="text-sm font-semibold text-ink">Calendar</span>
            <button onClick={() => { setOpen(false); navigate('/calendar'); }}
              className="text-xs text-[var(--color-brand)] hover:underline flex items-center gap-0.5">
              Full calendar <ChevronRight className="w-3 h-3" />
            </button>
          </div>

          <div className="max-h-96 overflow-y-auto">
            {loading && <p className="text-sm text-slate-400 text-center py-8">Loading…</p>}
            {!loading && error && <p className="text-sm text-slate-400 text-center py-8">{error}</p>}
            {!loading && !error && events.length === 0 && (
              <p className="text-sm text-slate-400 text-center py-8">Nothing on your calendar this week.</p>
            )}
            {!loading && !error && groups.map((group) => (
              <div key={group.key}>
                <div className="px-4 pt-2.5 pb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400 bg-canvas/60">
                  {dayLabel(group.key)}
                </div>
                {group.items.map((event, i) => (
                  <button key={`${group.key}-${i}`} onClick={() => openEvent(event)}
                    className="w-full text-left px-4 py-2.5 flex items-start gap-3 border-b border-line/60 last:border-0 hover:bg-canvas">
                    <span className={`w-2 h-2 rounded-full shrink-0 mt-1.5 ${SOURCE_DOT[event.source] || 'bg-slate-400'}`} />
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium text-ink truncate">{event.title || 'Untitled'}</div>
                      <div className="text-xs text-slate-500 flex items-center gap-1.5 mt-0.5">
                        <span>{timeLabel(event)}</span>
                        {event.location && (
                          <span className="flex items-center gap-0.5 truncate">
                            <MapPin className="w-3 h-3 shrink-0" />{event.location}
                          </span>
                        )}
                        {event.online_meeting_url && !event.location && (
                          <span className="flex items-center gap-0.5"><Video className="w-3 h-3" />Online</span>
                        )}
                      </div>
                      {event.related_label && (
                        <div className="text-[11px] text-slate-400 truncate mt-0.5">{event.related_label}</div>
                      )}
                    </div>
                  </button>
                ))}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
