#!/usr/bin/env node
/* CWI Link Sentinel scan CLI.
 * Reads data/links.json, checks every record against the live web,
 * writes data/results.json. Exit 0 even when links are dead — a dead link
 * is a finding, not a crash. Exit 2 on usage/config errors, 1 on I/O errors.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const LINKS = path.join(ROOT, 'data', 'links.json');
const OUT = path.join(ROOT, 'data', 'results.json');

const sentinel = require('../sentinel.js');

function main() {
  let linksDoc;
  try {
    linksDoc = JSON.parse(fs.readFileSync(LINKS, 'utf8'));
  } catch (e) {
    console.error('cannot read ' + LINKS + ': ' + e.message);
    process.exit(1);
  }
  const records = linksDoc.records || [];
  if (!records.length) { console.error('no records in links.json'); process.exit(2); }
  if (!sentinel.defaultFetch) { console.error('no global fetch available'); process.exit(2); }

  const started = new Date().toISOString();
  const t0 = Date.now();
  const counts = { LIVE: 0, REDIRECT: 0, DEAD: 0, ERROR: 0, UNCHECKED: 0 };

  console.error('scanning ' + records.length + ' records…');
  return sentinel.scanAll(records, sentinel.defaultFetch, {
    timeoutMs: 20000,
    delayMs: 250,
    onResult: (r) => {
      counts[r.status] = (counts[r.status] || 0) + 1;
      console.error('  [' + r.status + '] ' + r.label);
    }
  }).then((results) => {
    const finished = new Date().toISOString();
    const doc = {
      schema: 'cwi.link-scan/1.0',
      engine: 'cwi-link-sentinel/' + sentinel.version,
      started_at: started,
      finished_at: finished,
      duration_s: Math.round((Date.now() - t0) / 100) / 10,
      record_count: results.length,
      counts: counts,
      results: results
    };
    fs.writeFileSync(OUT, JSON.stringify(doc, null, 2) + '\n');
    console.error('wrote ' + OUT + ' — ' + JSON.stringify(counts));
  }).catch((e) => {
    console.error('scan failed: ' + (e && e.message || e));
    process.exit(1);
  });
}

main();
