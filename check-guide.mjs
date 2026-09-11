// The publish gate. Refuses a guide that would empty the grid, and records what
// was published in status.json — which the next run reads back as its baseline,
// so the per-source check below needs no thresholds kept up to date.
//
// Exits non-zero so the workflow stops and leaves the last good release in
// place. A failure here is the signal that an upstream changed, not that the
// grid is broken: viewers keep yesterday's guide until it is fixed.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";

import { PROGRAMME, attr, hours, mb, parseTime } from "./epg-xml.mjs";

const HOUR_MS = 3_600_000;

// Writing status.json is how the next run gets its baseline, so it happens only
// when CI asks for it. Otherwise running this by hand would overwrite the
// committed baseline with whatever an ad-hoc build produced.
const record = process.argv.includes("--record");

const MIN_CHANNELS = 300;
const MIN_PROGRAMMES = 20_000;
const MIN_HOURS_AHEAD = 24;
// A source that was carrying this many channels and now carries none has not
// shrunk, it has broken. Below this, normal churn could explain it.
const HEALTHY_SOURCE = 20;

const GUIDE = "guide.xml.gz";
const STATUS = "status.json";
const COUNTS = "counts.json";

const readJson = (file) => (existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null);

const bytes = readFileSync(GUIDE);
const xml = gunzipSync(bytes).toString("utf8");

// Counted without materialising anything: the guide has hundreds of thousands
// of programmes, and Math.max(...stops) would overflow the call stack.
const channels = (xml.match(/<channel\b/g) ?? []).length;
let programmes = 0;
let latest = -Infinity;
for (const [element] of xml.matchAll(PROGRAMME)) {
  programmes++;
  const stop = parseTime(attr(element, "stop") ?? "");
  if (stop > latest) latest = stop;
}
const hoursAhead = (latest - Date.now()) / HOUR_MS;

console.log(`${GUIDE}: ${mb(bytes.length)} gzipped`);
console.log(`channels:   ${channels} (floor ${MIN_CHANNELS})`);
console.log(`programmes: ${programmes} (floor ${MIN_PROGRAMMES})`);
console.log(
  Number.isFinite(latest)
    ? `schedule runs to ${new Date(latest).toISOString()}, ${hoursAhead.toFixed(1)}h ahead (floor ${MIN_HOURS_AHEAD}h)`
    : `no parseable programme stop times`
);

const failures = [];
if (channels < MIN_CHANNELS)
  failures.push(`only ${channels} channels, expected at least ${MIN_CHANNELS} — a source probably stopped matching`);
if (programmes < MIN_PROGRAMMES)
  failures.push(`only ${programmes} programmes, expected at least ${MIN_PROGRAMMES}`);
if (!Number.isFinite(latest)) failures.push("no programme carries a parseable stop time");
else if (hoursAhead < MIN_HOURS_AHEAD)
  failures.push(
    `schedule only runs ${hoursAhead.toFixed(1)}h ahead, expected ${MIN_HOURS_AHEAD}h — upstream is serving a stale file`
  );

// The floors above are totals, so they cannot see one source dying while the
// rest hold the numbers up. Comparing per source against the last published
// run can, and it needs no thresholds to maintain.
const handoff = readJson(COUNTS) ?? {};
const counts = handoff.sources ?? {};
const stale = handoff.stale ?? {};
const previous = readJson(STATUS)?.sources ?? {};
for (const [label, before] of Object.entries(previous)) {
  // A label the build no longer reports at all was removed from SOURCES on
  // purpose. Failing on that would deadlock: the publish stops, so status.json
  // never updates, so it fails again forever.
  if (!(label in counts)) continue;
  const now = counts[label];
  if (before >= HEALTHY_SOURCE && now === 0)
    failures.push(`source "${label}" matched ${before} channels last run and 0 now — its upstream changed`);
}
// A cached source is a source that failed, and its count above came from the
// last copy that worked. Worth saying on every run: the guide is fine, the
// upstream is not, and when the copy ages out the check above starts failing.
for (const [label, ageDays] of Object.entries(stale))
  console.log(`note: "${label}" was served from a cached copy ${hours(ageDays)} old`);

if (Object.keys(previous).length)
  console.log(
    `per source vs last run: ${Object.entries(counts)
      .map(([label, n]) => `${label} ${previous[label] ?? "-"}->${n}`)
      .join(", ")}`
  );

if (failures.length) {
  console.error(`\nrefusing to publish:`);
  for (const failure of failures) console.error(`  - ${failure}`);
  console.error(`\nthe previous release is left in place, so the grid keeps working`);
  process.exit(1);
}

if (!record) {
  console.log(`\nok to publish (status.json left alone — pass --record to update the baseline)`);
  process.exit(0);
}

writeFileSync(
  STATUS,
  `${JSON.stringify(
    {
      built: new Date().toISOString(),
      channels,
      programmes,
      scheduleRunsTo: new Date(latest).toISOString(),
      gzipBytes: bytes.length,
      sources: counts,
      stale,
    },
    null,
    2
  )}\n`
);

console.log("\nok to publish");
