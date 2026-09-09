// How a channel on one side is recognised as a channel on the other. Every
// source and every provider row is reduced to one of these keys; the passes in
// build-epg.mjs are just lookups in falling order of confidence.

// The ordinal in epgshare's split-country files (".us2") names the file, not
// the country, so it is not part of either half.
const ID_SUFFIX = /^(.*)\.([a-z]{2})\d?$/;

const splitId = (id) => {
  const m = ID_SUFFIX.exec(id);
  return m ? { body: m[1], cc: m[2] } : { body: id, cc: "" };
};

// "BBC.Four.HD.uk" and "BBC Four HD.uk" both collapse to "bbcfourhd|uk"
export const idKey = (id) => {
  const { body, cc } = splitId(id);
  return `${body.replace(/[.\s_-]/g, "").toLowerCase()}|${cc}`;
};

export const ccOf = (id) => splitId(id).cc;
export const bodyOf = (id) => splitId(id).body;

// "IS: RUV FHD" -> "isruvfhd". "+" becomes a word rather than vanishing,
// because it is the only thing that tells "TV3+" from "TV3".
export const nameKey = (name) =>
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
export const baseKey = (name) => {
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
export const scopedKey = (cc, text) => {
  const key = nameKey(bare(text));
  return cc && key ? `${cc}|${key}` : "";
};
export const scopedBaseKey = (cc, text) => {
  const key = baseKey(bare(text));
  return cc && key ? `${cc}|${key}` : "";
};
