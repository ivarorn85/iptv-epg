// Refuses to publish a guide that would empty the grid. The size floor alone
// does not catch a source silently disappearing: losing every UK and US
// channel still leaves a valid multi-megabyte file.
//
// Exits non-zero so the workflow stops and leaves the last good release in
// place. A failure here is the signal that an upstream changed.

import { readFileSync, writeFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";

const MIN_CHANNELS = 300;
const MIN_PROGRAMMES = 20_000;
const MIN_HOURS_AHEAD = 24;

const GUIDE = "guide.xml.gz";
const CHANNEL = /<channel\b[^>]*?>[\s\S]*?<\/channel>|<channel\b[^>]*?\/>/g;
const STOP = /<programme\b[^>]*?\bstop="([^"]*)"/g;

// "20260909095000 +0000"
const toMs = (stamp) => {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\s*([+-]\d{4})?$/.exec(stamp.trim());
  if (!m) return NaN;
  const [, y, mo, d, h, min, s, tz = "+0000"] = m;
  return Date.parse(`${y}-${mo}-${d}T${h}:${min}:${s}${tz.slice(0, 3)}:${tz.slice(3)}`);
};

const bytes = readFileSync(GUIDE);
const xml = gunzipSync(bytes).toString("utf8");

const channels = [...xml.matchAll(CHANNEL)].length;
const stops = [...xml.matchAll(STOP)].map((m) => toMs(m[1])).filter(Number.isFinite);
const programmes = stops.length;
const latest = Math.max(...stops);
const hoursAhead = (latest - Date.now()) / 3_600_000;

console.log(`${GUIDE}: ${(bytes.length / 1048576).toFixed(1)} MB gzipped`);
console.log(`channels:   ${channels} (floor ${MIN_CHANNELS})`);
console.log(`programmes: ${programmes} (floor ${MIN_PROGRAMMES})`);
console.log(`schedule runs to ${new Date(latest).toISOString()}, ${hoursAhead.toFixed(1)}h ahead (floor ${MIN_HOURS_AHEAD}h)`);

const failures = [];
if (channels < MIN_CHANNELS) failures.push(`only ${channels} channels, expected at least ${MIN_CHANNELS} — a source probably stopped matching`);
if (programmes < MIN_PROGRAMMES) failures.push(`only ${programmes} programmes, expected at least ${MIN_PROGRAMMES}`);
if (!Number.isFinite(latest)) failures.push("no parseable programme stop times");
else if (hoursAhead < MIN_HOURS_AHEAD) failures.push(`schedule only runs ${hoursAhead.toFixed(1)}h ahead, expected ${MIN_HOURS_AHEAD}h — upstream is serving a stale file`);

if (failures.length) {
  console.error(`\nrefusing to publish:`);
  for (const f of failures) console.error(`  - ${f}`);
  console.error(`\nthe previous release is left in place, so the grid keeps working`);
  process.exit(1);
}

writeFileSync(
  "status.json",
  `${JSON.stringify(
    {
      built: new Date().toISOString(),
      channels,
      programmes,
      scheduleRunsTo: new Date(latest).toISOString(),
      gzipBytes: bytes.length,
    },
    null,
    2
  )}\n`
);

console.log("\nok to publish");
