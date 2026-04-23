import {
  decodeMessage,
  encodeMessage,
  message,
  streamMessage,
} from "protons-runtime";
import { alloc as uint8ArrayAlloc } from "uint8arrays/alloc";
import type { Codec, DecodeOptions } from "protons-runtime";
import type { Uint8ArrayList } from "uint8arraylist";

export interface NetworkAccessHandshake {
  agentId: Uint8Array;
  networkAccessBytes: Uint8Array;
}

export namespace NetworkAccessHandshake {
  let _codec: Codec<NetworkAccessHandshake>;

  export const codec = (): Codec<NetworkAccessHandshake> => {
    if (_codec == null) {
      _codec = message<NetworkAccessHandshake>(
        (obj, w, opts = {}) => {
          if (opts.lengthDelimited !== false) {
            w.fork();
          }

          if (obj.agentId != null && obj.agentId.byteLength > 0) {
            w.uint32(10);
            w.bytes(obj.agentId);
          }

          if (
            obj.networkAccessBytes != null &&
            obj.networkAccessBytes.byteLength > 0
          ) {
            w.uint32(18);
            w.bytes(obj.networkAccessBytes);
          }

          if (opts.lengthDelimited !== false) {
            w.ldelim();
          }
        },
        (reader, length, opts = {}) => {
          const obj: any = {
            agentId: uint8ArrayAlloc(0),
            networkAccessBytes: uint8ArrayAlloc(0),
          };

          const end = length == null ? reader.len : reader.pos + length;

          while (reader.pos < end) {
            const tag = reader.uint32();

            switch (tag >>> 3) {
              case 1: {
                obj.agentId = reader.bytes();
                break;
              }
              case 2: {
                obj.networkAccessBytes = reader.bytes();
                break;
              }
              default: {
                reader.skipType(tag & 7);
                break;
              }
            }
          }

          return obj;
        },
        function* (reader, length, prefix, opts = {}) {
          const end = length == null ? reader.len : reader.pos + length;

          while (reader.pos < end) {
            const tag = reader.uint32();

            switch (tag >>> 3) {
              case 1: {
                yield {
                  field: `${prefix}.agentId`,
                  value: reader.bytes(),
                };
                break;
              }
              case 2: {
                yield {
                  field: `${prefix}.networkAccessBytes`,
                  value: reader.bytes(),
                };
                break;
              }
              default: {
                reader.skipType(tag & 7);
                break;
              }
            }
          }
        },
      );
    }

    return _codec;
  };

  export interface NetworkAccessHandshakeAgentIdFieldEvent {
    field: "$.agentId";
    value: Uint8Array;
  }

  export interface NetworkAccessHandshakeNetworkAccessBytesFieldEvent {
    field: "$.networkAccessBytes";
    value: Uint8Array;
  }

  export function encode(obj: Partial<NetworkAccessHandshake>): Uint8Array {
    return encodeMessage(obj, NetworkAccessHandshake.codec());
  }

  export function decode(
    buf: Uint8Array | Uint8ArrayList,
    opts?: DecodeOptions<NetworkAccessHandshake>,
  ): NetworkAccessHandshake {
    return decodeMessage(buf, NetworkAccessHandshake.codec(), opts);
  }

  export function stream(
    buf: Uint8Array | Uint8ArrayList,
    opts?: DecodeOptions<NetworkAccessHandshake>,
  ): Generator<
    | NetworkAccessHandshakeAgentIdFieldEvent
    | NetworkAccessHandshakeNetworkAccessBytesFieldEvent
  > {
    return streamMessage(buf, NetworkAccessHandshake.codec(), opts);
  }
}
