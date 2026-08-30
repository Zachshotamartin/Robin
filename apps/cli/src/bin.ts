#!/usr/bin/env node

import { runCli } from "./main.js";

let brokenOutputPipe = false;

function handleOutputError(error: NodeJS.ErrnoException): void {
  if (error.code === "EPIPE") {
    brokenOutputPipe = true;
    process.exitCode = 0;
    return;
  }
  throw error;
}

process.stdout.on("error", handleOutputError);
process.stderr.on("error", handleOutputError);

const cliExitCode = await runCli(
  process.argv.slice(2),
  process.stdout,
  process.stderr,
);
if (!brokenOutputPipe) process.exitCode = cliExitCode;
