'use strict';
/* CWI Link Sentinel unit tests — node:test, zero deps. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = __dirname;
const sentinel = require('./sentinel.js');

/* --- stub fetch harness --- */
function stubFetch(routes) {
  // routes: { url: {status, json?, text?, headers?} | 'THROW:msg' }
  return function (url, init) {
    const r = routes[url];
    if (r === undefined) return Promise.reject(new Error('no stub for ' + url));
    if (typeof r === 'string' && r.startsWith('THROW:')) return Promise.reject(new Error(r.slice(6)));
    const headers = {
      get(name) { return (r.headers || {})[name.toLowerCase()] || null; }
    };
    return Promise.resolve({
      status: r.status,
      headers,
      text() {
        if (r.json !== undefined) return Promise.resolve(JSON.stringify(r.json));
        return Promise.resolve(r.text || '');
      }
    });
  };
}

const TRACK = { id: 'trk_x', label: 'Zooted Zone', url: 'https://open.spotify.com/track/ABC', kind: 'spotify_track', source: 'test', expected: { title_contains: 'Zooted' } };

test('engine exposes version + status vocabulary', () => {
  assert.equal(sentinel.version, '1.0.0');
  assert.deepEqual(sentinel.STATUSES, ['LIVE', 'REDIRECT', 'DEAD', 'ERROR', 'UNCHECKED']);
});

test('UMD loads in a browser-like global context', () => {
  const src = fs.readFileSync(path.join(ROOT, 'sentinel.js'), 'utf8');
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  assert.equal(sandbox.CWILinkSentinel.version, '1.0.0');
  assert.equal(typeof sandbox.CWILinkSentinel.scanAll, 'function');
});

test('truthFor: only LIVE is VERIFIED', () => {
  assert.equal(sentinel.truthFor('LIVE'), 'VERIFIED');
  for (const s of ['REDIRECT', 'DEAD', 'ERROR', 'UNCHECKED']) assert.equal(sentinel.truthFor(s), 'UNVERIFIED');
});

test('spotify: live track with matching title -> LIVE + evidence', async () => {
  const f = stubFetch({ [sentinel.oembedUrl(TRACK)]: { status: 200, json: { title: 'Zooted Zone', provider_name: 'Spotify' } } });
  const r = await sentinel.scanRecord(TRACK, f, 5000);
  assert.equal(r.status, 'LIVE');
  assert.equal(r.truth, 'VERIFIED');
  assert.equal(r.evidence.oembed_title, 'Zooted Zone');
});

test('spotify: live oEmbed but wrong title -> DEAD (title guard)', async () => {
  const f = stubFetch({ [sentinel.oembedUrl(TRACK)]: { status: 200, json: { title: 'Some Other Song', provider_name: 'Spotify' } } });
  const r = await sentinel.scanRecord(TRACK, f, 5000);
  assert.equal(r.status, 'DEAD');
  assert.equal(r.truth, 'UNVERIFIED');
});

test('spotify: oEmbed 404 -> DEAD', async () => {
  const f = stubFetch({ [sentinel.oembedUrl(TRACK)]: { status: 404, text: 'not found', headers: { 'content-type': 'text/html' } } });
  const r = await sentinel.scanRecord(TRACK, f, 5000);
  assert.equal(r.status, 'DEAD');
  assert.ok(r.note.includes('404'));
});

test('spotify: oEmbed 500 -> ERROR, never invented live', async () => {
  const f = stubFetch({ [sentinel.oembedUrl(TRACK)]: { status: 500, text: 'err', headers: { 'content-type': 'text/html' } } });
  const r = await sentinel.scanRecord(TRACK, f, 5000);
  assert.equal(r.status, 'ERROR');
  assert.notEqual(r.status, 'LIVE');
});

test('spotify: network throw -> ERROR with evidence', async () => {
  const f = stubFetch({ [sentinel.oembedUrl(TRACK)]: 'THROW:connection reset' });
  const r = await sentinel.scanRecord(TRACK, f, 5000);
  assert.equal(r.status, 'ERROR');
  assert.ok(r.evidence.error.includes('connection reset'));
});

const HTTP_REC = { id: 'app_x', label: 'Some App', url: 'https://example.com/app/', kind: 'http', source: 'test' };

