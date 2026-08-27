import type { AuthoredDataSync } from "@peerkit/authored-data-pull";
import type { MemoryBlobStore } from "@peerkit/data-store";
import type { NodeSession } from "@peerkit/peer-session";
import { EventEmitter } from "node:events";
import type * as readline from "node:readline";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runNodeCommands } from "../src/commands.js";

const waitForOutput = async (lines: string[]): Promise<void> => {
  await vi.waitFor(() => {
    expect(lines).not.toEqual([]);
  });
};

describe("runNodeCommands send", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("prints success only after sendText resolves", async () => {
    let resolveSend: () => void = () => {};
    const sendComplete = new Promise<void>((resolve) => {
      resolveSend = resolve;
    });
    const session = {
      sendText: (): Promise<void> => sendComplete,
    } as unknown as NodeSession;
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line: unknown): void => {
      lines.push(String(line));
    });
    const rl = Object.assign(new EventEmitter(), {
      prompt: (): void => {},
    }) as unknown as readline.Interface;

    runNodeCommands(
      rl,
      session,
      {} as AuthoredDataSync,
      {} as MemoryBlobStore,
      async (): Promise<void> => {},
    );

    rl.emit("line", "send 1 private message");

    expect(lines).toEqual([]);

    resolveSend();
    await waitForOutput(lines);

    expect(lines).toEqual(["Sent to 1"]);
  });

  it("prints only the failure line when sendText rejects", async () => {
    const session = {
      sendText: (): Promise<void> => Promise.reject(new Error("no route")),
    } as unknown as NodeSession;
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line: unknown): void => {
      lines.push(String(line));
    });
    const rl = Object.assign(new EventEmitter(), {
      prompt: (): void => {},
    }) as unknown as readline.Interface;

    runNodeCommands(
      rl,
      session,
      {} as AuthoredDataSync,
      {} as MemoryBlobStore,
      async (): Promise<void> => {},
    );

    rl.emit("line", "send 1 private message");

    await waitForOutput(lines);

    expect(lines).toEqual(["Send failed: Error: no route"]);
  });
});
