/* ---------------------------------------------------------------------------
   lazy(), but surviving a deployment.
   ---------------------------------------------------------------------------
   THE FAILURE THIS FIXES

   Every route in this app is a separate chunk, fetched the first time you
   navigate to it. The filename of each chunk contains a content hash, and
   the list of those filenames lives in the index.html the browser loaded.

   When a new version is deployed, every chunk gets a new hash and the old
   files stop being served. A browser that loaded index.html BEFORE the
   deploy is still holding the old list. The moment the person navigates to
   a page they have not visited yet, it requests a chunk that no longer
   exists, the dynamic import rejects, and React unmounts to the error
   boundary — "Something went wrong".

   The symptom is unmistakable: it happens once, on a page that worked
   yesterday, and reloading fixes it permanently. Reloading works because it
   fetches the new index.html with the new chunk names.

   THE FIX

   Catch that specific rejection and reload once. The reload is the same
   action the person would take, done before they see a crash screen.

   The one-shot guard matters. If the chunk is missing for any OTHER reason
   — they are offline, or a file genuinely failed to deploy — reloading
   again would produce an infinite refresh loop, which is a far worse
   experience than an error screen. So a marker is written to
   sessionStorage first: the first failure reloads, a second failure in the
   same tab gives up and lets the error boundary show. The marker clears on
   the next successful import, so the next deployment recovers too.
   --------------------------------------------------------------------------- */
import { lazy } from 'react';

const FLAG = 'icrm_chunk_reloaded';

// Vite/Rollup and the browsers word this differently, so match on the
// shapes all of them actually produce rather than one exact string.
function looksLikeMissingChunk(error) {
  const text = `${error && error.name} ${error && error.message}`.toLowerCase();
  return (
    text.includes('failed to fetch dynamically imported module')
    || text.includes('error loading dynamically imported module')
    || text.includes('importing a module script failed')
    || text.includes('unable to preload css')
    || (text.includes('chunkloaderror'))
    // Safari says only this, which is indistinguishable from a network
    // blip — hence the one-shot guard above.
    || text.includes('module script failed')
  );
}

function readFlag() {
  try { return sessionStorage.getItem(FLAG); } catch { return null; }
}
function writeFlag(v) {
  try { if (v === null) sessionStorage.removeItem(FLAG); else sessionStorage.setItem(FLAG, v); } catch { /* private mode */ }
}

export default function lazyWithRecovery(factory) {
  return lazy(() => factory().then(
    (mod) => {
      // Got here, so whatever went wrong last time is over.
      if (readFlag()) writeFlag(null);
      return mod;
    },
    (error) => {
      if (looksLikeMissingChunk(error) && !readFlag()) {
        writeFlag(String(Date.now()));
        window.location.reload();
        // Never resolves — the reload takes over before React can render
        // anything. Rejecting here would flash the error boundary first.
        return new Promise(() => {});
      }
      throw error;
    },
  ));
}
