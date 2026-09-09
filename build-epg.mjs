// Builds one merged EPG file whose channel ids match your provider's, so
// TiviMate picks everything up with no per-channel mapping.
//
// Local:  XTREAM_HOST=... XTREAM_USER=... XTREAM_PASS=... node build-epg.mjs
// CI:     driven by .github/workflows/build-epg.yml
//
// No dependencies. Node 18+.

import { writeFileSync } from "node:fs";
import { gunzipSync, gzipSync } from "node:zlib";

import {
  CHANNEL,
  DISPLAY_NAME,
  HOUR_MS,
  PROGRAMME,
  attr,
  escapeAttr,
  isPlaceholder,
  mb,
} from "./epg-xml.mjs";

const EPGSHARE = "https://epgshare01.online/epgshare01/epg_ripper_";
const IPTVEPG = "https://iptv-epg.org/files/epg-";

// Order matters: the first source to claim a channel wins.
// `passthrough` keeps unmatched channels as-is, which the Icelandic guide
// needs because its ids are already your channel names.
// `borrow` lets a source also serve another country's entries.
const SOURCES = [
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

// The ordinal in epgshare's split-country files (".us2") names the file, not
// the country, so it is not part of either half.
const ID_SUFFIX = /^(.*)\.([a-z]{2})\d?$/;

const splitId = (id) => {
  const m = ID_SUFFIX.exec(id);
  return m ? { body: m[1], cc: m[2] } : { body: id, cc: "" };
};

// "BBC.Four.HD.uk" and "BBC Four HD.uk" both collapse to "bbcfourhd|uk"
const idKey = (id) => {
  const { body, cc } = splitId(id);
  return `${body.replace(/[.\s_-]/g, "").toLowerCase()}|${cc}`;
};

const ccOf = (id) => splitId(id).cc;
const bodyOf = (id) => splitId(id).body;

// "IS: RUV FHD" -> "isruvfhd". "+" becomes a word rather than vanishing,
// because it is the only thing that tells "TV3+" from "TV3".
const nameKey = (name) =>
  name.replace(/\+/g, "plus").replace(/[^\p{L}\p{N}]/gu, "").toLowerCase();

// Feed variants stack up in my provider's names and have to come off together:
// "Sky Sport Main Event UHD 4K B", "TNT Sports 1 FHD P50", "BBC One HDR 4K".
// One token list builds both patterns, because when it was written twice the
// two drifted and "1080p B" stopped collapsing.
const VARIANTS = "fhd|uhd|hd|sd|4k|hdr|p50|2160p|1080p";
const VARIANT = new RegExp(`(${VARIANTS})$`);
const BACKUP_FEED = new RegExp(`(${VARIANTS})[ab]$`);

// "IS: RUV 2 HD" -> "isruv2", so it also matches "IS: RUV 2" and "IS: RUV 2 FHD".
// My provider also writes "Sky Sport" where epgshare writes "Sky Sports", so
// that folds here and not in the strict key above.
const baseKey = (name) => {
  let key = nameKey(name).replace(/sports/g, "sport");
  if (BACKUP_FEED.test(key)) key = key.slice(0, -1);
  for (;;) {
    const shorter = key.replace(VARIANT, "");
    if (shorter === key || !shorter) return key;
    key = shorter;
  }
};

// The two sides label the same channel differently and neither is wrong: my
// provider prefixes the country ("US: TBS HD"), epgshare prefixes a headend
// code ("[MTVSWHD] MTV HD") and suffixes a feed annotation ("DR1 Denmark
// (DK,DA)", "AandE Network (East)", "SVT1 HD (T)").
const bare = (text) =>
  text
    .replace(/^[A-Za-z0-9]{2,4}\s*:\s*/, "")
    .replace(/\[[^\]]*\]/g, "")
    .replace(/\([^)]*\)/g, "");

// Country is part of the key, so a UK channel can never claim the US entry of
// the same name. No country means no usable key at all — returning "" here
// keeps unlookupable entries out of the maps in the first place.
const scopedKey = (cc, text) => {
  const key = nameKey(bare(text));
  return cc && key ? `${cc}|${key}` : "";
};
const scopedBaseKey = (cc, text) => {
  const key = baseKey(bare(text));
  return cc && key ? `${cc}|${key}` : "";
};

// The largest string V8 will hold. Some of these files are close enough to it
// that saying so beats an ERR_STRING_TOO_LONG stack trace in the log.
const MAX_STRING = 0x1fffffe8;

