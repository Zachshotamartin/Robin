import { chmod } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const compiledBin = fileURLToPath(new URL("../dist/bin.js", import.meta.url));

await chmod(compiledBin, 0o755);
