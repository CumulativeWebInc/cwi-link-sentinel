/* CWI Link Sentinel engine v1.0.0
 * Zero-dependency UMD. Checks link records against the live web and returns
 * evidence-bound verdicts. Works in Node 18+ (global fetch) and browsers.
 *
 * Statuses: LIVE | REDIRECT | DEAD | ERROR | UNCHECKED
 * Truth: LIVE -> VERIFIED, everything else -> UNVERIFIED.
 * A 200 response is reported as a live link with evidence; the engine never
 * claims the content is correct, only that the URL resolves. That is the
 * honest boundary, stated on the dashboard too.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CWILinkSentinel = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var VERSION = '1.0.0';
  var MAX_REDIRECTS = 5;
  var DEFAULT_TIMEOUT_MS = 20000;
  var USER_AGENT = 'CWI-Link-Sentinel/1.0 (+https://cumulativewebinc.github.io/cwi-link-sentinel/)';

  function oembedUrl(record) {
    return 'https://open.spotify.com/oembed?url=' + encodeURIComponent(record.url);
  }

  /* Pure evaluators — fully testable with stub responses. */

  function evaluateSpotify(httpStatus, body, record) {
    // body: parsed JSON or null
    if (httpStatus === 200 && body && typeof body.title === 'string' && body.title) {
      var ok = true;
      var note = 'oEmbed returned a title';
      if (record.expected && record.expected.title_contains) {
        var want = String(record.expected.title_contains).toLowerCase();
        ok = body.title.toLowerCase().indexOf(want) !== -1;
        note = ok ? 'oEmbed title contains expected "' + record.expected.title_contains + '"'
                  : 'oEmbed title "' + body.title + '" does NOT contain expected "' + record.expected.title_contains + '"';
      }
      return {
        status: ok ? 'LIVE' : 'DEAD',
        evidence: { oembed_title: body.title, provider: body.provider_name || 'Spotify' },
        note: note
      };
    }
    if (httpStatus === 404 || httpStatus === 400) {
      return { status: 'DEAD', evidence: { oembed_status: httpStatus }, note: 'oEmbed returned ' + httpStatus + ' — Spotify has no such ' + record.kind.replace('spotify_', '') };
    }
    return { status: 'ERROR', evidence: { oembed_status: httpStatus }, note: 'oEmbed endpoint returned unexpected HTTP ' + httpStatus };
  }

  function evaluateHttp(finalStatus, finalUrl, contentType, record) {
    var redirected = finalUrl !== record.url;
    var evidence = { final_url: finalUrl };
    if (contentType) evidence.content_type = contentType;
    if (finalStatus === 200) {
      return {
        status: 'LIVE',
        evidence: evidence,
        note: redirected ? '200 OK after redirect → ' + finalUrl : '200 OK'
      };
    }
    if (finalStatus >= 300 && finalStatus < 400) {
      return { status: 'REDIRECT', evidence: evidence, note: 'redirect chain ended at HTTP ' + finalStatus + ' → ' + finalUrl };
    }
    if (finalStatus >= 400) {
      return { status: 'DEAD', evidence: evidence, note: 'HTTP ' + finalStatus + ' at ' + finalUrl };
    }
    return { status: 'ERROR', evidence: evidence, note: 'unexpected HTTP ' + finalStatus };
  }

  function truthFor(status) {
    return status === 'LIVE' ? 'VERIFIED' : 'UNVERIFIED';
  }

  /* Live scanners — fetchImpl(url, init) injected so tests use stubs. */

  function withTimeout(fetchImpl, url, init, timeoutMs) {
    var controller = null;
    var signal = init && init.signal;
    if (typeof AbortController !== 'undefined' && !signal) {
      controller = new AbortController();
      signal = controller.signal;
    }
    var timer = null;
    if (controller) {
      timer = setTimeout(function () { controller.abort(); }, timeoutMs);
    }
    var p = fetchImpl(url, Object.assign({}, init, { signal: signal, redirect: 'manual' }));
    return p.then(function (resp) {
      if (timer) clearTimeout(timer);
      return resp;
    }, function (err) {
      if (timer) clearTimeout(timer);
      if (err && err.name === 'AbortError') {
        var t = new Error('timeout after ' + timeoutMs + 'ms');
        t.code = 'ETIMEOUT';
        throw t;
      }
      throw err;
    });
  }

  function scanSpotify(record, fetchImpl, timeoutMs) {
    return withTimeout(fetchImpl, oembedUrl(record), {
      headers: { 'User-Agent': USER_AGENT, 'Accept': 'application/json' }
    }, timeoutMs).then(function (resp) {
      var ct = '';
      try { ct = resp.headers.get('content-type') || ''; } catch (e) { /* ignore */ }
      if (ct.indexOf('json') === -1 && resp.status !== 200) {
        return evaluateSpotify(resp.status, null, record);
      }
      return resp.text().then(function (text) {
        var body = null;
        try { body = JSON.parse(text); } catch (e) { body = null; }
        return evaluateSpotify(resp.status, body, record);
      });
    }, function (err) {
      return { status: 'ERROR', evidence: { error: String(err && err.message || err), code: err && err.code || null }, note: 'fetch failed: ' + String(err && err.message || err) };
    });
  }

  function headerGet(headers, name) {
    try { return headers.get(name); } catch (e) { return null; }
  }

  function scanHttp(record, fetchImpl, timeoutMs) {
    var url = record.url;
    var hops = 0;
    function step(current) {
      return withTimeout(fetchImpl, current, {
        headers: { 'User-Agent': USER_AGENT }
      }, timeoutMs).then(function (resp) {
        var status = resp.status;
        if (status >= 300 && status < 400) {
          var loc = headerGet(resp.headers, 'location');
          hops++;
          if (!loc || hops > MAX_REDIRECTS) {
            return evaluateHttp(status, current, headerGet(resp.headers, 'content-type'), record);
          }
          var next;
          try { next = new URL(loc, current).toString(); }
          catch (e) { return { status: 'ERROR', evidence: { location: loc }, note: 'unparseable redirect location' }; }
          try { resp.body && resp.body.cancel && resp.body.cancel(); } catch (e) { /* ignore */ }
          return step(next);
        }
        return evaluateHttp(status, current, headerGet(resp.headers, 'content-type'), record);
      });
    }
    return step(url).then(null, function (err) {
      return { status: 'ERROR', evidence: { error: String(err && err.message || err), code: err && err.code || null }, note: 'fetch failed: ' + String(err && err.message || err) };
    });
  }

  function scanRecord(record, fetchImpl, timeoutMs) {
    var started = new Date().toISOString();
    var kind = record.kind;
    var job;
    if (kind === 'spotify_track' || kind === 'spotify_playlist') job = scanSpotify(record, fetchImpl, timeoutMs || DEFAULT_TIMEOUT_MS);
    else if (kind === 'http') job = scanHttp(record, fetchImpl, timeoutMs || DEFAULT_TIMEOUT_MS);
    else job = Promise.resolve({ status: 'UNCHECKED', evidence: {}, note: 'no checker for kind "' + kind + '" — never mark live without a real check' });
    return job.then(function (r) {
      return {
        id: record.id,
        label: record.label,
        url: record.url,
        kind: record.kind,
        platform: record.platform || null,
        source: record.source,
        status: r.status,
        truth: truthFor(r.status),
        evidence: r.evidence || {},
        note: r.note || '',
        checked_at: started
      };
    });
  }

  function scanAll(records, fetchImpl, opts) {
    opts = opts || {};
    var timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
    var delayMs = opts.delayMs || 0;
    var results = [];
    var chain = Promise.resolve();
    records.forEach(function (rec) {
      chain = chain.then(function () {
        return scanRecord(rec, fetchImpl, timeoutMs).then(function (r) {
          results.push(r);
          if (opts.onResult) opts.onResult(r);
          if (delayMs > 0) return new Promise(function (res) { setTimeout(res, delayMs); });
        });
      });
    });
    return chain.then(function () { return results; });
  }

  return {
    version: VERSION,
    oembedUrl: oembedUrl,
    evaluateSpotify: evaluateSpotify,
    evaluateHttp: evaluateHttp,
    truthFor: truthFor,
    scanRecord: scanRecord,
    scanAll: scanAll,
    defaultFetch: (typeof fetch !== 'undefined') ? fetch.bind(typeof globalThis !== 'undefined' ? globalThis : this) : null,
    STATUSES: ['LIVE', 'REDIRECT', 'DEAD', 'ERROR', 'UNCHECKED']
  };
}));
