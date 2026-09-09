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
const SOURCES = [
  { label: "Iceland", url: "https://is-epg.run.place/iptv/guide3.xml", passthrough: true },
  { label: "UK", url: `${EPGSHARE}UK1.xml.gz` },
  { label: "US", url: `${EPGSHARE}US2.xml.gz` },
  { label: "US sports", url: `${EPGSHARE}US_SPORTS1.xml.gz` },
  { label: "Denmark", url: `${EPGSHARE}DK1.xml.gz` },
  { label: "Norway", url: `${EPGSHARE}NO1.xml.gz` },
  { label: "Sweden", url: `${EPGSHARE}SE1.xml.gz` },
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

// "IS: RUV 2 HD" -> "isruv2", so it also matches "IS: RUV 2" and "IS: RUV 2 FHD"
const baseKey = (name) => nameKey(name).replace(/(fhd|uhd|hd|sd|4k)$/, "");

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

const fetchSource = async ({ url }) => {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  return url.endsWith(".gz") ? gunzipSync(buf).toString("utf8") : buf.toString("utf8");
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
  return prefix ? prefix[1].toLowerCase() : ccOf(ch.epg_channel_id);
};

// Five lookups, tried in order of confidence.
const buildIndex = (channels) => {
  const byId = new Map();
  const byName = new Map();
  const byBase = new Map();
  const byScoped = new Map();
  const byScopedBase = new Map();
  const add = (map, key, value) => {
    if (!key) return;
    if (!map.has(key)) map.set(key, new Set());
    map.get(key).add(value);
  };

  for (const ch of channels) {
    const target = ch.epg_channel_id;
    if (!target) continue; // event feeds with no id can never match
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
      }
    }
  }
  return { byId, byName, byBase, byScoped, byScopedBase };
};

const CHANNEL = /<channel\b[^>]*?>[\s\S]*?<\/channel>|<channel\b[^>]*?\/>/g;
const PROGRAMME = /<programme\b[^>]*?>[\s\S]*?<\/programme>|<programme\b[^>]*?\/>/g;
const DISPLAY_NAME = /<display-name[^>]*>([\s\S]*?)<\/display-name>/g;

const displayNames = (element) =>
  [...element.matchAll(DISPLAY_NAME)].map((m) => m[1].trim());

const convert = (xml, { byId, byName, byBase, byScoped, byScopedBase }, passthrough) => {
  const elements = [...xml.matchAll(CHANNEL)]
    .map(([element]) => ({ element, sourceId: attr(element, "id") }))
    .filter((c) => c.sourceId);

  const resolved = new Map(); // source id -> Set of target ids
  const claimed = new Set();

  // Pass 1: exact matches only, so a loose match can never steal a channel
  // that something else matches precisely.
  for (const { element, sourceId } of elements) {
    const targets =
      byId.get(idKey(sourceId)) ??
      byName.get(nameKey(sourceId)) ??
      displayNames(element).map((d) => byName.get(nameKey(d))).find(Boolean);
    if (!targets) continue;
    resolved.set(sourceId, targets);
    for (const t of targets) claimed.add(t);
  }

  // Pass 2: quality-suffix fallback for whatever is left over.
  for (const { element, sourceId } of elements) {
    if (resolved.has(sourceId)) continue;
    const loose =
      byBase.get(baseKey(sourceId)) ??
      displayNames(element).map((d) => byBase.get(baseKey(d))).find(Boolean);
    const targets = new Set([...(loose ?? [])].filter((t) => !claimed.has(t)));
    if (targets.size) {
      resolved.set(sourceId, targets);
      for (const t of targets) claimed.add(t);
    }
  }

  // Pass 3: my provider's ids come from a different vendor than epgshare's, so
  // for most countries the name is the only thing the two sides share. Country
  // is part of the key, so this cannot match across countries.
  for (const { element, sourceId } of elements) {
    if (resolved.has(sourceId)) continue;
    const cc = ccOf(sourceId);
    if (!cc) continue;
    let loose;
    for (const label of [sourceId.replace(/\.[a-z]{2}\d?$/, ""), ...displayNames(element)]) {
      loose = byScoped.get(scopedKey(cc, label)) ?? byScopedBase.get(scopedBaseKey(cc, label));
      if (loose) break;
    }
    const targets = new Set([...(loose ?? [])].filter((t) => !claimed.has(t)));
    if (targets.size) {
      resolved.set(sourceId, targets);
      for (const t of targets) claimed.add(t);
    }
  }

  // Passthrough runs last so every match has had its chance first.
  if (passthrough) {
    for (const { sourceId } of elements) {
      if (!resolved.has(sourceId)) resolved.set(sourceId, new Set([sourceId]));
    }
  }

  const channels = [];
  for (const { element, sourceId } of elements) {
    const targets = resolved.get(sourceId);
    if (!targets) continue;
    for (const target of targets)
      channels.push(element.replace(/\bid="[^"]*"/, `id="${escapeAttr(target)}"`));
  }

  const programmes = [];
  for (const [element] of xml.matchAll(PROGRAMME)) {
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
    const { channels: c, programmes: p } = convert(xml, index, source.passthrough);

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
