/*
 * One meeting, as a card.
 *
 * WHY A SHARED COMPONENT
 * A lead's Meetings tab used to render a meeting as two lines of plain text
 * with a raw timestamp ("2026-09-25T18:10") and no way to click through to the
 * record. The same meeting on an account was a table row. Same data, two
 * treatments, neither of them good.
 *
 * Both now render this, so they are identical by construction rather than by
 * somebody remembering to change two files. The whole card is the link —
 * a meeting is one thing, so the target should be the whole thing, not a
 * four-word phrase inside it.
 */
import { Link } from 'react-router-dom';
import { Calendar, MapPin, Video, Users } from 'lucide-react';

// Matches the badge conventions used elsewhere in the app: success for done,
// danger for cancelled, brand for still ahead of you, warning for moved.
// The status values in this database are Scheduled / Held / No Show /
// Cancelled — "Completed" is what the newer forms write, so both are mapped
// rather than letting a real status fall through to the default and read as
// still-upcoming when it already happened.
const STATUS_TONE = {
  Scheduled: { bg: 'var(--color-brand-soft)', fg: 'var(--color-brand)' },
  Held: { bg: 'var(--color-success-soft)', fg: 'var(--color-success-strong)' },
  Completed: { bg: 'var(--color-success-soft)', fg: 'var(--color-success-strong)' },
  Cancelled: { bg: 'var(--color-danger-soft)', fg: 'var(--color-danger-strong)' },
  'No Show': { bg: 'var(--color-warning-soft)', fg: 'var(--color-warning-strong)' },
  Rescheduled: { bg: 'var(--color-warning-soft)', fg: 'var(--color-warning-strong)' },
};

// SQLite hands back "YYYY-MM-DD HH:MM:SS", which `new Date()` reads as UTC in
// Safari and as local time in Chrome — the kind of difference that silently
// shifts every meeting by hours on one browser. Parsed by hand instead.
function parseStamp(value) {
  if (!value) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(String(value));
  if (m) return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

// "Thu, Sep 25 · 6:10 PM" — the year only when it isn't this one, because
// almost every meeting you look at is in the current year and repeating it
// on every row is noise.
export function formatMeetingTime(start, end) {
  const s = parseStamp(start);
  if (!s) return 'No date set';
  const sameYear = s.getFullYear() === new Date().getFullYear();
  const day = s.toLocaleDateString(undefined, {
    weekday: 'short', month: 'short', day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
  });
  const time = s.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', hour12: true });
  const e = parseStamp(end);
  const endTime = e && e > s
    ? e.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', hour12: true })
    : null;
  return `${day} · ${time}${endTime ? ` – ${endTime}` : ''}`;
}

function Chip({ icon: Icon, children }) {
  return (
    <span className="inline-flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded max-w-[180px]"
      style={{ background: 'var(--color-canvas)', color: 'var(--color-muted)' }}>
      {Icon && <Icon className="w-3 h-3 shrink-0" />}
      <span className="truncate">{children}</span>
    </span>
  );
}

// The people on the meeting, from whichever shape the row carries. Attendees
// are stored as JSON, and a row that predates that column simply has none —
// which is a reason to show nothing, not to throw.
function attendeeNames(meeting) {
  if (Array.isArray(meeting.attendees)) return meeting.attendees.map((a) => a.name || a.email).filter(Boolean);
  if (!meeting.attendees_json) return [];
  try {
    const parsed = JSON.parse(meeting.attendees_json);
    return Array.isArray(parsed) ? parsed.map((a) => a.name || a.email).filter(Boolean) : [];
  } catch { return []; }
}

export default function MeetingCard({ meeting, to }) {
  const status = meeting.status || 'Scheduled';
  const tone = STATUS_TONE[status] || STATUS_TONE.Scheduled;
  const people = attendeeNames(meeting);
  const href = to || `/records/meetings/${meeting.id}`;
  const isOnline = Boolean(meeting.video_link || meeting.online_platform);

  return (
    <Link to={href}
      className="flex items-start gap-3 rounded-xl px-3 py-2.5 transition-all"
      style={{ background: '#fff', border: '1px solid var(--color-line)' }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = 'var(--color-brand-faint)';
        e.currentTarget.style.borderColor = 'var(--color-brand-border)';
        e.currentTarget.style.boxShadow = '0 2px 8px rgba(23,35,60,.07)';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = '#fff';
        e.currentTarget.style.borderColor = 'var(--color-line)';
        e.currentTarget.style.boxShadow = 'none';
      }}>
      <span className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0"
        style={{ background: 'var(--color-brand-soft)', color: 'var(--color-brand)' }}>
        <Calendar className="w-4 h-4" />
      </span>

      <div className="min-w-0 flex-1">
        <div className="flex items-start justify-between gap-2">
          <span className="text-[13px] font-semibold truncate" style={{ color: 'var(--color-ink)' }}>
            {meeting.meeting_title || 'Untitled meeting'}
          </span>
          <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded shrink-0"
            style={{ background: tone.bg, color: tone.fg }}>
            {status}
          </span>
        </div>

        <div className="text-[12px] mt-0.5" style={{ color: 'var(--color-muted)' }}>
          {formatMeetingTime(meeting.start_datetime, meeting.end_datetime)}
        </div>

        {(people.length > 0 || meeting.location || isOnline) && (
          <div className="flex flex-wrap items-center gap-1.5 mt-1.5">
            {people.slice(0, 2).map((n) => <Chip key={n} icon={Users}>{n}</Chip>)}
            {people.length > 2 && <Chip>+{people.length - 2} more</Chip>}
            {isOnline && <Chip icon={Video}>{meeting.online_platform === 'teams' ? 'Teams' : meeting.online_platform === 'google_meet' ? 'Google Meet' : 'Online'}</Chip>}
            {meeting.location && <Chip icon={MapPin}>{meeting.location}</Chip>}
          </div>
        )}
      </div>
    </Link>
  );
}
