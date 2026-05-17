import { expect, test, vi } from "vitest";
import type { AgentId } from "@peerkit/api";
import type { PeerkitNode } from "@peerkit/peerkit";
import { createTextMessageHandler, sendTextMessage } from "../src/messaging.js";

test("sendTextMessage encodes text as UTF-8 and calls node.send", async () => {
  const send = vi.fn().mockResolvedValue(undefined);
  const node = { send } as unknown as PeerkitNode;

  const toAgent: AgentId = "agent-abc";
  await sendTextMessage(node, toAgent, "hello world");
  expect(send).toHaveBeenCalledWith(
    toAgent,
    new TextEncoder().encode("hello world"),
  );

  await sendTextMessage(node, toAgent, "こんにちは 🌍");
  expect(send).toHaveBeenCalledWith(
    toAgent,
    new TextEncoder().encode("こんにちは 🌍"),
  );
});

test("createTextMessageHandler decodes bytes and calls onMessage", async () => {
  const onMessage = vi.fn();
  const handler = createTextMessageHandler(onMessage);

  const fromAgent: AgentId = "agent-xyz";
  await handler(fromAgent, new TextEncoder().encode("hello world"));
  expect(onMessage).toHaveBeenCalledWith(fromAgent, "hello world");

  await handler(fromAgent, new TextEncoder().encode("こんにちは 🌍"));
  expect(onMessage).toHaveBeenCalledWith(fromAgent, "こんにちは 🌍");
});
