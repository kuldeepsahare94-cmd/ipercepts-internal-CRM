#!/usr/bin/env node
/*
 * Demo data, from the command line.
 *
 *     node seed-demo-data.js            # replace any demo data with a fresh set
 *     node seed-demo-data.js --wipe     # remove demo data and stop
 *     node seed-demo-data.js --status   # show what is currently loaded
 *
 * The generation itself lives in services/demoData.js, which is also what the
 * Load Demo Data button in Settings calls. This file is only a way to run it
 * without a browser — deliberately, because two generators drifting apart
 * would mean a demo loaded from the UI and one loaded from a terminal show
 * different products.
 *
 * Only rows this generator created are ever removed. Records entered by a
 * real user match none of the wipe conditions.
 */

const demoData = require('./services/demoData');

const args = process.argv.slice(2);
const report = (title, counts) => {
  const entries = Object.entries(counts);
  if (!entries.length) { console.log(`${title}: nothing.`); return; }
  console.log(`${title}:`);
  for (const [name, n] of entries) console.log(`  ${name.padEnd(24)} ${n}`);
  console.log(`  ${'—'.repeat(24)} ${entries.reduce((a, [, n]) => a + n, 0)} total`);
};

try {
  if (args.includes('--status')) {
    const counts = demoData.summary();
    console.log(demoData.hasDemoData() ? 'Demo data is loaded.' : 'No demo data loaded.');
    report('Currently loaded', Object.fromEntries(Object.entries(counts).filter(([, n]) => n)));
  } else if (args.includes('--wipe')) {
    report('Removed', demoData.wipe());
  } else {
    if (demoData.hasDemoData()) {
      console.log('Demo data already present — replacing it.');
      demoData.wipe();
    }
    report('Created', demoData.seed());
  }
} catch (err) {
  console.error(`Failed: ${err.message}`);
  process.exit(1);
}
