// Builds one merged XMLTV guide whose channel ids match my provider's, so
// TiviMate fills the grid with no per-channel mapping. Fetched sources are
// matched to it in five passes of falling confidence, and two more producers
// derive what no source publishes — the README explains why each one exists.
//
// This file holds the source list, the matching, and the run itself. The
// producers that generate a guide rather than match one live in their own
// modules: iceland.mjs, events.mjs, timeshift.mjs.
//
// Local:  XTREAM_HOST=... XTREAM_USER=... XTREAM_PASS=... node build-epg.mjs
// CI:     driven by .github/workflows/build-epg.yml
//
// No dependencies. Needs Node 18 or newer; CI runs 22.

import { writeFileSync } from "node:fs";
import { gunzipSync, gzipSync } from "node:zlib";

import * as cache from "./cache.mjs";
import {
  CHANNEL,
  DISPLAY_NAME,
  PROGRAMME,
  attr,
  escapeAttr,
  hours,
  isPlaceholder,
  mb,
  parseTime,
  slotKey,
} from "./epg-xml.mjs";
import { EVENT_NAME, eventGuide } from "./events.mjs";
import { getJson, request } from "./http.mjs";
import { ruvGuide, synGuide } from "./iceland.mjs";
import { siminnGuide } from "./siminn.mjs";
import { baseKey, bodyOf, ccOf, idKey, nameKey, providerCc, scopedBaseKey, scopedKey } from "./keys.mjs";
import { PLUS_ONE, timeshiftGuide } from "./timeshift.mjs";

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
  // The Icelandic schedule for the international channels, which is the right
  // one for Icelandic rows: before this, four of them were served Sweden's
  // because no Icelandic source carried them, and Omega and ARTE ÞÝSK had
  // nothing at all. Ahead of the aggregators below on purpose — and it is the
  // only Icelandic source here that is not iptv-epg.org, which took 135
  // channels' guide down with it for a day and a half.
  { label: "Síminn", build: siminnGuide },
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
// How the builder hands the gate what it cannot see in the guide itself: what
// each source matched, and which of them were served from a cached copy.
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
//
// A Map rather than an object literal, because the keys are provider ids: an id
// of "constructor" would read a function off the prototype chain, and iterating
// that would cost the source its whole output.
const ALSO_KNOWN_AS = new Map([["BBCOne.uk", ["UK: BBC One 1 HDR 4K", "UK: BBC One 2 HDR 4K"]]]);

// Whether the list above still describes the playlist. A hand-written table is
// the only thing here that can silently stop applying — a renamed row or a
// retired id makes an entry a no-op with no error anywhere — so every run says
// so. Warns rather than fails: an entry going stale costs two channels their
// guide, which is not worth refusing a whole publish over.
const checkAliasList = (channels) => {
  const ids = new Set(channels.map((ch) => ch.epg_channel_id).filter(Boolean));
  const names = new Set(channels.map((ch) => ch.name).filter(Boolean));
  for (const [id, aliases] of ALSO_KNOWN_AS) {
    if (!ids.has(id)) console.error(`ALSO_KNOWN_AS: no channel carries the id "${id}" any more`);
    for (const name of aliases)
      if (!names.has(name)) console.error(`ALSO_KNOWN_AS: no channel is named "${name}" any more`);
  }
};

// The largest string V8 will hold. Some of these files are close enough to it
// that saying so beats an ERR_STRING_TOO_LONG stack trace in the log.
const MAX_STRING = 0x1fffffe8;

// One wall-clock budget for all the fetching, rather than per-request timeouts
// that multiply. Twelve sources at two attempts and a three-minute timeout is
// over an hour of worst case against a twenty-minute job, so two hung hosts
// would cost the whole run — the opposite of the rule that an unreachable
// upstream costs only its own source. A source that finds the budget spent
// fails fast and falls back to its cached copy, which is what that copy is
// for. The happy path is about four minutes.
const FETCH_BUDGET_MS = 11 * 60_000;
const SOURCE_TIMEOUT_MS = 180_000;
let fetchDeadline = Infinity;