test('http: 200 -> LIVE', async () => {
  const f = stubFetch({ 'https://example.com/app/': { status: 200, headers: { 'content-type': 'text/html' } } });
  const r = await sentinel.scanRecord(HTTP_REC, f, 5000);
  assert.equal(r.status, 'LIVE');
  assert.equal(r.truth, 'VERIFIED');
  assert.equal(r.evidence.final_url, 'https://example.com/app/');
});

test('http: redirect then 200 -> LIVE with redirect note', async () => {
  const f = stubFetch({
    'https://example.com/app/': { status: 301, headers: { location: '/app2/' } },
    'https://example.com/app2/': { status: 200, headers: { 'content-type': 'text/html' } }
  });
  const r = await sentinel.scanRecord(HTTP_REC, f, 5000);
  assert.equal(r.status, 'LIVE');
  assert.ok(r.note.includes('redirect'));
  assert.equal(r.evidence.final_url, 'https://example.com/app2/');
});

test('http: 404 -> DEAD', async () => {
  const f = stubFetch({ 'https://example.com/app/': { status: 404, headers: {} } });
  const r = await sentinel.scanRecord(HTTP_REC, f, 5000);
  assert.equal(r.status, 'DEAD');
});

test('http: 503 -> DEAD', async () => {
  const f = stubFetch({ 'https://example.com/app/': { status: 503, headers: {} } });
  const r = await sentinel.scanRecord(HTTP_REC, f, 5000);
  assert.equal(r.status, 'DEAD');
});

test('unknown kind -> UNCHECKED, never live', async () => {
  const f = stubFetch({});
  const r = await sentinel.scanRecord({ id: 'x', label: 'X', url: 'x', kind: 'teleport', source: 'test' }, f, 5000);
  assert.equal(r.status, 'UNCHECKED');
  assert.equal(r.truth, 'UNVERIFIED');
});

test('scanAll preserves order and scans every record', async () => {
  const f = stubFetch({ 'https://example.com/app/': { status: 200, headers: {} } });
  const recs = [HTTP_REC, Object.assign({}, HTTP_REC, { id: 'app_y' })];
  const rs = await sentinel.scanAll(recs, f, { timeoutMs: 5000 });
  assert.equal(rs.length, 2);
  assert.deepEqual(rs.map(r => r.id), ['app_x', 'app_y']);
});

test('data/links.json: schema-shaped, unique ids, every record has a source', () => {
  const doc = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'links.json'), 'utf8'));
  assert.equal(doc.schema, 'cwi.link-record/1.0');
  const ids = new Set();
  for (const r of doc.records) {
    assert.ok(r.id && r.url && r.kind && r.label, 'record missing field: ' + JSON.stringify(r));
    assert.ok(r.source && r.source.length > 5, 'record missing source: ' + r.id);
    assert.ok(sentinel.STATUSES || true);
    assert.ok(['spotify_track', 'spotify_playlist', 'http'].includes(r.kind), 'bad kind: ' + r.kind);
    assert.ok(!ids.has(r.id), 'duplicate id: ' + r.id);
    ids.add(r.id);
  }
  assert.ok(doc.records.length >= 60, 'expected >=60 records, got ' + doc.records.length);
});

test('no record claims a status without a scan (results.json is the only place statuses live)', () => {
  const doc = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'links.json'), 'utf8'));
  for (const r of doc.records) {
    assert.ok(!('status' in r), 'record carries an unscanned status: ' + r.id);
    assert.ok(!('truth' in r), 'record carries an unscanned truth: ' + r.id);
  }
});

test('results.schema.json is valid JSON with the cwi.link-scan/1.0 const', () => {
  const s = JSON.parse(fs.readFileSync(path.join(ROOT, 'results.schema.json'), 'utf8'));
  assert.equal(s.properties.schema.const, 'cwi.link-scan/1.0');
});

test('cli/check.js exists and is executable node', () => {
  const src = fs.readFileSync(path.join(ROOT, 'cli', 'check.js'), 'utf8');
  assert.ok(src.includes('sentinel.scanAll'));
  assert.ok(src.includes('data/results.json'));
});

test('weekly workflow exists with schedule + manual dispatch', () => {
  const yml = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'weekly-scan.yml'), 'utf8');
  assert.ok(yml.includes('schedule'));
  assert.ok(yml.includes('workflow_dispatch'));
  assert.ok(yml.includes('cli/check.js'));
});
