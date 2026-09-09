// XMLTV shapes and the small helpers shared by the builder and its validator,
// so the thing that checks the guide cannot drift from the thing that writes it.

export const CHANNEL = /<channel\b[^>]*?>[\s\S]*?<\/channel>|<channel\b[^>]*?\/>/g;
export const PROGRAMME = /<programme\b[^>]*?>[\s\S]*?<\/programme>|<programme\b[^>]*?\/>/g;
export const DISPLAY_NAME = /<display-name[^>]*>([\s\S]*?)<\/display-name>/g;
export const TITLE = /<title[^>]*>([\s\S]*?)<\/title>/;

// Built once per attribute name and reused: attr() runs on every programme of
// every source, and compiling the pattern per call was the hottest waste here.
const patterns = {};

export const attr = (element, name) => {
  patterns[name] ??= new RegExp(`\\b${name}="([^"]*)"`);
  const m = patterns[name].exec(element);
  return m ? m[1] : null;
};

// Safe for element text as well as attribute values.
export const escapeAttr = (s) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");

export const mb = (bytes, digits = 1) => `${(bytes / 1048576).toFixed(digits)} MB`;

// Iceland is UTC+0 all year, and every source here publishes in it, so the
// offset is a constant rather than something to carry around.
export const xmltvTime = (date) => `${date.toISOString().replace(/\D/g, "").slice(0, 14)} +0000`;

// Emitters for the sources that publish JSON rather than XMLTV. Element order
// follows the DTD — title, desc, then category — because some readers care.
export const xmltvChannel = (id, names) =>
  `<channel id="${escapeAttr(id)}">\n` +
  names
    .filter(Boolean)
    .map((name) => `    <display-name>${escapeAttr(name)}</display-name>\n`)
    .join("") +
  `  </channel>`;

export const xmltvProgramme = ({ channel, start, stop, title, desc, categories = [], lang }) => {
  const tag = (name, text) =>
    `    <${name}${lang ? ` lang="${lang}"` : ""}>${escapeAttr(text)}</${name}>\n`;
  return (
    `<programme start="${xmltvTime(start)}" stop="${xmltvTime(stop)}" channel="${escapeAttr(channel)}">\n` +
    tag("title", title) +
    (desc ? tag("desc", desc) : "") +
    categories.filter(Boolean).map((category) => tag("category", category)).join("") +
    `  </programme>`
  );
};

export const HOUR_MS = 3_600_000;

// iptv-epg.org fills channels it has no schedule for with hourly filler, and
// its sports feeds with "No EVENT Today". Left alone that is worse than an
// empty channel: the filler claims the id, so no other source can serve it and
// my provider's own EPG never shows through either.
const PLACEHOLDER = /^(no data|no event today|no information|no programme|tba|to be announced|n\/a|-)$/i;

export const isPlaceholder = (element) =>
  PLACEHOLDER.test((TITLE.exec(element) ?? [])[1]?.trim() ?? "");