const fetchSource = async ({ url, build }) => {
  // Checked before the build() branch, not after: those producers make twenty
  // or thirty requests of their own, and syn.is is the one host here known to
  // be hostile. Letting them skip the budget was exactly the hole the budget
  // exists to close.
  const left = fetchDeadline - Date.now();
  if (left <= 0) throw new Error("the run's fetch budget is spent");

  if (build) return build(); // assembled from a JSON API rather than fetched as XMLTV

  // Generous, because one of these is a 59 MB download — but never more than
  // the budget has left, so the last source cannot overrun the job on its own.
  const res = await request(url, { timeoutMs: Math.min(SOURCE_TIMEOUT_MS, left), attempts: 2 });
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

  try {
    return await getJson(url);
  } catch (err) {
    throw new Error(`Xtream API: ${err.message}`);
  }
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
  //
  // One donor per name, first seen, where every other index here holds a set.
  // That is a choice, not an oversight: where several ids share a name, letting
  // the orphan inherit from all of them would advertise one name on several
  // channels, and a player then picks between them. One channel, even if a
  // better sibling existed, beats a name that means two things.
  const donors = new Map();
  const orphans = [];
  const inherited = new Map();
  const add = (map, key, value) => {
    if (!key) return;
    if (!map.has(key)) map.set(key, new Set());
    map.get(key).add(value);
  };

  // A "+1" row whose id normalises to the same key as a base row's, without
  // being the same string. My provider gives "UK: 5 Usa  1" the id "5USA.uk"
  // and "UK: 5 Usa" the id "5 USA.uk", and idKey collapses the space away, so
  // one source channel claimed both and the +1 row published the base
  // channel's schedule unshifted — an hour early, every programme, with
  // nothing to say so. Leaving the id unindexed means no source claims it and
  // timeshift.mjs fills the row properly instead.
  //
  // Scoped to that collision on purpose. The seven rows whose id IS a real
  // upstream +1 feed ("E4+1.uk", "ITV3+1.uk") key differently from their base
  // and keep matching, and where the provider hands a +1 row its base id
  // verbatim ("UK: Channel 5  1") nothing here can tell the two apart.
  const shadowed = new Set();
  const baseIds = new Map();
  for (const ch of channels)
    if (ch.epg_channel_id && ch.name && !PLUS_ONE.test(ch.name))
      add(baseIds, idKey(ch.epg_channel_id), ch.epg_channel_id);
  for (const ch of channels) {
    if (!ch.epg_channel_id || !ch.name || !PLUS_ONE.test(ch.name)) continue;
    const sharing = baseIds.get(idKey(ch.epg_channel_id));
    if (sharing && [...sharing].some((id) => id !== ch.epg_channel_id))
      shadowed.add(ch.epg_channel_id);
  }

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

    // Deliberately unreachable by any source, so the timeshift pass fills it.
    if (shadowed.has(target)) continue;

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
  // Which targets are the provider's own ids, as opposed to a source id that
  // pass 4 or passthrough keeps as-is. Only the provider can re-point one of
  // its ids at a different channel, so only these need re-checking when a
  // cached copy is replayed days later. Marking them matters: checking all of
  // them cost the US sports fallback 30 of its 31 channels, those being
  // matched by name and so carrying the source's ids, not the provider's.
  const fromProvider = new Set();

  const take = (sourceId, found) => {
    const targets = new Set([...(found ?? [])].filter((t) => !claimed.has(t)));
    if (!targets.size) return;
    const already = resolved.get(sourceId);
    if (already) for (const t of targets) already.add(t);
    else resolved.set(sourceId, targets);
    for (const t of targets) {
      claimed.add(t);
      fromProvider.add(t);
    }
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
    for (const name of ALSO_KNOWN_AS.get(target) ?? []) names.add(name);
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
        fromProvider: fromProvider.has(target),
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
    // the same instant, or with a stamp nothing can read. All three are dropped
    // here rather than left for the gate: the gate refuses the whole publish,
    // and one bad row from an upstream nobody here controls is not worth the
    // rest of the grid going unrefreshed.
    const from = parseTime(attr(element, "start") ?? "");
    const to = parseTime(attr(element, "stop") ?? "");
    if (!(to > from)) continue;
    for (const target of resolved.get(attr(element, "channel")) ?? [])
      programmes.push({
        channel: target,
        element: element.replace(/\bchannel="[^"]*"/, `channel="${escapeAttr(target)}"`),
      });
  }

  return { channels, programmes };
};

const channels = await loadChannels();
const index = buildIndex(channels);
checkAliasList(channels);
console.log(`provider: ${channels.length} channels, ${index.byId.size} distinct id keys\n`);

