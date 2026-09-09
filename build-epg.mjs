// Builds one merged EPG file whose channel ids match your provider's, so
// TiviMate picks everything up with no per-channel mapping.
//
// Local:  XTREAM_HOST=... XTREAM_USER=... XTREAM_PASS=... node build-epg.mjs
// CI:     driven by .github/workflows/build-epg.yml
//
// No dependencies. Node 18+.

import { writeFileSync } from "node:fs";
import { gunzipSync, gzipSync } from "node:zlib";

const EPGSHARE = "https://epgshare01.online/epgshare01/epg_ripper_";

// Order matters: the first source to claim a channel wins.
// `passthrough` keeps unmatched channels as-is, which the Icelandic guide
// needs because its ids are already your channel names.
const IPTVEPG = "https://iptv-epg.org/files/epg-";

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
  // last because it only fills leftovers, and it will start being skipped once
  // it outgrows that ceiling — see the size check in fetchSource.
  { label: "US extra", url: `${IPTVEPG}us.xml.gz` },
  // `borrowIcelandic` lets these serve my provider's Icelandic entries for
  // international channels, which carry the Nordic feed. Only the Nordic
  // sources may: a UK schedule on Discovery Iceland is the wrong programmes.
  { label: "Denmark", url: `${EPGSHARE}DK1.xml.gz`, borrowIcelandic: true },
  { label: "Norway", url: `${EPGSHARE}NO1.xml.gz`, borrowIcelandic: true },
  { label: "Sweden", url: `${EPGSHARE}SE1.xml.gz`, borrowIcelandic: true },
  // { label: "Germany", url: `${EPGSHARE}DE1.xml.gz` },
  // { label: "Spain", url: `${EPGSHARE}ES1.xml.gz` },
  // { label: "Italy", url: `${EPGSHARE}IT1.xml.gz` },
];

const OUT = "guide.xml.gz";

// "BBC.Four.HD.uk" and "BBC Four HD.uk" both collapse to "bbcfourhd|uk".
// The ordinal in epgshare's split-country files (".us2") is part of the file
// name, not of the country, so it must not end up inside the body.
const idKey = (id) => {
  const m = /^(.*)\.([a-z]{2})\d?$/.exec(id);
  const [body, cc] = m ? [m[1], m[2]] : [id, ""];
  return `${body.replace(/[.\s_-]/g, "").toLowerCase()}|${cc}`;
};

const ccOf = (id) => idKey(id).split("|")[1];

// "IS: RUV FHD" -> "isruvfhd". "+" becomes a word rather than vanishing,
// because it is the only thing that tells "TV3+" from "TV3".
const nameKey = (name) =>
  name.replace(/\+/g, "plus").replace(/[^\p{L}\p{N}]/gu, "").toLowerCase();

// "IS: RUV 2 HD" -> "isruv2", so it also matches "IS: RUV 2" and "IS: RUV 2 FHD".
// Feed variants stack up in my provider's names and have to come off together:
// "Sky Sport Main Event UHD 4K B", "TNT Sports 1 FHD P50", "BBC One HDR 4K".
// The trailing A/B is a backup feed, and my provider writes "Sky Sport" where
// epgshare writes "Sky Sports".
const VARIANT = /(fhd|uhd|hd|sd|4k|hdr|p50|2160p|1080p)$/;

