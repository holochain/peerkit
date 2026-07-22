import { describe, expect, test } from "vitest";
import {
  type HandshakeChannel,
  runInitiatorHandshake,
  runResponderHandshake,
} from "../src/access-handshake.js";

const ACK = Uint8Array.of(1);
const OURS = Uint8Array.of(10);
const THEIRS = Uint8Array.of(20);
const grant = async () => true;
const deny = async () => false;

// A channel that hands back a fixed script of received messages (null = the peer
// closed) and records everything sent, so each side can be driven on its own.
class ScriptedChannel implements HandshakeChannel {
  readonly sent: Uint8Array[] = [];
  closed = false;
  constructor(private incoming: (Uint8Array | null)[]) {}

  async send(bytes: Uint8Array): Promise<void> {
    this.sent.push(bytes);
  }

  async receive(): Promise<Uint8Array | null> {
    return this.incoming.shift() ?? null;
  }

  async closeStream(): Promise<void> {
    this.closed = true;
  }
}

describe("runInitiatorHandshake", () => {
  test("grants: sends our bytes then an ack, closes, returns true", async () => {
    const channel = new ScriptedChannel([THEIRS]);
    const granted = await runInitiatorHandshake(channel, {
      localAccessBytes: OURS,
      evaluate: grant,
      timeoutMs: 1000,
    });
    expect(granted).toBe(true);
    // First our access bytes, then the ack byte.
    expect(channel.sent.map((m) => Array.from(m))).toEqual([[10], [1]]);
    expect(channel.closed).toBe(true);
  });

  test("denies the peer: returns false without acking", async () => {
    const channel = new ScriptedChannel([THEIRS]);
    const granted = await runInitiatorHandshake(channel, {
      localAccessBytes: OURS,
      evaluate: deny,
      timeoutMs: 1000,
    });
    expect(granted).toBe(false);
    expect(channel.sent.map((m) => Array.from(m))).toEqual([[10]]); // no ack
  });

  test("peer closes before responding: returns false", async () => {
    const channel = new ScriptedChannel([null]);
    const granted = await runInitiatorHandshake(channel, {
      localAccessBytes: OURS,
      evaluate: grant,
      timeoutMs: 1000,
    });
    expect(granted).toBe(false);
  });
});

describe("runResponderHandshake", () => {
  test("grants: sends our bytes, accepts the ack, returns true", async () => {
    const channel = new ScriptedChannel([THEIRS, ACK]);
    const granted = await runResponderHandshake(channel, {
      localAccessBytes: OURS,
      evaluate: grant,
      timeoutMs: 1000,
    });
    expect(granted).toBe(true);
    expect(channel.sent.map((m) => Array.from(m))).toEqual([[10]]);
    expect(channel.closed).toBe(true);
  });

  test("denies the peer: returns false without sending our bytes", async () => {
    const channel = new ScriptedChannel([THEIRS]);
    const granted = await runResponderHandshake(channel, {
      localAccessBytes: OURS,
      evaluate: deny,
      timeoutMs: 1000,
    });
    expect(granted).toBe(false);
    expect(channel.sent).toHaveLength(0);
  });

  test("missing or wrong ack: returns false", async () => {
    const channel = new ScriptedChannel([THEIRS, Uint8Array.of(9)]);
    const granted = await runResponderHandshake(channel, {
      localAccessBytes: OURS,
      evaluate: grant,
      timeoutMs: 1000,
    });
    expect(granted).toBe(false);
  });
});

test("times out when a response never arrives", async () => {
  // A channel whose receive never resolves triggers the timeout.
  const channel: HandshakeChannel = {
    send: async () => {},
    receive: () => new Promise<Uint8Array | null>(() => {}),
    closeStream: async () => {},
  };
  await expect(
    runInitiatorHandshake(channel, {
      localAccessBytes: OURS,
      evaluate: grant,
      timeoutMs: 20,
    }),
  ).rejects.toThrow(/timed out/);
});

test("initiator and responder interoperate over a live channel pair", async () => {
  const [initiatorSide, responderSide] = channelPair();
  const [initiatorGranted, responderGranted] = await Promise.all([
    runInitiatorHandshake(initiatorSide, {
      localAccessBytes: OURS,
      evaluate: grant,
      timeoutMs: 1000,
    }),
    runResponderHandshake(responderSide, {
      localAccessBytes: THEIRS,
      evaluate: grant,
      timeoutMs: 1000,
    }),
  ]);
  expect(initiatorGranted).toBe(true);
  expect(responderGranted).toBe(true);
});

// Two channels wired as an in-memory pipe: what one sends the other receives.
function channelPair(): [HandshakeChannel, HandshakeChannel] {
  const a = new PipeEnd();
  const b = new PipeEnd();
  a.peer = b;
  b.peer = a;
  return [a, b];
}

class PipeEnd implements HandshakeChannel {
  peer!: PipeEnd;
  private inbound: Uint8Array[] = [];
  private closed = false;
  private waiters: (() => void)[] = [];

  async send(bytes: Uint8Array): Promise<void> {
    this.peer.deliver(bytes);
  }

  async receive(): Promise<Uint8Array | null> {
    while (this.inbound.length === 0 && !this.closed) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    return this.inbound.shift() ?? null;
  }

  async closeStream(): Promise<void> {
    this.peer.close();
  }

  private deliver(bytes: Uint8Array): void {
    this.inbound.push(bytes);
    this.wake();
  }

  private close(): void {
    this.closed = true;
    this.wake();
  }

  private wake(): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const resolve of waiters) resolve();
  }
}
