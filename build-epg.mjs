// Builds one merged XMLTV guide whose channel ids match my provider's, so
// TiviMate fills the grid with no per-channel mapping. Five matching passes,
// in falling order of confidence — the README explains why each one exists.
//
// Local:  XTREAM_HOST=... XTREAM_USER=... XTREAM_PASS=... node build-epg.mjs
// CI:     driven by .github/workflows/build-epg.yml
//
// No dependencies. Needs Node 18 or newer; CI runs 22.

import { writeFileSync } from "node:fs";
import { gunzipSync, gzipSync } from "node:zlib";

import {
  CHANNEL,
  DISPLAY_NAME,
  PROGRAMME,
  attr,
  escapeAttr,
  isPlaceholder,
  mb,
  xmltvChannel,
} from "./epg-xml.mjs";
import { EVENT_NAME, eventGuide } from "./events.mjs";
import { ruvGuide, synGuide } from "./iceland.mjs";
import { baseKey, bodyOf, ccOf, idKey, nameKey, scopedBaseKey, scopedKey } from "./keys.mjs";

const EPGSHARE = "https://epgshare01.online/epgshare01/epg_ripper_";
const IPTVEPG = "https://iptv-epg.org/files/epg-";

// Order matters: the first source to claim a channel wins.
// `passthrough` keeps unmatched channels as-is, which the Icelandic guide
// needs because its ids are already my channel names.
// `borrow` lets a source also serve another country's entries.
const SOURCES = [
  // The broadcasters' own APIs come first: first-party beats any aggregator for
  // the channels they own, and between them they are the only source anywhere
  // for Sýn+, the Sýn Sport Ísland channels and Sýn Sport 5.
  { label: "RÚV", build: ruvGuide },
  { label: "Sýn", build: synGuide },
  // Ids already in my provider's vocabulary ("AnimalPlanet.is"), and it runs
  // first because it carries a full week of RUV and RUV 2 where guide3 has one
  // day. It has nothing for Sýn, Sýn Sport, Sjónvarp Símans or KVF, so guide3
  // still does the heavy lifting and picks those up next.
  { label: "Iceland extra", url: `${IPTVEPG}is.xml.gz` },
  { label: "Iceland", url: "https://is-epg.run.place/iptv/guide3.xml", passthrough: true },
  { label: "UK", url: `${EPGSHARE}UK1.xml.gz` },
  // Fills what UK1 has no entry for at all: Sky Sports F1, the Sky Cinema
  // channels, Sky Atlantic, E4, More 4, and a plain BBC One.
  { label: "UK extra", url: `${IPTVEPG}gb.xml.gz` },
  { label: "US", url: `${EPGSHARE}US2.xml.gz` },
  { label: "US sports", url: `${EPGSHARE}US_SPORTS1.xml.gz` },
  // 500 MB uncompressed, within 3% of the largest string Node can hold. It is
  // late because it only fills leftovers, and it will start being skipped once
  // it outgrows that ceiling — see the size check in fetchSource.
  { label: "US extra", url: `${IPTVEPG}us.xml.gz` },
  // My provider's remaining Icelandic entries are international channels on the
  // Nordic feed, which only these carry — hence `borrow: "is"`. Never UK or US:
  // those are a different regional schedule, and wrong programmes are worse
  // than none.
  { label: "Denmark", url: `${EPGSHARE}DK1.xml.gz`, borrow: "is" },
  { label: "Norway", url: `${EPGSHARE}NO1.xml.gz`, borrow: "is" },
  { label: "Sweden", url: `${EPGSHARE}SE1.xml.gz`, borrow: "is" },
  // { label: "Germany", url: `${EPGSHARE}DE1.xml.gz` },
  // { label: "Spain", url: `${EPGSHARE}ES1.xml.gz` },
  // { label: "Italy", url: `${EPGSHARE}IT1.xml.gz` },
];

const OUT = "guide.xml.gz";
const COUNTS = "counts.json";

