// Every outbound request goes through here, for two reasons learned the hard way.
//
// syn.is refuses Node's default User-Agent — the literal string "node" — by
// resetting the connection, which is indistinguishable from the site being
// down. It took a while to notice because GitHub's runners were getting through
// while a local build was not. An honest name is enough; no spoofing needed.
//
// And an unbounded fetch can hang until the job's own timeout, so every request
// carries its own.

const USER_AGENT = "iptv-epg/1.0 (+https://github.com/ivarorn85/iptv-epg)";

// Enough for a JSON API. The big guide files pass their own.
const TIMEOUT_MS = 60_000;

export const request = async (url, { timeoutMs = TIMEOUT_MS, ...options } = {}) => {
  const res = await fetch(url, {
    redirect: "follow",
    ...options,
    headers: { "user-agent": USER_AGENT, ...options.headers },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res;
};

export const getJson = async (url, options) => (await request(url, options)).json();
