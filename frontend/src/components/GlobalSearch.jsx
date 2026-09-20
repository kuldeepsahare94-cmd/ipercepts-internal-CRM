import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search, X } from 'lucide-react';
import { api } from '../api';
import { ModuleIcon } from './moduleIcons';

// Legacy modules still have their own dedicated pages (from before the
// universal list/detail pages existed) rather than /records/:module — this
// maps those few over; anything not listed here uses the universal route.
const LEGACY_ROUTES = {
  leads: (id) => `/leads/${id}`,
  students: (id) => `/students/${id}`,
  companies_legacy: (id) => `/companies/${id}`,
  courses: () => `/courses`,
  admissions: (id) => `/admissions/${id}`,
};

export default function GlobalSearch() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [groups, setGroups] = useState([]);
  const [loading, setLoading] = useState(false);
  const ref = useRef(null);
  const navigate = useNavigate();

  useEffect(() => {
    const onClickOutside = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, []);

  useEffect(() => {
    if (!query.trim() || query.trim().length < 2) { setGroups([]); return; }
    setLoading(true);
    const q = query.trim();
    const timer = setTimeout(async () => {
      try {
        const { groups: g } = await api.globalSearch(q);
        setGroups(g);
      } finally {
        setLoading(false);
      }
    }, 250);
    return () => clearTimeout(timer);
  }, [query]);

  const goTo = (moduleApiName, id) => {
    const legacy = LEGACY_ROUTES[moduleApiName];
    navigate(legacy ? legacy(id) : `/records/${moduleApiName}/${id}`);
    setOpen(false);
    setQuery('');
  };

  const hasResults = groups.some((g) => g.results.length > 0);

  return (
    <div ref={ref} className="relative w-full max-w-md">
      <div className="flex items-center bg-canvas border border-line rounded-lg px-3 py-2">
        <Search className="w-4 h-4 text-slate-400 shrink-0" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onFocus={() => setOpen(true)}
          placeholder="Search leads, accounts, contacts, deals, tickets…"
          className="bg-transparent border-0 outline-none text-sm px-2 flex-1 min-w-0"
        />
        {query && (
          <button onClick={() => setQuery('')} className="text-slate-400 hover:text-ink shrink-0">
            <X className="w-3.5 h-3.5" />
          </button>
        )}
      </div>

      {open && query.trim() && (
        <div className="absolute top-full left-0 right-0 mt-1 bg-white border border-line rounded-xl shadow-lg overflow-hidden z-50 max-h-96 overflow-y-auto">
          {loading && <p className="text-xs text-slate-400 px-4 py-3">Searching…</p>}
          {!loading && !hasResults && <p className="text-xs text-slate-400 px-4 py-3">No matches.</p>}

          {!loading && groups.map((g) => (
            <div key={g.module.api_name}>
              <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-400 px-4 pt-3 pb-1 flex items-center gap-1.5">
                <ModuleIcon name={g.module.icon} className="w-3 h-3" /> {g.module.plural_label}
              </div>
              {g.results.map((r) => (
                <button key={r.id} onClick={() => goTo(g.module.api_name, r.id)}
                  className="w-full text-left px-4 py-2 text-sm hover:bg-canvas flex justify-between gap-2">
                  <span className="text-ink font-medium truncate">{r.label}</span>
                  {r.sub && <span className="text-slate-400 text-xs shrink-0">{r.sub}</span>}
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
