/**
 * The peerkit network access handshake, independent of any transport.
 *
 * The choreography is the same on every substrate: the initiator presents its
 * access bytes, the responder evaluates them and replies with its own if it
 * grants access, then waits for an ack confirming the initiator granted access
 * too. Both sides granting means access; either side denying returns false and
 * the caller closes the whole connection.
 *
 * Only the raw byte send/receive differs per transport, so it is supplied as a
 * {@link HandshakeChannel}. Everything above that lives here.
 */

/** The byte channel the handshake runs over, backed by a transport stream. */
export interface HandshakeChannel {
  /** Send one message to the peer. */
  send(bytes: Uint8Array): Promise<void>;
  /** Receive the next message, or null once the peer stops sending or closes. */
  receive(): Promise<Uint8Array | null>;
  /** Close our end of the stream. */
  closeStream(): Promise<void>;
}

/** What each side needs to run its half of the handshake. */
export interface HandshakeParams {
  /** Our own access bytes to present to the peer. */
  localAccessBytes: Uint8Array;
  /** Decide whether the peer's access bytes grant access. */
  evaluate: (peerAccessBytes: Uint8Array) => Promise<boolean>;
  /** How long to wait for each response from the peer, in milliseconds. */
  timeoutMs: number;
}

// One byte a side sends to confirm it granted access, so a grant is never
// confused with a plain stream close.
const ACK_BYTE = 1;

function isAck(bytes: Uint8Array): boolean {
  return bytes.length === 1 && bytes[0] === ACK_BYTE;
}

// Receive the next message, rejecting if it does not arrive in time. A peer that
// closes resolves to null, which the handshake treats as a denial.
function receiveWithTimeout(
  channel: HandshakeChannel,
  timeoutMs: number,
): Promise<Uint8Array | null> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("Access handshake timed out"));
    }, timeoutMs);
    channel.receive().then(
      (message) => {
        clearTimeout(timer);
        resolve(message);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * Run the initiator side: present our bytes, evaluate the peer's, and confirm
 * with an ack if we grant access. Returns whether both sides granted. On our own
 * denial it returns false without acking, leaving the caller to close the
 * connection.
 */
export async function runInitiatorHandshake(
  channel: HandshakeChannel,
  params: HandshakeParams,
): Promise<boolean> {
  await channel.send(params.localAccessBytes);
  const response = await receiveWithTimeout(channel, params.timeoutMs);
  if (response === null) return false; // peer denied and closed
  if (!(await params.evaluate(response))) return false;

  await channel.send(Uint8Array.of(ACK_BYTE));
  await channel.closeStream();
  return true;
}

/**
 * Run the responder side: evaluate the peer's bytes, present ours if we grant
 * access, then wait for the peer's ack confirming it granted access too. Returns
 * whether both sides granted.
 */
export async function runResponderHandshake(
  channel: HandshakeChannel,
  params: HandshakeParams,
): Promise<boolean> {
  const request = await receiveWithTimeout(channel, params.timeoutMs);
  if (request === null) return false;
  if (!(await params.evaluate(request))) return false;

  await channel.send(params.localAccessBytes);
  const ack = await receiveWithTimeout(channel, params.timeoutMs);
  if (ack === null || !isAck(ack)) return false;

  await channel.closeStream();
  return true;
}
