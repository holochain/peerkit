#!/usr/bin/env node
import { Command } from "commander";
import { addNodeCommand } from "./node.js";
import { addRelayCommand } from "./relay.js";

const program = new Command();
program.name("peerkit").description(
  "Developer CLI for peerkit\n\n\
Set peerkit log level with env var PEERKIT_LOG.\n\
Available log levels are trace, debug, info, warning, error, fatal.\n\
Default: PEERKIT_LOG=warning",
);

addRelayCommand(program);
addNodeCommand(program);

await program.parseAsync();
