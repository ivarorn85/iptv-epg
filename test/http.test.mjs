// Retry behaviour, against a real server rather than a stubbed fetch — the
// point is what happens over HTTP, and a stub would only prove the stub.
//
// The case that prompted it: all three iptv-epg.org sources answered HTTP 526
// for one run, and the publish gate rightly refused a guide missing 149
// channels. A transient upstream failure should not cost a day's refresh.

import { strict as assert } from "node:assert";
import { createServer } from "node:http";
import { after, describe, it } from "node:test";

import { getJson, request } from "../http.mjs";

// A server that answers with whatever the test queues up, and counts the hits.
const hits = [];
let script = [];

const server = createServer((req, res) => {
  hits.push(req.headers["user-agent"]);
  const status = script.shift() ?? 200;
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ status }));
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const url = `http://127.0.0.1:${server.address().port}/`;
const run = (plan, options) => {
  script = plan;
  hits.length = 0;
  return request(url, { retryDelayMs: 1, ...options });
};

after(() => server.close());

describe("request", () => {
  it("sends a User-Agent that names this project", async () => {
    await run([]);
    assert.equal(hits.length, 1);
    assert.match(hits[0], /^iptv-epg\//);
    // The default "node" is refused outright by at least one upstream.
    assert.notEqual(hits[0], "node");
  });

  it("retries a server-side failure and returns the eventual success", async () => {
    const res = await run([526, 503]);
    assert.equal(res.status, 200);
    assert.equal(hits.length, 3, "should have asked three times");
  });

  it("retries a rate limit", async () => {
    const res = await run([429]);
    assert.equal(res.status, 200);
    assert.equal(hits.length, 2);
  });

  it("gives up after the last attempt and reports the status", async () => {
    await assert.rejects(run([526, 526, 526]), /HTTP 526/);
    assert.equal(hits.length, 3, "should not exceed the attempt limit");
  });

  it("does not retry a client error, which would say the same thing again", async () => {
    await assert.rejects(run([404]), /HTTP 404/);
    assert.equal(hits.length, 1);
  });

  it("throws rather than returning a failed response", async () => {
    // Callers read the body straight away, so a non-ok must not reach them.
    await assert.rejects(run([500, 500, 500]), /HTTP 500/);
  });

  it("gives up at its own timeout, not at some later one", async () => {
    // Asserting only that it rejects proves nothing: with the timeout removed
    // this still passed, after 306 seconds, because Node's own server request
    // timeout destroyed the socket. The elapsed time is the whole assertion —
    // a regression here would quietly turn the build into a five-minute wait.
    const slow = createServer(() => {}); // accepts, never answers
    await new Promise((resolve) => slow.listen(0, "127.0.0.1", resolve));
    const slowUrl = `http://127.0.0.1:${slow.address().port}/`;

    const began = Date.now();
    await assert.rejects(request(slowUrl, { timeoutMs: 250, attempts: 1 }));
    const elapsed = Date.now() - began;
    slow.close();

    assert.ok(elapsed < 5_000, `gave up after ${elapsed}ms, so the timeout was not its own`);
  });

  it("retries a connection that fails rather than answers", async () => {
    // The syn.is case, and the shape a real outage takes more often than a
    // clean 5xx: the connection is refused or reset, so there is no status to
    // read. A retry must still happen.
    const closed = createServer(() => {});
    await new Promise((resolve) => closed.listen(0, "127.0.0.1", resolve));
    const port = closed.address().port;
    await new Promise((resolve) => closed.close(resolve)); // nothing listens now

    let attempts = 0;
    const counting = createServer((req, res) => {
      attempts++;
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });

    // First attempt hits nothing; once the server is up the retry must succeed.
    setTimeout(() => counting.listen(port, "127.0.0.1"), 50);
    const res = await request(`http://127.0.0.1:${port}/`, { retryDelayMs: 200, attempts: 3 });
    assert.equal(res.status, 200);
    assert.ok(attempts >= 1, "the retry has to have reached the server");
    counting.close();
  });
});

describe("getJson", () => {
  it("parses the body of a successful request", async () => {
    script = [];
    assert.deepEqual(await getJson(url, { retryDelayMs: 1 }), { status: 200 });
  });
});