const baseKey = (name) => {
  let key = nameKey(name).replace(/sports/g, "sport");
  if (/(fhd|uhd|hd|sd|4k|hdr|p50)[ab]$/.test(key)) key = key.slice(0, -1);
  for (let pass = 0; pass < 4; pass++) {
    const shorter = key.replace(VARIANT, "");
    if (shorter === key || !shorter) break;
    key = shorter;
  }
  return key;
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
// the same name.
const scopedKey = (cc, text) => {
  const key = nameKey(bare(text));
  return key ? `${cc}|${key}` : "";
};
const scopedBaseKey = (cc, text) => {
  const key = baseKey(bare(text));
  return key ? `${cc}|${key}` : "";
};

const escapeAttr = (s) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");

const attr = (element, name) => {
  const m = new RegExp(`\\b${name}="([^"]*)"`).exec(element);
  return m ? m[1] : null;
};

// The largest string V8 will hold. Some of these files are close enough to it
// that saying so beats an ERR_STRING_TOO_LONG stack trace in the log.
const MAX_STRING = 0x1fffffe8;

const fetchSource = async ({ url }) => {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const raw = url.endsWith(".gz") ? gunzipSync(buf) : buf;
  if (raw.length > MAX_STRING)
    throw new Error(`${(raw.length / 1048576).toFixed(0)} MB uncompressed, too big to parse`);
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

// Six lookups, tried in order of confidence.
const buildIndex = (channels) => {
  const byId = new Map();
  const byName = new Map();
  const byBase = new Map();
  const byScoped = new Map();
  const byScopedBase = new Map();
  const byIcelandic = new Map();
  const aliases = new Map();
  const targetCc = new Map();
  const add = (map, key, value) => {
    if (!key) return;
    if (!map.has(key)) map.set(key, new Set());
    map.get(key).add(value);
  };

  for (const ch of channels) {
    const target = ch.epg_channel_id;
    if (!target) {
      // No id means TiviMate can only ever match this row on the channel name,
      // so remember the name and emit it as an extra <display-name>. Keyed by
      // country, or the Vietnamese Animal Planet would collect a Nordic one.
      if (ch.name) {
        const cc = providerCc(ch);
        add(aliases, scopedKey(cc, ch.name), ch.name);
        add(aliases, scopedBaseKey(cc, ch.name), ch.name);
      }
      continue;
    }
    targetCc.set(target, providerCc(ch));
    add(byId, idKey(target), target);
    if (ch.name) {
      add(byName, nameKey(ch.name), target);
      add(byBase, baseKey(ch.name), target);

      // Index the id's own body too — it is often the better name carrier,
      // "AandE Network (East).us" naming the channel that "US: A&E HD" is.
      const cc = providerCc(ch);
      for (const label of [ch.name, target.replace(/\.[a-z]{2}\d?$/, "")]) {
        add(byScoped, scopedKey(cc, label), target);
        add(byScopedBase, scopedBaseKey(cc, label), target);
        if (cc === "is") add(byIcelandic, baseKey(bare(label)), target);
      }
    }
  }
  return { byId, byName, byBase, byScoped, byScopedBase, byIcelandic, aliases, targetCc };
};

const CHANNEL = /<channel\b[^>]*?>[\s\S]*?<\/channel>|<channel\b[^>]*?\/>/g;
const PROGRAMME = /<programme\b[^>]*?>[\s\S]*?<\/programme>|<programme\b[^>]*?\/>/g;
const DISPLAY_NAME = /<display-name[^>]*>([\s\S]*?)<\/display-name>/g;

const displayNames = (element) =>
  [...element.matchAll(DISPLAY_NAME)].map((m) => m[1].trim());

const TITLE = /<title[^>]*>([\s\S]*?)<\/title>/;

// iptv-epg.org fills channels it has no schedule for with hourly filler. Left
// alone it is worse than an empty channel: it claims the id, so no other source
// can serve it and my provider's own EPG never shows through either.
const PLACEHOLDER = /^(no data|no event today|no information|no programme|tba|to be announced|n\/a|-)$/i;

const isPlaceholder = (element) => PLACEHOLDER.test((TITLE.exec(element) ?? [])[1]?.trim() ?? "");

// Source channels carrying at least one real programme. Anything else must not
// claim a target.
const channelsWithData = (xml) => {
  const withData = new Set();
  for (const [element] of xml.matchAll(PROGRAMME)) {
    if (isPlaceholder(element)) continue;
    const channel = attr(element, "channel");
    if (channel) withData.add(channel);
  }
  return withData;
};

const bodyOf = (sourceId) => sourceId.replace(/\.[a-z]{2}\d?$/, "");

const convert = (xml, index, { passthrough, borrowIcelandic } = {}) => {
  const { byId, byName, byBase, byScoped, byScopedBase, byIcelandic, aliases, targetCc } = index;
  const withData = channelsWithData(xml);
  const elements = [...xml.matchAll(CHANNEL)]
    .map(([element]) => ({ element, sourceId: attr(element, "id") }))
    .filter((c) => c.sourceId && withData.has(c.sourceId));

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

  const labelsOf = (element, sourceId) => [bodyOf(sourceId), ...displayNames(element)];

  // Pass 1: exact ids and names.
  for (const { element, sourceId } of elements) {
    take(
      sourceId,
      byId.get(idKey(sourceId)) ??
        byName.get(nameKey(sourceId)) ??
        displayNames(element).map((d) => byName.get(nameKey(d))).find(Boolean)
    );
  }

  // Pass 2: quality-suffix fallback.
  for (const { element, sourceId } of elements) {
    take(
      sourceId,
      byBase.get(baseKey(sourceId)) ??
        displayNames(element).map((d) => byBase.get(baseKey(d))).find(Boolean)
    );
  }

  // Pass 3: my provider's ids come from a different vendor than epgshare's, so
  // for most countries the name is the only thing the two sides share. Country
  // is part of the key, so this cannot match across countries.
  for (const { element, sourceId } of elements) {
    const cc = ccOf(sourceId);
    if (!cc) continue;
    let loose;
    for (const label of labelsOf(element, sourceId)) {
      loose = byScoped.get(scopedKey(cc, label)) ?? byScopedBase.get(scopedBaseKey(cc, label));
      if (loose) break;
    }
    take(sourceId, loose);
  }

  // Pass 4: the Icelandic guide covers 14 national channels. The rest of my
  // provider's Icelandic entries are international channels on the Nordic
  // feed, which only these sources carry.
  if (borrowIcelandic) {
    for (const { element, sourceId } of elements) {
      let loose;
      for (const label of labelsOf(element, sourceId)) {
        loose = byIcelandic.get(baseKey(bare(label)));
        if (loose) break;
      }
      take(sourceId, loose);
    }
  }

  // Pass 5: channels wanted only by rows that carry no id. They are emitted
  // under their own id and matched by name, so the id is irrelevant.
  const aliasNames = (element, sourceId, cc) => {
    const names = new Set();
    if (!cc) return names;
    for (const label of labelsOf(element, sourceId))
      for (const name of [
        ...(aliases.get(scopedKey(cc, label)) ?? []),
        ...(aliases.get(scopedBaseKey(cc, label)) ?? []),
      ])
        names.add(name);
    return names;
  };

  for (const { element, sourceId } of elements) {
    if (resolved.has(sourceId)) continue;
    const countries = borrowIcelandic ? [ccOf(sourceId), "is"] : [ccOf(sourceId)];
    if (countries.some((cc) => aliasNames(element, sourceId, cc).size))
      resolved.set(sourceId, new Set([sourceId]));
  }

  // Passthrough runs last so every match has had its chance first.
  if (passthrough) {
    for (const { sourceId } of elements) {
      if (!resolved.has(sourceId)) resolved.set(sourceId, new Set([sourceId]));
    }
  }

  // TiviMate's last resort is the channel name against a <display-name>, so
  // carry my provider's own names for the rows that have no id to match on.
  // Scoped to the country of the id being emitted, so a schedule never reaches
  // a same-named channel in another market.
  const withAliases = (element, sourceId, target) => {
    const names = aliasNames(element, sourceId, targetCc.get(target) ?? ccOf(sourceId));
    if (!names.size) return element;
    const extra = [...names].map((n) => `\n    <display-name>${escapeAttr(n)}</display-name>`).join("");
    return element.endsWith("/>")
      ? `${element.replace(/\s*\/>$/, ">")}${extra}\n  </channel>`
      : element.replace(/<\/channel>$/, `${extra}\n  </channel>`);
  };

  const channels = [];
  for (const { element, sourceId } of elements) {
    const targets = resolved.get(sourceId);
    if (!targets) continue;
    for (const target of targets)
      channels.push(
        withAliases(element, sourceId, target).replace(/\bid="[^"]*"/, `id="${escapeAttr(target)}"`)
      );
  }

  const programmes = [];
  for (const [element] of xml.matchAll(PROGRAMME)) {
    if (isPlaceholder(element)) continue;
    const targets = resolved.get(attr(element, "channel"));
    if (!targets) continue;
    for (const target of targets)
      programmes.push(
        element.replace(/\bchannel="[^"]*"/, `channel="${escapeAttr(target)}"`)
      );
  }

  return { channels, programmes };
};

const channels = await loadChannels();
const index = buildIndex(channels);
console.log(
  `provider: ${channels.length} channels, ${index.byId.size} distinct epg ids\n`
);

const allChannels = [];
const allProgrammes = [];
const seen = new Set();

for (const source of SOURCES) {
  try {
    const xml = await fetchSource(source);
    const { channels: c, programmes: p } = convert(xml, index, source);

    let kept = 0;
    const skipped = new Set();
    for (const element of c) {
      const id = attr(element, "id");
      if (seen.has(id)) {
        skipped.add(id);
        continue;
      }
      seen.add(id);
      allChannels.push(element);
      kept++;
    }
    // Drop programmes for channels an earlier source already claimed.
    for (const element of p) {
      if (!skipped.has(attr(element, "channel"))) allProgrammes.push(element);
    }

    console.log(`${source.label}: matched ${kept} channels`);
  } catch (err) {
    console.error(`${source.label}: skipped (${err.message})`);
  }
}

const xml =
  '<?xml version="1.0" encoding="UTF-8"?>\n' +
  '<tv generator-info-name="build-epg">\n' +
  `${allChannels.join("\n")}\n${allProgrammes.join("\n")}\n</tv>\n`;

writeFileSync(OUT, gzipSync(Buffer.from(xml, "utf8"), { level: 9 }));

const mb = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`;
console.log(
  `\n${OUT}: ${seen.size} channels, ${allProgrammes.length} programmes, ` +
    `${mb(Buffer.byteLength(xml))} raw`
);
