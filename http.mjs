// Every outbound request goes through here, for three reasons learned the hard way.
//
// syn.is refuses Node's default User-Agent — the literal string "node" — by
// resetting the connection, which is indistinguishable from the site being
// down. It took a while to notice because GitHub's runners were getting through
// while a local build was not. An honest name is enough; no spoofing needed.
//
// An unbounded fetch can hang until the job's own timeout, so every request
// carries its own.
//
// And upstreams fail briefly: all three iptv-epg.org sources once answered
// HTTP 526 for a single run, which cost a day's refresh because the publish
// gate rightly refused a guide missing 149 channels. A server-side failure is
// worth asking again about.

const USER_AGENT = "iptv-epg/1.0 (+https://github.com/ivarorn85/iptv-epg)";

// Enough for a JSON API. The big guide files pass their own.
const TIMEOUT_MS = 60_000;

const ATTEMPTS = 3;
const RETRY_DELAY_MS = 3_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 4xx says the same thing however often it is asked. 5xx and 429 do not.
const worthRetrying = (status) => status >= 500 || status === 429;

// One caller needs the body of a response that is not ok, because siminn.is
// serves its whole television schedule under an HTTP 500 — a working page with
// a broken status. Opt-in and named, so nothing else can swallow a failure by
// accident: everywhere else, a bad status is still an error.
export const request = async (
  url,
  {
    timeoutMs = TIMEOUT_MS,
    attempts = ATTEMPTS,
    retryDelayMs = RETRY_DELAY_MS,
    anyStatus = false,
    ...options
  } = {}
) => {
  for (let attempt = 1; ; attempt++) {
    const last = attempt >= attempts;
    let res;

    try {
      res = await fetch(url, {
        redirect: "follow",
        ...options,
        headers: { "user-agent": USER_AGENT, ...options.headers },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      // A reset connection, a DNS failure or our own timeout.
      if (last) throw err;
      await sleep(retryDelayMs * attempt);
      continue;
    }

    if (res.ok || anyStatus) return res;
    if (last || !worthRetrying(res.status)) throw new Error(`HTTP ${res.status}`);
    await sleep(retryDelayMs * attempt);
  }
};

export const getJson = async (url, options) => (await request(url, options)).json();
