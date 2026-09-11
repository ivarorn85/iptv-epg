// The publish gate, and it answers two different questions.
//
// Is the guide itself broken — too small, too stale, self-contradictory? Then
// refuse to publish, because the release already up is better than this one.
//
// Or is the guide fine and a source regressed? Then publish it anyway and fail
// the job afterwards. Refusing in that case used to make things worse: the
// baseline is only recorded on a successful run, so a refusal pinned it and the
// build stayed red until someone hand-edited status.json — while the release it
// was protecting emptied out, most sources publishing under four days ahead.
// Fresh data for the channels that work, plus a red build, beats neither.
//
// So --record writes the baseline whenever the guide is publishable, and
// --regressions is the separate step that fails the job for what it recorded.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";

import {
  CHANNEL,
  HOUR_MS,
  PROGRAMME,
  attr,
  hours,
  mb,
  parseTime,
  slotKey,
} from "./epg-xml.mjs";

// Writing status.json is how the next run gets its baseline, so it happens only
// when CI asks for it. Otherwise running this by hand would overwrite the
// committed baseline with whatever an ad-hoc build produced.
const readJson = (file) => (existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null);

const record = process.argv.includes("--record");

// The second half of the answer, run as its own step after the guide is safely
// published: turn what --record wrote into a red build.
const REGRESSIONS = "--regressions";

const MIN_CHANNELS = 300;
const MIN_PROGRAMMES = 20_000;
const MIN_HOURS_AHEAD = 24;
// A source that produced something last run and nothing now has not shrunk, it
// has broken — at any size. This used to require 20 channels before it counted,
// which left RÚV (2), Iceland (4), Norway (4) and Timeshift (6) able to fail
// silently forever, RÚV being both first-party and irreplaceable. The reason
// the threshold existed was transient fetch failures, and those no longer reach
// here: a source that fails is served from cache.mjs and keeps its count.
// Sources allowed to reach zero without it meaning anything is broken.
const MAY_BE_EMPTY = new Set([
  // Read from the playlist's current fixtures rather than fetched, so it swings
  // by hundreds between runs and a quiet day is not a defect.
  "Events",
  // Standbys. They only ever take what the sources above them leave, so when
  // iptv-epg.org is healthy they are correctly empty and when it is down they
  // carry 45 and 33 channels. Counting that as a regression turned the run red
  // the moment the outage ENDED, which is precisely backwards.
  "UK extra 2",
  "US extra 2",
]);

const GUIDE = "guide.xml.gz";
const STATUS = "status.json";
const COUNTS = "counts.json";

// Nothing below this needs the guide, so it runs before the file is read: this
// step is deliberately able to work after the guide has been published and the
// workspace moved on.
if (process.argv.includes(REGRESSIONS)) {
  const published = readJson(STATUS) ?? {};
  const broke = published.regressions ?? [];
  const empty = published.zeroed ?? [];
  const thin = Object.entries(published.collapsed ?? {});

  // A source that breaks fails the run once, on the run it broke: after that
  // the baseline records the zero and the transition never fires again. So
  // what is still empty gets printed every run too, along with anything that
  // collapsed without reaching zero. Reporting "no source regressed" while
  // three of them sat dead was worse than saying nothing at all.
  for (const label of empty) console.log(`still carrying nothing: "${label}"`);
  for (const [label, { now, held }] of thin)
    console.log(`"${label}" matched ${now} channels; its cached copy holds ${held}`);

  if (!broke.length && !thin.length) {
    console.log(empty.length ? "nothing newly broken" : "every source is carrying channels");
    process.exit(0);
  }

  console.error("\nthis run needs looking at:");
  for (const regression of broke) console.error(`  - ${regression}`);
  for (const [label, { now, held }] of thin)
    console.error(`  - source "${label}" collapsed to ${now} channels from ${held}`);
  console.error(
    "\nthe guide is live and the rest of the grid is fresh — this is a signal, not an outage"
  );
  process.exit(1);
}

const bytes = readFileSync(GUIDE);
const xml = gunzipSync(bytes).toString("utf8");

