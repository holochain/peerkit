import type { ITransport } from "@peerkit/api";
import {
  type IrohTransportOptions,
  TransportIroh,
} from "@peerkit/transport-iroh-core";
import { NativeDriver, type NativeDriverOptions } from "./driver.js";

/** Options for {@link createNode}. */
export interface CreateNodeOptions
  extends IrohTransportOptions, NativeDriverOptions {}

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
  return new TransportIroh(driver, options);
}