// The escape hatch, and deliberately a short one: provider ids mapped to extra
// channel names that should also find them.
//
// Everything else here is a rule. These are the rows no rule can reach: my
// provider numbers its 4K simulcasts ("BBC One 1 HDR 4K") and gives them no id,
// so the only thing linking them to BBC One is the number being a feed index
// rather than part of the name. A rule that dropped that digit would also turn
// Sweden's TV24 into TV 2, which is a different channel — so this is a list
// instead. Keep it short; if it grows, the rules are wrong.
const ALSO_KNOWN_AS = {
  "BBCOne.uk": ["UK: BBC One 1 HDR 4K", "UK: BBC One 2 HDR 4K"],
};

// The largest string V8 will hold. Some of these files are close enough to it
// that saying so beats an ERR_STRING_TOO_LONG stack trace in the log.
const MAX_STRING = 0x1fffffe8;

const fetchSource = async ({ url, build }) => {
  if (build) return build(); // assembled from a JSON API rather than fetched as XMLTV
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const raw = url.endsWith(".gz") ? gunzipSync(buf) : buf;
  if (raw.length > MAX_STRING) throw new Error(`${mb(raw.length, 0)} uncompressed, too big to parse`);
  return raw.toString("utf8");
};

const loadChannels = async () => {
  const { XTREAM_HOST, XTREAM_USER, XTREAM_PASS } = process.env;
  if (!XTREAM_HOST || !XTREAM_USER || !XTREAM_PASS)
    throw new Error("set XTREAM_HOST, XTREAM_USER and XTREAM_PASS");

  const url =
    `${XTREAM_HOST.replace(/\/$/, "")}/player_api.php` +
    `?username=${encodeURIComponent(XTREAM_USER)}` +
    `&password=${encodeURIComponent(XTREAM_PASS)}` +
    `&action=get_live_streams`;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Xtream API: HTTP ${res.status}`);
  return res.json();
};

// My provider states the country in the channel name; fall back to the id for
// the rows that don't carry a prefix. Only two-letter prefixes are countries,
// while `bare` in keys.mjs strips two to four characters — "CAR:" is a label,
// not a country, so it comes off the name without ever becoming a scope.
const providerCc = (ch) => {
  const prefix = /^([A-Za-z]{2})\s*:/.exec(ch.name ?? "");
  return prefix ? prefix[1].toLowerCase() : ccOf(ch.epg_channel_id ?? "");
};

// Builds every lookup the passes below need, in one walk of the provider's
// channel list. Five of them match a source channel to a provider id; `aliases`
// holds the names of rows that have no id at all, and `targetCc` remembers
// which country each id belongs to.
const buildIndex = (channels) => {
  const byId = new Map();
  const byName = new Map();
  const byBase = new Map();
  const byScoped = new Map();
  const byScopedBase = new Map();
  const aliases = new Map();
  const targetCc = new Map();
  // A row with no id, next to a row with one that normalises to the same name,
  // is the same channel packaged differently — a backup feed, a P50 variant, an
  // app duplicate. My provider says so itself by naming them alike, so the
  // id-less one is advertised on the channel its sibling already reaches.
  const donors = new Map();
  const orphans = [];
  const inherited = new Map();
  const add = (map, key, value) => {
    if (!key) return;
    if (!map.has(key)) map.set(key, new Set());
    map.get(key).add(value);
  };

  for (const ch of channels) {
    const target = ch.epg_channel_id;
    const cc = providerCc(ch);

    if (!target) {
      // No id means TiviMate can only ever match this row on the channel name,
      // so remember the name and emit it as an extra <display-name>. Keyed by
      // country, or the Vietnamese Animal Planet would collect a Nordic one.
      if (ch.name) {
        add(aliases, scopedKey(cc, ch.name), ch.name);
        add(aliases, scopedBaseKey(cc, ch.name), ch.name);
        // Per-event channels are the event pass's job, not a sibling's.
        if (!EVENT_NAME.test(ch.name)) orphans.push(ch);
      }
      continue;
    }

    targetCc.set(target, cc);
    add(byId, idKey(target), target);
    if (!ch.name) continue;
    const sibling = scopedBaseKey(cc, ch.name);
    if (sibling && !donors.has(sibling)) donors.set(sibling, target);
    add(byName, nameKey(ch.name), target);
    add(byBase, baseKey(ch.name), target);

    // Index the id's own body too — it is often the better name carrier,
    // "AandE Network (East).us" naming the channel that "US: A&E HD" is.
    for (const label of [ch.name, bodyOf(target)]) {
      add(byScoped, scopedKey(cc, label), target);
      add(byScopedBase, scopedBaseKey(cc, label), target);
    }
  }
  for (const ch of orphans) {
    const donor = donors.get(scopedBaseKey(providerCc(ch), ch.name));
    if (donor) add(inherited, donor, ch.name);
  }

  return { byId, byName, byBase, byScoped, byScopedBase, aliases, targetCc, inherited };
};

// Source channels carrying at least one real programme. Anything else must not
// claim a target. This is a separate scan of the source rather than one pass
// that keeps every programme: holding a million programme strings costs more
// than re-reading a string that can be 500 MB.
const channelsWithData = (xml) => {
  const withData = new Set();
  for (const [element] of xml.matchAll(PROGRAMME)) {
    if (isPlaceholder(element)) continue;
    const channel = attr(element, "channel");
    if (channel) withData.add(channel);
  }
  return withData;
};

const firstHit = (labels, lookup) => {
  for (const label of labels) {
    const hit = lookup(label);
    if (hit) return hit;
  }
  return undefined;
};

const convert = (xml, index, { passthrough, borrow } = {}) => {
  const { byId, byName, byBase, byScoped, byScopedBase, aliases, targetCc, inherited } = index;
  const withData = channelsWithData(xml);

  // Labels and ids are read once here, because everything below walks this
  // list five more times and re-parsing each element that often was pure waste.
  const elements = [];
  for (const [element] of xml.matchAll(CHANNEL)) {
    const sourceId = attr(element, "id");
    if (!sourceId || !withData.has(sourceId)) continue;
    const names = [...element.matchAll(DISPLAY_NAME)].map((m) => m[1].trim());
    elements.push({ element, sourceId, names, labels: [bodyOf(sourceId), ...names] });
  }

  const resolved = new Map(); // source id -> Set of target ids
  const claimed = new Set();

  // Every pass adds to what earlier passes found rather than skipping a
  // channel that is already resolved: my provider often has two ids for one
  // channel, "TNT Sports 3.uk" alongside "TNTSports3 HD.uk", and only one of
  // them matches exactly. Claimed targets are never revisited, so a loose
  // match still cannot steal what something else matched precisely.
  const take = (sourceId, found) => {
    const targets = new Set([...(found ?? [])].filter((t) => !claimed.has(t)));
    if (!targets.size) return;
    const already = resolved.get(sourceId);
    if (already) for (const t of targets) already.add(t);
    else resolved.set(sourceId, targets);
    for (const t of targets) claimed.add(t);
  };

  // Pass 1: exact ids and names. The ?? chain stops at the first lookup that
  // returns anything, even if take() then finds every target already claimed —
  // an exact id hit that lost the race is not a reason to go looking by name.
  for (const { sourceId, names } of elements) {
    take(
      sourceId,
      byId.get(idKey(sourceId)) ??
        byName.get(nameKey(sourceId)) ??
        firstHit(names, (name) => byName.get(nameKey(name)))
    );
  }

  // Pass 2: feed-variant fallback, so "RUV 2 HD" can feed "RUV 2 FHD".
  for (const { sourceId, names } of elements) {
    take(
      sourceId,
      byBase.get(baseKey(sourceId)) ?? firstHit(names, (name) => byBase.get(baseKey(name)))
    );
  }

  // Pass 3: my provider's ids come from a different vendor than epgshare's, so
  // for most countries the name is the only thing the two sides share. Country
  // is part of the key, so this cannot match across countries — except the one
  // a source explicitly declares it may `borrow`.
  for (const { sourceId, labels } of elements) {
    for (const cc of [ccOf(sourceId), borrow]) {
      if (!cc) continue;
      take(
        sourceId,
        firstHit(labels, (label) => byScoped.get(scopedKey(cc, label))) ??
          firstHit(labels, (label) => byScopedBase.get(scopedBaseKey(cc, label)))
      );
    }
  }

  // Pass 4: rows with an empty id can never match on TiviMate's first step, but
  // its third step compares the channel name against <display-name> — so the
  // guide carries my provider's own names for them. Country-scoped like pass 3,
  // or the Vietnamese Animal Planet would collect a Nordic schedule.
  const aliasNames = (labels, cc) => {
    const names = new Set();
    if (!cc) return names;
    for (const label of labels)
      for (const name of [
        ...(aliases.get(scopedKey(cc, label)) ?? []),
        ...(aliases.get(scopedBaseKey(cc, label)) ?? []),
      ])
        names.add(name);
    return names;
  };

  // Whatever is still unclaimed, emitted under its own id — the id is
  // irrelevant here, since these are matched by name. Either a row with no id
  // wants this channel, or the source is passthrough and keeps everything.
  for (const { sourceId, labels } of elements) {
    if (resolved.has(sourceId)) continue;
    const wanted = [ccOf(sourceId), borrow].some((cc) => aliasNames(labels, cc).size);
    if (wanted || passthrough) resolved.set(sourceId, new Set([sourceId]));
  }

  // Scoped to the country of the id being emitted, not of the source channel,
  // so a schedule never reaches a same-named channel in another market.
  const withAliases = (element, labels, target) => {
    const names = aliasNames(labels, targetCc.get(target) ?? ccOf(target));
    for (const name of ALSO_KNOWN_AS[target] ?? []) names.add(name);
    for (const name of inherited.get(target) ?? []) names.add(name);
    if (!names.size) return element;
    const extra = [...names].map((n) => `\n    <display-name>${escapeAttr(n)}</display-name>`).join("");
    return element.endsWith("/>")
      ? `${element.replace(/\s*\/>$/, ">")}${extra}\n  </channel>`
      : element.replace(/<\/channel>$/, `${extra}\n  </channel>`);
  };

  const channels = [];
  for (const { element, sourceId, labels } of elements) {
    for (const target of resolved.get(sourceId) ?? [])
      channels.push({
        id: target,
        element: withAliases(element, labels, target).replace(
          /\bid="[^"]*"/,
          `id="${escapeAttr(target)}"`
        ),
      });
  }

  const programmes = [];
  for (const [element] of xml.matchAll(PROGRAMME)) {
    if (isPlaceholder(element)) continue;
    // Some upstream files carry a programme that ends before it starts, or at
    // the same instant. Both stamps are fixed width and share one offset, so
    // comparing the digits is enough to drop them.
    const from = attr(element, "start");
    const to = attr(element, "stop");
    if (from && to && to.slice(0, 14) <= from.slice(0, 14)) continue;
    for (const target of resolved.get(attr(element, "channel")) ?? [])
      programmes.push({
        channel: target,
        element: element.replace(/\bchannel="[^"]*"/, `channel="${escapeAttr(target)}"`),
      });
  }

  return { channels, programmes };
};

const HOUR_MS = 3_600_000;

// A "+1" channel is its base channel an hour later, so where the base has a
// schedule the +1 schedule is derivable rather than fetchable. My provider
// writes it as a trailing "1" after a double space — "UK: FILM 4  1" — which
// is how it differs from a channel number: "UK: Coral TV 2" has one space and
// is a different channel, not a timeshift.
const PLUS_ONE = /\s{2,}1$/;

// Advances the wall clock an hour and keeps the original offset, which is the
// same instant either way and leaves the stamp looking like its neighbours.
const anHourLater = (stamp) => {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(.*)$/.exec(stamp);
  if (!m) return stamp;
  const [, year, month, day, hour, minute, second, zone] = m;
  const at = new Date(Date.UTC(+year, +month - 1, +day, +hour, +minute, +second) + HOUR_MS);
  const pad = (value) => String(value).padStart(2, "0");
  return (
    `${at.getUTCFullYear()}${pad(at.getUTCMonth() + 1)}${pad(at.getUTCDate())}` +
    `${pad(at.getUTCHours())}${pad(at.getUTCMinutes())}${pad(at.getUTCSeconds())}${zone}`
  );
};

// A "+1" row, built from the base channel's schedule moved an hour later.
//
// Copying a sibling's schedule wholesale to every other empty row was tried and
// rejected: it filled 328 channels but added 37,000 duplicate programmes and
// took the guide from 62 MB to 99 MB, nearly all of it rows for channels that
// already had a schedule under a different id.
const derivedGuide = (providerChannels, programmesByChannel) => {
  const bases = new Map();
  for (const ch of providerChannels) {
    if (!ch.name || !programmesByChannel.has(ch.epg_channel_id)) continue;
    const key = scopedBaseKey(providerCc(ch), ch.name);
    if (key && !bases.has(key)) bases.set(key, ch.epg_channel_id);
  }

  const channels = [];
  const programmes = [];
  const taken = new Set();

  for (const ch of providerChannels) {
    if (!ch.name || !PLUS_ONE.test(ch.name)) continue;
    if (programmesByChannel.has(ch.epg_channel_id)) continue; // has a schedule of its own
    const base = bases.get(scopedBaseKey(providerCc(ch), ch.name.replace(PLUS_ONE, "")));
    if (!base) continue;

    // Matched by name, so the id only has to be unique. Namespaced separately
    // from every other synthetic id, or a same-named row elsewhere takes it and
    // this one is silently dropped.
    const id = `plus1.${nameKey(ch.name)}`;
    if (taken.has(id)) continue;
    taken.add(id);

    channels.push({ id, element: xmltvChannel(id, [ch.name]) });
    for (const element of programmesByChannel.get(base))
      programmes.push({
        channel: id,
        element: element
          .replace(/\bstart="([^"]*)"/, (all, at) => `start="${anHourLater(at)}"`)
          .replace(/\bstop="([^"]*)"/, (all, at) => `stop="${anHourLater(at)}"`)
          .replace(/\bchannel="[^"]*"/, `channel="${escapeAttr(id)}"`),
      });
  }
  return { channels, programmes };
};

const channels = await loadChannels();
const index = buildIndex(channels);
console.log(`provider: ${channels.length} channels, ${index.byId.size} distinct id keys\n`);

const allChannels = [];
const allProgrammes = [];
const programmesByChannel = new Map();
const counts = {};
const seen = new Set();

// One merge for every producer, sources and events alike: first to claim an id
// wins, and a programme is only kept if its own channel actually got emitted.
const merge = (label, { channels: produced, programmes }) => {
  const emitted = new Set();
  for (const { id, element } of produced) {
    if (seen.has(id)) continue;
    seen.add(id);
    emitted.add(id);
    allChannels.push(element);
  }
  for (const { channel, element } of programmes) {
    if (!emitted.has(channel)) continue;
    allProgrammes.push(element);
    // Kept per channel as well, so a "+1" channel can be built from its base.
    if (!programmesByChannel.has(channel)) programmesByChannel.set(channel, []);
    programmesByChannel.get(channel).push(element);
  }
  counts[label] = emitted.size;
  console.log(`${label}: matched ${emitted.size} channels`);
};

for (const source of SOURCES) {
  try {
    merge(source.label, convert(await fetchSource(source), index, source));
  } catch (err) {
    counts[source.label] = 0;
    console.error(`${source.label}: skipped (${err.message})`);
  }
}

// Pass 5, and the one producer that does not go through convert(): its
// channels are matched by name, so there is no provider id to rewrite. Guarded
// like the sources are, so a bad row here cannot cost the whole guide.
try {
  const events = await eventGuide(channels);
  merge("Events", events);
  console.log(`  of those, ${events.borrowed} carry a real end time from Viaplay`);
} catch (err) {
  console.error(`Events: skipped (${err.message})`);
}

// Last, because it copies from what every other source already produced.
merge("Timeshift", derivedGuide(channels, programmesByChannel));

const xml =
  '<?xml version="1.0" encoding="UTF-8"?>\n' +
  '<tv generator-info-name="build-epg">\n' +
  `${allChannels.join("\n")}\n${allProgrammes.join("\n")}\n</tv>\n`;

const raw = Buffer.from(xml, "utf8");
writeFileSync(OUT, gzipSync(raw, { level: 9 }));
writeFileSync(COUNTS, `${JSON.stringify(counts, null, 2)}\n`);

console.log(
  `\n${OUT}: ${seen.size} channels, ${allProgrammes.length} programmes, ${mb(raw.length)} raw`
);