const fetchSource = async ({ url }) => {
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
// the rows that don't carry a prefix.
const providerCc = (ch) => {
  const prefix = /^([A-Za-z]{2})\s*:/.exec(ch.name ?? "");
  return prefix ? prefix[1].toLowerCase() : ccOf(ch.epg_channel_id ?? "");
};

// Six lookups for matching, plus the provider names to emit for rows that have
// no id and the country each id belongs to.
const buildIndex = (channels) => {
  const byId = new Map();
  const byName = new Map();
  const byBase = new Map();
  const byScoped = new Map();
  const byScopedBase = new Map();
  const aliases = new Map();
  const targetCc = new Map();
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
      }
      continue;
    }

    targetCc.set(target, cc);
    add(byId, idKey(target), target);
    if (!ch.name) continue;
    add(byName, nameKey(ch.name), target);
    add(byBase, baseKey(ch.name), target);

    // Index the id's own body too — it is often the better name carrier,
    // "AandE Network (East).us" naming the channel that "US: A&E HD" is.
    for (const label of [ch.name, bodyOf(target)]) {
      add(byScoped, scopedKey(cc, label), target);
      add(byScopedBase, scopedBaseKey(cc, label), target);
    }
  }
  return { byId, byName, byBase, byScoped, byScopedBase, aliases, targetCc };
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
  const { byId, byName, byBase, byScoped, byScopedBase, aliases, targetCc } = index;
  const withData = channelsWithData(xml);

  // Labels and ids are read once here; the passes below walk this list six
  // times and re-scanning each element that often was pure waste.
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

  // Pass 1: exact ids and names.
  for (const { sourceId, names } of elements) {
    take(
      sourceId,
      byId.get(idKey(sourceId)) ??
        byName.get(nameKey(sourceId)) ??
        firstHit(names, (name) => byName.get(nameKey(name)))
    );
  }

  // Pass 2: quality-suffix fallback.
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

  // TiviMate's last resort is the channel name against a <display-name>, so
  // carry my provider's own names for the rows that have no id to match on.
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

  // Channels nothing has claimed, emitted under their own id: either because a
  // row with no id wants them by name, or because this source is passthrough.
  for (const { sourceId, labels } of elements) {
    if (resolved.has(sourceId)) continue;
    const wanted = [ccOf(sourceId), borrow].some((cc) => aliasNames(labels, cc).size);
    if (wanted || passthrough) resolved.set(sourceId, new Set([sourceId]));
  }

  // Scoped to the country of the id being emitted, so a schedule never reaches
  // a same-named channel in another market.
  const withAliases = (element, labels, target) => {
    const names = aliasNames(labels, targetCc.get(target) ?? ccOf(target));
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
    for (const target of resolved.get(attr(element, "channel")) ?? [])
      programmes.push({
        channel: target,
        element: element.replace(/\bchannel="[^"]*"/, `channel="${escapeAttr(target)}"`),
      });
  }

  return { channels, programmes };
};

// My provider names its per-event channels after the event itself: "[Livey]
// (9/9) 16:35 Aalborg Handbold - Paris Saint-Germain". No guide will ever carry
// those, and they have no id to match on — but the name already IS the
// schedule, so read it back out. The end time is the one thing the name does
// not give, hence a fixed block.
const EVENT_NAME = /^\[(?:[^\]]+)\]\s*\((\d{1,2})\/(\d{1,2})\)\s*(\d{1,2}):(\d{2})\s+(\S.*)$/;
const EVENT_HOURS = 3;

// A day/month with no year means the one that puts it nearest today.
const eventStart = (day, month, hour, minute) => {
  const now = Date.now();
  const thisYear = new Date(now).getUTCFullYear();
  const nearest = [-1, 0, 1]
    .map((shift) => Date.UTC(thisYear + shift, month - 1, day, hour, minute))
    .reduce((best, at) => (Math.abs(at - now) < Math.abs(best - now) ? at : best));
  return new Date(nearest);
};

const xmltvTime = (date) => `${date.toISOString().replace(/\D/g, "").slice(0, 14)} +0000`;

const eventGuide = (providerChannels) => {
  const channels = [];
  const programmes = [];

  for (const ch of providerChannels) {
    if (ch.epg_channel_id) continue; // a real id means a real source can serve it
    const match = EVENT_NAME.exec(ch.name ?? "");
    if (!match) continue;
    const [, day, month, hour, minute, event] = match;

    const start = eventStart(+day, +month, +hour, +minute);
    const stop = new Date(start.getTime() + EVENT_HOURS * HOUR_MS);
    if (stop.getTime() < Date.now()) continue; // a fixture the playlist never cleared out

    const id = `event.${nameKey(ch.name)}`;
    channels.push({
      id,
      element:
        `<channel id="${escapeAttr(id)}">\n` +
        `    <display-name>${escapeAttr(ch.name)}</display-name>\n  </channel>`,
    });
    programmes.push({
      channel: id,
      element:
        `<programme start="${xmltvTime(start)}" stop="${xmltvTime(stop)}" channel="${escapeAttr(id)}">\n` +
        `    <title>${escapeAttr(event.trim())}</title>\n  </programme>`,
    });
  }
  return { channels, programmes };
};

const channels = await loadChannels();
const index = buildIndex(channels);
console.log(`provider: ${channels.length} channels, ${index.byId.size} distinct epg ids\n`);

const allChannels = [];
const allProgrammes = [];
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
    if (emitted.has(channel)) allProgrammes.push(element);
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

merge("Events", eventGuide(channels));

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
