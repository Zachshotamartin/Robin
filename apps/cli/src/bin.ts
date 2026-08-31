#!/usr/bin/env node

import { EXIT_CODES, runCli } from "./main.js";

let brokenOutputPipe = false;
let outputFailed = false;
const outputFailure = new AbortController();

function handleOutputError(error: NodeJS.ErrnoException): void {
  if (!outputFailure.signal.aborted) outputFailure.abort(error);
  if (error.code === "EPIPE") {
    brokenOutputPipe = true;
    process.exitCode = 0;
    return;
  }
  outputFailed = true;
  process.exitCode = EXIT_CODES.infrastructureFailed;
}

process.stdout.on("error", handleOutputError);
process.stderr.on("error", handleOutputError);

const cliExitCode = await runCli(
  process.argv.slice(2),
  process.stdout,
  process.stderr,
  undefined,
  { outputFailureSignal: outputFailure.signal },
);
if (!brokenOutputPipe) {
  process.exitCode = outputFailed
    ? EXIT_CODES.infrastructureFailed
    : cliExitCode;
}
