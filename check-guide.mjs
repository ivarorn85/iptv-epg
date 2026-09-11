// The publish gate. Refuses a guide that would empty the grid, and records what
// was published in status.json — which the next run reads back as its baseline,
// so the per-source check below needs no thresholds kept up to date.
//
// Exits non-zero so the workflow stops and leaves the last good release in
// place. A failure here is the signal that an upstream changed, not that the
// grid is broken: viewers keep yesterday's guide until it is fixed.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";

import { HOUR_MS, PROGRAMME, attr, hours, mb, parseTime } from "./epg-xml.mjs";

// Writing status.json is how the next run gets its baseline, so it happens only
// when CI asks for it. Otherwise running this by hand would overwrite the
// committed baseline with whatever an ad-hoc build produced.
const record = process.argv.includes("--record");

const MIN_CHANNELS = 300;
const MIN_PROGRAMMES = 20_000;
const MIN_HOURS_AHEAD = 24;
// A source that produced something last run and nothing now has not shrunk, it
// has broken — at any size. This used to require 20 channels before it counted,
// which left RÚV (2), Iceland (4), Norway (4) and Timeshift (6) able to fail
// silently forever, RÚV being both first-party and irreplaceable. The reason
// the threshold existed was transient fetch failures, and those no longer reach
// here: a source that fails is served from cache.mjs and keeps its count.
const CHURNS = new Set([
  // Read from the playlist's current fixtures rather than fetched, so it swings
  // by hundreds between runs and a quiet day is not a defect.
  "Events",
]);

const GUIDE = "guide.xml.gz";
const STATUS = "status.json";
const COUNTS = "counts.json";

const readJson = (file) => (existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null);

const bytes = readFileSync(GUIDE);
const xml = gunzipSync(bytes).toString("utf8");

// One channel element per id, or a player picks between them arbitrarily.
const declared = new Set();
let channels = 0;
for (const [, id] of xml.matchAll(/<channel id="([^"]*)"/g)) {
  channels++;
  declared.add(id);
}

// Counted without materialising anything: the guide has hundreds of thousands
// of programmes, and Math.max(...stops) would overflow the call stack.
//
// The three tallies alongside the count are the guide's own hard requirements,
// and they are checked here rather than in a unit test because this is the only
// place that sees the finished file — every producer contributes to it, and a
// unit test cannot catch two of them interacting.
let programmes = 0;
let latest = -Infinity;
let invalid = 0; // ends before it starts, or carries a stamp nothing can read
let orphaned = 0; // names a channel the guide never declares
for (const [element] of xml.matchAll(PROGRAMME)) {
  programmes++;
  const stop = parseTime(attr(element, "stop") ?? "");
  const start = parseTime(attr(element, "start") ?? "");
  if (stop > latest) latest = stop;
  if (!(stop > start)) invalid++;
  if (!declared.has(attr(element, "channel"))) orphaned++;
}
const hoursAhead = (latest - Date.now()) / HOUR_MS;

console.log(`${GUIDE}: ${mb(bytes.length)} gzipped`);
console.log(`channels:   ${channels} (floor ${MIN_CHANNELS}), ${declared.size} distinct ids`);
console.log(`programmes: ${programmes} (floor ${MIN_PROGRAMMES}), ${invalid} invalid, ${orphaned} orphaned`);
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
// Zero on every run so far, and a regression to any of them would be the kind
// that shows as a wrong grid rather than an error, so they fail the publish
// outright rather than warning.
if (channels !== declared.size)
  failures.push(`${channels - declared.size} channel ids are declared twice — a player picks between them`);
if (invalid)
  failures.push(`${invalid} programmes end before they start, or carry a stamp nothing can read`);
if (orphaned) failures.push(`${orphaned} programmes name a channel the guide never declares`);
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
  if (!(label in counts) || CHURNS.has(label)) continue;
  if (before > 0 && counts[label] === 0)
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
