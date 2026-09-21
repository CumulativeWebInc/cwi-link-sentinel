# Link Sentinel (#52)

Weekly dead-link radar over the **That Boy Hi Hat catalog links** and the **whole CWI app estate**. Black's standing lesson from Neon Nights: *every link, like, and share gets live-checked for dead ends before anything ships.* This is that check, automated.

## What it does

- `data/links.json` — 67 link records (`cwi.link-record/1.0`), each carrying the **source that asserted it** (sync-audition data, placement-wall data, catalog graph, apps registry). Nothing is invented.
- `sentinel.js` — zero-dependency UMD engine. Spotify tracks/playlists are checked through Spotify's public oEmbed endpoint (200 + title match = LIVE; 404 = DEAD). Everything else gets a real HTTP fetch with redirect-following.
- `cli/check.js` — Node scan CLI. Writes `data/results.json` (`cwi.link-scan/1.0`).
- `.github/workflows/weekly-scan.yml` — runs every Monday 09:00 ET and commits fresh results.
- `index.html` — mobile-first dashboard with filters, search, evidence per row, honest-limits panel.

## Truth rules

- Statuses: `LIVE | REDIRECT | DEAD | ERROR | UNCHECKED`
- Truth: `LIVE` → `VERIFIED`. Everything else → `UNVERIFIED`. Nothing is marked live without a real check.
- A LIVE verdict proves the URL resolves — not that the content is correct. That boundary is stated on the dashboard.

## For agents

Resolve streaming links only from `data/results.json` rows with `status: LIVE` and `truth: VERIFIED`.

## Kill rule

If the weekly scan stops producing runs, or zero records check LIVE for 60 consecutive days, this lane is retired.

## License

MIT-0 (open source, no strings).
