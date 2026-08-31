#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

const fixturePath = fileURLToPath(import.meta.url);
const [mode, ...args] = process.argv.slice(2);

function fail(message, exitCode = 64) {
  process.stderr.write(`${message}\n`);
  process.exit(exitCode);
}

function parseInteger(value, name, minimum, maximum) {
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value ?? "")) {
    fail(`${name} must be a base-10 integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    fail(`${name} must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function writeJson(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

async function writeAll(stream, bytes) {
  if (!stream.write(bytes)) {
    await once(stream, "drain");
  }
}

function keepAlive() {
  setInterval(() => undefined, 60_000);
  process.stdin.resume();
}

async function readStdin() {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > 16 * 1024 * 1024) {
      fail("stdin exceeds fixture limit", 65);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function runSignalMode(behavior) {
  if (behavior !== "graceful" && behavior !== "ignore") {
    fail("signal behavior must be graceful or ignore");
  }
  process.on("SIGTERM", () => {
    if (behavior === "graceful") {
      process.stderr.write("signal:SIGTERM\n", () => process.exit(143));
    } else {
      process.stderr.write("ignored:SIGTERM\n");
    }
  });
  process.on("SIGINT", () => {
    if (behavior === "graceful") {
      process.stderr.write("signal:SIGINT\n", () => process.exit(130));
    } else {
      process.stderr.write("ignored:SIGINT\n");
    }
  });
  writeJson({ behavior, pid: process.pid, ready: true });
  keepAlive();
}

async function runTreeMode(depth, behavior, detachLeaf) {
  let child = null;
  if (depth > 0) {
    child = spawn(
      process.execPath,
      [fixturePath, "tree", String(depth - 1), behavior, detachLeaf ? "detach-leaf" : "joined"],
      {
        detached: detachLeaf && depth === 1,
        shell: false,
        stdio: ["ignore", "inherit", "inherit"],
      },
    );
    child.once("error", (error) => fail(`tree child spawn failed: ${error.message}`, 70));
  }
  process.on("SIGTERM", () => {
    if (behavior === "ignore") {
      process.stderr.write(`ignored:SIGTERM:${process.pid}\n`);
      return;
    }
    if (child !== null && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
    }
    process.stderr.write(`signal:SIGTERM:${process.pid}\n`, () => process.exit(143));
  });
  writeJson({
    behavior,
    childPid: child?.pid ?? null,
    depth,
    detachedLeaf: detachLeaf && depth === 0,
    pid: process.pid,
    ready: true,
  });
  keepAlive();
}

switch (mode) {
  case "argv":
    writeJson(args);
    break;
  case "streams": {
    const count = parseInteger(args[0], "count", 0, 100_000);
    for (let index = 0; index < count; index += 1) {
      await writeAll(process.stdout, Buffer.from(`stdout:${index}\n`));
      await writeAll(process.stderr, Buffer.from(`stderr:${index}\n`));
    }
    break;
  }
  case "binary":
    await writeAll(process.stdout, Buffer.from([0, 1, 2, 127, 128, 254, 255]));
    break;
  case "partial-line":
    await writeAll(process.stdout, Buffer.from(args[0] ?? "partial"));
    break;
  case "cwd":
    writeJson(process.cwd());
    break;
  case "environment": {
    const selected = {};
    for (const key of [...args].sort()) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key)) {
        fail("environment key is invalid");
      }
      selected[key] = Object.hasOwn(process.env, key) ? process.env[key] : null;
    }
    writeJson(selected);
    break;
  }
  case "stdin-echo":
    await writeAll(process.stdout, await readStdin());
    break;
  case "stdin-sha256": {
    const input = await readStdin();
    writeJson({
      bytes: input.length,
      sha256: createHash("sha256").update(input).digest("hex"),
    });
    break;
  }
  case "tty":
    writeJson({
      stderr: process.stderr.isTTY === true,
      stdin: process.stdin.isTTY === true,
      stdout: process.stdout.isTTY === true,
    });
    break;
  case "flood": {
    const totalBytes = parseInteger(args[0], "totalBytes", 0, 64 * 1024 * 1024);
    const chunkBytes = parseInteger(args[1], "chunkBytes", 1, 1024 * 1024);
    const chunk = Buffer.alloc(chunkBytes, 0x78);
    let written = 0;
    while (written < totalBytes) {
      const remaining = totalBytes - written;
      await writeAll(
        process.stdout,
        remaining >= chunk.length ? chunk : chunk.subarray(0, remaining),
      );
      written += Math.min(remaining, chunk.length);
    }
    break;
  }
  case "delay-exit": {
    const delayMilliseconds = parseInteger(args[0], "delayMilliseconds", 0, 60_000);
    const exitCode = parseInteger(args[1], "exitCode", 0, 255);
    await new Promise((resolve) => setTimeout(resolve, delayMilliseconds));
    process.exit(exitCode);
    break;
  }
  case "exit":
    process.exit(parseInteger(args[0], "exitCode", 0, 255));
    break;
  case "self-signal": {
    const signal = args[0];
    if (signal !== "SIGTERM" && signal !== "SIGINT" && signal !== "SIGKILL") {
      fail("self-signal must be SIGTERM, SIGINT, or SIGKILL");
    }
    process.kill(process.pid, signal);
    break;
  }
  case "signal":
    await runSignalMode(args[0]);
    break;
  case "tree": {
    const depth = parseInteger(args[0], "depth", 0, 8);
    const behavior = args[1];
    if (behavior !== "graceful" && behavior !== "ignore") {
      fail("tree behavior must be graceful or ignore");
    }
    const leafMode = args[2] ?? "joined";
    if (leafMode !== "joined" && leafMode !== "detach-leaf") {
      fail("tree leaf mode must be joined or detach-leaf");
    }
    await runTreeMode(depth, behavior, leafMode === "detach-leaf");
    break;
  }
  case "close-stdio-wait": {
    const delayMilliseconds = parseInteger(args[0], "delayMilliseconds", 0, 60_000);
    process.stdout.end();
    process.stderr.end();
    await new Promise((resolve) => setTimeout(resolve, delayMilliseconds));
    break;
  }
  default:
    fail("unknown process fixture mode");
}