const allChannels = [];
const allProgrammes = [];
const programmesByChannel = new Map();
const counts = {};
// Every channel-and-slot already filled, so an upstream repeating itself cannot
// reach the guide. Global rather than per source: only one source ever emits a
// given channel, but this way a producer cannot repeat itself either.
const slots = new Set();
let repeats = 0;
const stale = {}; // label -> age in days of the cached copy standing in for it
const collapsed = {}; // label -> a run whose matching fell off a cliff
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
    // One programme per channel and slot. Upstreams do repeat themselves — UK1
    // publishes Sky Kids twice, every programme of it, and guide3 repeats a
    // handful of Icelandic rows — and a repeat is not harmless: the grid shows
    // one of two identical entries, chosen arbitrarily. Measured at 391 of
    // 79,497 programmes in the last run before this existed.
    const slot = slotKey(channel, element);
    if (slots.has(slot)) {
      repeats++;
      continue;
    }
    slots.add(slot);
    allProgrammes.push(element);
    // Kept per channel as well, so a "+1" channel can be built from its base.
    // These are the same strings allProgrammes holds, not copies, so the cost
    // is the array slots and not the text — which is why this does not
    // contradict the note above about never holding a source's programmes.
    if (!programmesByChannel.has(channel)) programmesByChannel.set(channel, []);
    programmesByChannel.get(channel).push(element);
  }
  counts[label] = emitted.size;
  console.log(`${label}: matched ${emitted.size} channels`);
};

// A source that fails is served from its last good output rather than dropped:
// a guide fetched yesterday still covers the days ahead, and one bad fetch
// should not empty a grid that was fine an hour ago. cache.mjs explains the
// bounds. The failure is still reported, and still recorded as such in
// counts.json, so the gate and the log show it instead of it passing silently.
fetchDeadline = Date.now() + FETCH_BUDGET_MS;

// Ids the playlist still carries, so a cached channel cannot be emitted under
// an id the provider has since pointed at a different channel.
const stillKnown = new Set(channels.map((ch) => ch.epg_channel_id).filter(Boolean));

for (const source of SOURCES) {
  const { label } = source;
  let produced = null;

  try {
    produced = convert(await fetchSource(source), index, source);
  } catch (err) {
    // load() is documented never to throw, and is wrapped anyway: a fallback
    // that fails must cost this source its channels, never the whole build.
    let fallback = null;
    try {
      fallback = cache.load(label, { stillKnown });
    } catch (cacheErr) {
      console.error(`${label}: the cached copy could not be read (${cacheErr.message})`);
    }

    if (!fallback) {
      counts[label] = 0;
      console.error(`${label}: failed (${err.message}), and no usable cached copy — no guide this run`);
      continue;
    }
    produced = fallback;
    stale[label] = fallback.ageDays;
    console.error(
      `${label}: failed (${err.message}), serving a cached copy ${hours(fallback.ageDays)} old`
    );
  }

  // Outside the try on purpose. A disk error here is not an upstream failure,
  // and letting it fall into the catch above would discard a good live fetch
  // and then blame the source for it.
  if (!(label in stale)) {
    try {
      const saved = cache.save(label, produced);
      // The cache declining to overwrite means this run matched far fewer
      // channels than the copy it holds — the silent half of a source
      // breaking, since the gate's per-source check only fires at zero.
      if (saved?.collapsed) collapsed[label] = saved.collapsed;
    } catch (err) {
      console.error(`${label}: fetched fine, but the cached copy could not be written (${err.message})`);
    }
  }

  merge(label, produced);
}

// Pass 5. Like the timeshift below it this skips convert() entirely: both
// producers emit channels found by name, so there is no provider id to rewrite
// and nothing to match. Guarded like the sources are, so a bad row here cannot
// cost the whole guide.
try {
  const events = await eventGuide(channels);
  merge("Events", events);
  console.log(`  of those, ${events.borrowed} carry a real end time from Viaplay`);
} catch (err) {
  console.error(`Events: skipped (${err.message})`);
}

// Last, because it copies from what every other producer emitted. Guarded like
// the rest: it walks provider-supplied strings, and by this point every
// download is already paid for, so a throw here must not cost the whole build.
try {
  const timeshift = timeshiftGuide(channels, programmesByChannel);
  merge("Timeshift", timeshift);
  if (timeshift.unshiftable)
    console.error(`  ${timeshift.unshiftable} programmes dropped: their stamps would not shift`);
} catch (err) {
  console.error(`Timeshift: skipped (${err.message})`);
}

const xml =
  '<?xml version="1.0" encoding="UTF-8"?>\n' +
  '<tv generator-info-name="build-epg">\n' +
  `${allChannels.join("\n")}\n${allProgrammes.join("\n")}\n</tv>\n`;

const raw = Buffer.from(xml, "utf8");
writeFileSync(OUT, gzipSync(raw, { level: 9 }));
writeFileSync(COUNTS, `${JSON.stringify({ sources: counts, stale, collapsed }, null, 2)}\n`);

console.log(
  `\n${OUT}: ${seen.size} channels, ${allProgrammes.length} programmes, ${mb(raw.length)} raw`
);
if (repeats) console.log(`${repeats} repeated programmes dropped: an upstream listing itself twice`);
