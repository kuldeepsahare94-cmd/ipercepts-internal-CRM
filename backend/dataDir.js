// ============================================================================
// Where persistent data lives.
// ============================================================================
// Everything the CRM must NOT lose on a redeploy — the SQLite database and
// every uploaded file — resolves through this one module.
//
// THE PROBLEM THIS SOLVES
//
// Previously the database sat at backend/crm.db and uploads at
// backend/uploads/, i.e. *inside the source tree*. On Render the source tree
// is re-created from git on every deploy, so anything written there is lost
// unless a persistent disk is mounted over it. render.yaml did exactly that
// — mounted the disk at /opt/render/project/src/backend — which also masks
// the application code at that path with the disk's contents. That is
// fragile at best.
//
// Now: data lives in its own directory, outside the source tree, named by
// the DATA_DIR environment variable. Render mounts the persistent disk at
// /var/data and sets DATA_DIR=/var/data. Nothing is mounted over the code.
//
// LOCAL DEVELOPMENT is unchanged: with no DATA_DIR set it falls back to the
// backend/ folder, so `node server.js` on a laptop still finds the same
// crm.db it always did.
//
// FIRST BOOT AFTER UPGRADING: if DATA_DIR is set but empty, and a database
// still exists at the old in-tree location, it is COPIED across (never
// moved — the original is left untouched as a fallback). Without this, the
// switch would silently start from an empty database and look exactly like
// "all my data disappeared".

const fs = require('fs');
const path = require('path');

// backend/ — the legacy location, and the local-dev default.
const LEGACY_DIR = __dirname;

const REQUESTED_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : LEGACY_DIR;

// Can we actually create and write there?
//
// An earlier version created the directory and let any error throw, on the
// reasoning that a missing disk should fail loudly. That was wrong: it takes
// the whole CRM down. Setting DATA_DIR=/var/data on a plan with no persistent
// disk — Render's free tier, for instance — means the path cannot be created,
// and the app refused to boot at all.
//
// Failing to start is worse than running without persistence. A CRM that runs
// and says clearly that its storage is temporary is usable; one that will not
// start is not. The warning below is loud, and Settings -> Database Backup
// shows an orange "storage is not persistent" banner, so this cannot pass
// unnoticed.
function usable(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

let DATA_DIR = REQUESTED_DIR;
let fellBack = false;

if (!usable(DATA_DIR)) {
  fellBack = true;
  DATA_DIR = LEGACY_DIR;
  fs.mkdirSync(DATA_DIR, { recursive: true });   // inside the app dir; always writable
}

const DB_FILE = path.join(DATA_DIR, 'crm.db');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

if (fellBack) {
  console.warn(
    `\n[data] ⚠  DATA_DIR is set to "${REQUESTED_DIR}" but that directory cannot be created or written to.`
    + '\n[data] ⚠  Falling back to the application folder so the CRM still starts.'
    + '\n[data] ⚠  DATA IS NOT PERSISTENT: it will be lost on the next deploy, restart or spin-down.'
    + '\n[data] ⚠  On Render this usually means the instance has no persistent disk (the free tier has none),'
    + '\n[data] ⚠  or the disk\'s mount path does not match DATA_DIR.\n',
  );
}

// --------------------------------------------------------------------------
// One-time adoption of data from the old in-tree location.
// --------------------------------------------------------------------------
function adoptLegacyData() {
  if (DATA_DIR === LEGACY_DIR) return; // nothing to move; same place

  // Database. Copy the WAL sidecars too: with journal_mode=WAL, recent
  // commits can still be sitting in crm.db-wal, so copying crm.db alone can
  // lose the most recent writes.
  if (!fs.existsSync(DB_FILE)) {
    const legacyDb = path.join(LEGACY_DIR, 'crm.db');
    if (fs.existsSync(legacyDb)) {
      for (const suffix of ['', '-wal', '-shm']) {
        const from = legacyDb + suffix;
        if (fs.existsSync(from)) fs.copyFileSync(from, DB_FILE + suffix);
      }
      console.log(`[data] adopted existing database from ${legacyDb} -> ${DB_FILE}`);
    }
  }

  // Uploaded files.
  const legacyUploads = path.join(LEGACY_DIR, 'uploads');
  if (fs.existsSync(legacyUploads)) {
    let copied = 0;
    for (const name of fs.readdirSync(legacyUploads)) {
      const from = path.join(legacyUploads, name);
      const to = path.join(UPLOAD_DIR, name);
      if (name.startsWith('.')) continue;              // .gitkeep / .gitignore
      if (fs.existsSync(to)) continue;                 // never overwrite
      if (!fs.statSync(from).isFile()) continue;       // flat directory only
      fs.copyFileSync(from, to);
      copied++;
    }
    if (copied) console.log(`[data] adopted ${copied} uploaded file(s) -> ${UPLOAD_DIR}`);
  }
}

adoptLegacyData();

// --------------------------------------------------------------------------
// Apply a restore staged by POST /api/backup/restore.
// --------------------------------------------------------------------------
// Runs before anything opens the database. The file being replaced is kept,
// not deleted — if the restored backup turns out to be the wrong one, the
// previous database is still sitting right next to it.
function applyPendingRestore() {
  const pending = path.join(DATA_DIR, 'restore-pending.db');
  if (!fs.existsSync(pending)) return;

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  if (fs.existsSync(DB_FILE)) {
    fs.renameSync(DB_FILE, `${DB_FILE}.replaced-${stamp}`);
    // Stale WAL sidecars belong to the replaced database, not the restored
    // one; leaving them would let SQLite apply the old journal over the new
    // file.
    for (const suffix of ['-wal', '-shm']) {
      const side = DB_FILE + suffix;
      if (fs.existsSync(side)) fs.unlinkSync(side);
    }
    console.log(`[data] previous database kept as crm.db.replaced-${stamp}`);
  }
  fs.renameSync(pending, DB_FILE);
  console.log('[data] restore applied from restore-pending.db');
}

applyPendingRestore();

// Logged once at boot so a misconfigured disk is obvious in Render's logs
// instead of showing up later as missing records.
console.log(`[data] DATA_DIR=${DATA_DIR}${process.env.DATA_DIR ? '' : '  (default — set DATA_DIR in production)'}`);

module.exports = { DATA_DIR, DB_FILE, UPLOAD_DIR, LEGACY_DIR };
