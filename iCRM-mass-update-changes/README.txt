iCRM - Mass update changes only
Branch: claude/new-session-60c3iv, commit a9de8c0 (on top of the filter commit cb2f531)

Contents
  frontend/             The 3 changed files, at their paths in the repo.
                        Copy them over the same paths in your project.
  CHANGED_FILES.txt     List of the files.
  changes.patch         The same changes as a git patch. From the repo root:
                        git apply changes.patch

Changed (frontend only - no backend or database change needed)
  frontend/src/components/ListTools.jsx          new Mass update form (many fields at once, typed inputs)
  frontend/src/pages/universal/UniversalList.jsx one save per record; custom fields; Opportunity Stage
  frontend/src/pages/Leads.jsx                   Leads use the same form

Note: ListTools.jsx also contains the filter changes from the previous zip
(iCRM-filter-changes). Apply that one first if you haven't.