// One channel element per id, or a player picks between them arbitrarily.
// Read through attr(), not a pattern that assumes id comes first: a source is
// free to write <channel lang="en" id="X">, and counting every programme on
// that channel as orphaned would refuse the publish over attribute order.
//
//
// One walk of the whole string for both, since it can be 62 MB.
const declared = new Set();
let channels = 0;
let unidentified = 0;
for (const [element] of xml.matchAll(CHANNEL)) {
  channels++;
  const id = attr(element, "id");
  // Counted rather than added to the set, where a null would read as a
  // duplicate id and report itself with the wrong message.
  if (id === null) {
    unidentified++;
    continue;
  }
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
let repeated = 0; // the same programme in the same slot twice
const slots = new Set();
// Starts and stops per channel, to count programmes that run into each other.
// It is the only way to see a source that has pooled several channels onto one:
// guide.xml on is-epg.run.place does exactly that, 423 overlaps on a single
// channel, and a zero-length marker given an assumed length did the same here.
const spans = new Map();
for (const [element] of xml.matchAll(PROGRAMME)) {
  programmes++;
  const channel = attr(element, "channel");
  const from = attr(element, "start");
  const to = attr(element, "stop");
  const start = parseTime(from ?? "");
  const stop = parseTime(to ?? "");
  if (stop > latest) latest = stop;
  if (!(stop > start)) invalid++;
  if (!declared.has(channel)) orphaned++;
  const slot = slotKey(channel, element);
  if (slots.has(slot)) repeated++;
  else slots.add(slot);
  if (!spans.has(channel)) spans.set(channel, []);
  spans.get(channel).push([start, stop]);
}

let overlapping = 0;
for (const list of spans.values()) {
  list.sort((one, two) => one[0] - two[0]);
  for (let at = 0; at < list.length - 1; at++) if (list[at + 1][0] < list[at][1]) overlapping++;
}
const hoursAhead = (latest - Date.now()) / HOUR_MS;

console.log(`${GUIDE}: ${mb(bytes.length)} gzipped`);
console.log(`channels:   ${channels} (floor ${MIN_CHANNELS}), ${declared.size} distinct ids`);
console.log(
  `programmes: ${programmes} (floor ${MIN_PROGRAMMES}), ${invalid} invalid,` +
    ` ${orphaned} orphaned, ${repeated} repeated`
);
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
if (unidentified) failures.push(`${unidentified} channel elements carry no id at all`);
else if (channels !== declared.size)
  failures.push(`${channels - declared.size} channel ids are declared twice — a player picks between them`);
if (invalid)
  failures.push(`${invalid} programmes end before they start, or carry a stamp nothing can read`);
if (orphaned) failures.push(`${orphaned} programmes name a channel the guide never declares`);
if (repeated)
  failures.push(`${repeated} programmes are listed twice in the same slot — the builder should have dropped them`);
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
const collapsed = handoff.collapsed ?? {};
const ambiguous = handoff.ambiguous ?? [];

// Rows the builder found could resolve to the wrong channel — counted there
// because it needs the playlist, which the gate never sees. Recorded in
// status.json, which is committed, so growth shows up as a diff.
console.log(`programmes running into the next: ${overlapping}`);
console.log(
  `rows a name could misdirect: ${ambiguous.length}` +
    (ambiguous.length ? ` — ${ambiguous.slice(0, 4).join(", ")}${ambiguous.length > 4 ? ", ..." : ""}` : "")
);
const previous = readJson(STATUS)?.sources ?? {};
const regressions = [];
for (const [label, before] of Object.entries(previous)) {
  // A label the build no longer reports at all was removed from SOURCES on
  // purpose, so it is not a regression.
  if (!(label in counts) || MAY_BE_EMPTY.has(label)) continue;
  if (before > 0 && counts[label] === 0)
    regressions.push(`source "${label}" matched ${before} channels last run and 0 now`);
}

// Reported every run, not just on the run it broke: once the baseline records
// the zero, the transition above never fires again, and a source that stays
// dead should keep saying so.
const zeroed = Object.entries(counts)
  .filter(([label, now]) => now === 0 && !MAY_BE_EMPTY.has(label))
  .map(([label]) => label);
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

for (const label of zeroed) console.log(`note: source "${label}" is carrying no channels`);
if (regressions.length) {
  console.log(`\nthis guide is publishable, but a source regressed:`);
  for (const regression of regressions) console.log(`  - ${regression}`);
  console.log(`publishing anyway; the "${REGRESSIONS}" step is what turns the run red`);
}

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
      ambiguous,
      overlapping,
      regressions,
      zeroed,
      collapsed,
    },
    null,
    2
  )}\n`
);

console.log("\nok to publish");
