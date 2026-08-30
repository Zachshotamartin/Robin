import { mkdirSync, writeFileSync } from "node:fs";

import { canonicalize } from "@guard/contracts";

import { runCodingSafeScenario, runGenericSafeScenario } from "./safe-scenarios.js";

const fixtureDirectory = new URL("../fixtures/", import.meta.url);
mkdirSync(fixtureDirectory, { recursive: true });

const [generic, coding] = await Promise.all([
  runGenericSafeScenario(),
  runCodingSafeScenario(),
]);
const decoder = new TextDecoder("utf8", { fatal: true });

writeGolden("generic-safe.history.json", generic.execution.history);
writeGolden(
  "generic-safe.provider-requests.json",
  generic.transcript.capturedRequestBytes.map((bytes) => decoder.decode(bytes)),
);
writeGolden("coding-safe.history.json", coding.execution.history);
writeGolden(
  "coding-safe.provider-requests.json",
  coding.transcript.capturedRequestBytes.map((bytes) => decoder.decode(bytes)),
);

function writeGolden(filename: string, value: unknown): void {
  writeFileSync(
    new URL(filename, fixtureDirectory),
    `${canonicalize(value)}\n`,
    "utf8",
  );
}
