import { getLogger } from "@logtape/logtape";
import type { ITransport, NodeAddress } from "@peerkit/api";
import {
  type IrohTransportOptions,
  TransportIroh,
} from "@peerkit/transport-iroh-core";
import { NativeDriver, type NativeDriverOptions } from "./driver.js";

/** Options for {@link createNode}. */
export interface CreateNodeOptions
  extends IrohTransportOptions, NativeDriverOptions {
  /**
   * Peer addresses to dial at startup.
   *
   * Named for parity with the peerkit transport factory. There is no iroh relay
   * tier yet, so these are dialed as direct peers rather than relays.
   */
  bootstrapRelays?: NodeAddress[];
}

/**
 * Build a Node.js peerkit transport node over iroh.
 *
 * Creates a native iroh endpoint and wraps it with {@link TransportIroh}, which
 * handles the access, agents and message protocols.
 */
export async function createNode(
  options: CreateNodeOptions,
): Promise<ITransport> {
  const driver = await NativeDriver.create({ relay: options.relay });
  const transport = new TransportIroh(driver, options);

  // Dial bootstrap peers in the background; the transport logs dial failures.
  for (const address of options.bootstrapRelays ?? []) {
    void transport.connect([address]).catch((error) => {
      getLogger(["peerkit", "transport"]).warn(
        "Failed to dial bootstrap peer {*}",
        { address, error },
      );
    });
  }

  return transport;
}
