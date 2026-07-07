// One test per call on the peerkit-iroh napi binding.
// Runs offline (relay: false), so no internet is needed: endpoints connect
// directly via the addresses embedded in addr().
import test from "node:test";
import assert from "node:assert/strict";
import { PeerkitEndpoint } from "./index.js";

const LOCAL = { relay: false };
const MAX = 16 * 1024 * 1024;

// 4-byte big-endian length-prefixed framing (mirrors transport-libp2p-core).
const frame = (payload) => {
  const h = Buffer.alloc(4);
  h.writeUInt32BE(payload.length, 0);
  return Buffer.concat([h, payload]);
};
const unframe = (buf) => buf.subarray(4, 4 + buf.readUInt32BE(0));

// Bring up two connected endpoints; returns both endpoints and both conns.
async function connectedPair() {
  const server = await PeerkitEndpoint.create(LOCAL);
  const client = await PeerkitEndpoint.create(LOCAL);
  const [serverConn, clientConn] = await Promise.all([
    server.accept(),
    client.connect(server.addr()),
  ]);
  return { server, client, serverConn, clientConn };
}

const shutdown = (...endpoints) => Promise.all(endpoints.map((e) => e.close()));

test("create + nodeId: distinct 64-hex ids", async () => {
  const a = await PeerkitEndpoint.create(LOCAL);
  const b = await PeerkitEndpoint.create(LOCAL);
  assert.match(a.nodeId(), /^[0-9a-f]{64}$/);
  assert.match(b.nodeId(), /^[0-9a-f]{64}$/);
  assert.notEqual(a.nodeId(), b.nodeId());
  await shutdown(a, b);
});

test("addr: parseable JSON carrying own id + direct addrs (offline)", async () => {
  const ep = await PeerkitEndpoint.create(LOCAL);
  const addr = JSON.parse(ep.addr());
  assert.equal(addr.id, ep.nodeId());
  // Offline endpoint must still advertise at least one direct IP address.
  assert.ok(
    Array.isArray(addr.addrs) && addr.addrs.length > 0,
    "expected direct addrs",
  );
  await shutdown(ep);
});

test("connect + accept: both sides observe the correct remote id", async () => {
  const { server, client, serverConn, clientConn } = await connectedPair();
  assert.equal(clientConn.remoteId(), server.nodeId());
  assert.equal(serverConn.remoteId(), client.nodeId());
  await shutdown(server, client);
});

test("openBi/acceptBi + write/finishWrite/readToEnd: framed round-trip", async () => {
  const { server, client, serverConn, clientConn } = await connectedPair();
  const payload = Buffer.from("hello peerkit over iroh");

  const clientSide = (async () => {
    const s = await clientConn.openBi();
    await s.write(frame(payload));
    await s.finishWrite();
    return s.readToEnd(MAX); // wait for the echo
  })();
  const serverSide = (async () => {
    const r = await serverConn.acceptBi();
    const msg = await r.readToEnd(MAX);
    await r.write(msg); // echo back on the same bi-stream
    await r.finishWrite();
  })();

  const [echoed] = await Promise.all([clientSide, serverSide]);
  assert.equal(Buffer.compare(unframe(echoed), payload), 0);
  await shutdown(server, client);
});

test("read(): chunked reads reassemble, then null at end of stream", async () => {
  const { server, client, serverConn, clientConn } = await connectedPair();
  const parts = [
    Buffer.from("alpha"),
    Buffer.from("beta"),
    Buffer.from("gamma"),
  ];
  const whole = Buffer.concat(parts);

  const clientSide = (async () => {
    const s = await clientConn.openBi();
    for (const p of parts) await s.write(p);
    await s.finishWrite();
  })();
  const serverSide = (async () => {
    const r = await serverConn.acceptBi();
    const chunks = [];
    for (;;) {
      const c = await r.read();
      if (c === null) break; // EOF
      chunks.push(c);
    }
    return Buffer.concat(chunks);
  })();

  const [, got] = await Promise.all([clientSide, serverSide]);
  assert.equal(Buffer.compare(got, whole), 0);
  await shutdown(server, client);
});

test("multiple independent bi-streams over one connection", async () => {
  const { server, client, serverConn, clientConn } = await connectedPair();

  // Server echoes the next two inbound streams concurrently.
  const serverSide = Promise.all(
    [0, 1].map(async () => {
      const r = await serverConn.acceptBi();
      const msg = await r.readToEnd(MAX);
      await r.write(msg);
      await r.finishWrite();
    }),
  );
  const one = (async () => {
    const s = await clientConn.openBi();
    await s.write(frame(Buffer.from("stream-one")));
    await s.finishWrite();
    return unframe(await s.readToEnd(MAX)).toString();
  })();
  const two = (async () => {
    const s = await clientConn.openBi();
    await s.write(frame(Buffer.from("stream-two")));
    await s.finishWrite();
    return unframe(await s.readToEnd(MAX)).toString();
  })();

  const [, r1, r2] = await Promise.all([serverSide, one, two]);
  assert.deepEqual(new Set([r1, r2]), new Set(["stream-one", "stream-two"]));
  await shutdown(server, client);
});

test("isDirect + pathSummary: offline connection is a direct IP path", async () => {
  const { server, client, clientConn } = await connectedPair();
  assert.equal(clientConn.isDirect(), true);
  assert.match(clientConn.pathSummary(), /ip\*/);
  await shutdown(server, client);
});

test("conn.close(): pending acceptBi rejects once the peer closes", async () => {
  const { server, client, serverConn, clientConn } = await connectedPair();
  const accepting = serverConn.acceptBi(); // no inbound stream will ever arrive
  clientConn.close();
  await assert.rejects(accepting);
  await shutdown(server, client);
});
