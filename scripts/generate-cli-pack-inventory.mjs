#!/usr/bin/env node

import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

const execFile = promisify(execFileCallback);
const REPOSITORY_ROOT = resolve(
  fileURLToPath(new URL("../", import.meta.url)),
);
const MAXIMUM_ARCHIVE_BYTES = 16 * 1024 * 1024;
const MAXIMUM_UNPACKED_BYTES = 64 * 1024 * 1024;
const MAXIMUM_FILE_BYTES = 8 * 1024 * 1024;

const options = parseArguments(process.argv.slice(2));
const temporaryDirectory = await mkdtemp(
  join(tmpdir(), "robin-pack-inventory-"),
);

try {
  const pack = await createPackageArchive(temporaryDirectory, options.npm);
  const archivePath = join(temporaryDirectory, pack.filename);
  const archive = await readBoundedFile(
    archivePath,
    MAXIMUM_ARCHIVE_BYTES,
    "package archive",
  );
  if (archive.length !== pack.size) {
    throw new Error(
      `npm reported ${pack.size} archive bytes but wrote ${archive.length}`,
    );
  }
  const tar = gunzipSync(archive, {
    maxOutputLength: MAXIMUM_UNPACKED_BYTES,
  });
  const files = parseTar(tar);
  assertPackListing(pack.files, files);
  const profile = Object.freeze({
    id: profileId(process.platform, process.arch, pack.npmVersion),
    platform: process.platform,
    arch: process.arch,
    npmVersion: pack.npmVersion,
    bytes: archive.length,
    sha256: sha256(archive),
  });
  const inventory = {
    schemaVersion: 1,
    packageName: pack.name,
    archive: {
      filename: pack.filename,
      tar: {
        bytes: tar.length,
        sha256: sha256(tar),
      },
      compressionProfiles: await mergedProfiles(
        options.mergeProfileFrom,
        pack,
        tar,
        files,
        profile,
      ),
    },
    files,
  };
  const serialized = `${JSON.stringify(inventory, null, 2)}\n`;
  if (options.output === null) {
    process.stdout.write(serialized);
  } else {
    await writeFile(options.output, serialized, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o644,
    });
  }
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}

function parseArguments(argv) {
  let npm = process.env.ROBIN_NPM_EXECUTABLE ?? "npm";
  let mergeProfileFrom = null;
  let output = null;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--npm") {
      npm = requiredValue(argv, ++index, "--npm");
      continue;
    }
    if (argument === "--merge-profile-from") {
      mergeProfileFrom = resolve(
        REPOSITORY_ROOT,
        requiredValue(argv, ++index, "--merge-profile-from"),
      );
      continue;
    }
    if (argument === "--output") {
      output = resolve(
        REPOSITORY_ROOT,
        requiredValue(argv, ++index, "--output"),
      );
      continue;
    }
    if (argument === "--help") {
      process.stdout.write(
        "Usage: node scripts/generate-cli-pack-inventory.mjs " +
          "[--npm executable] [--merge-profile-from inventory.json] " +
          "[--output inventory.json]\n",
      );
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${argument}`);
  }
  return Object.freeze({ npm, mergeProfileFrom, output });
}

function requiredValue(argv, index, flag) {
  const value = argv[index];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

async function createPackageArchive(destination, npmExecutable) {
  const environment = {
    ...process.env,
    NPM_CONFIG_AUDIT: "false",
    NPM_CONFIG_CACHE: join(destination, "npm-cache"),
    NPM_CONFIG_FUND: "false",
    NPM_CONFIG_UPDATE_NOTIFIER: "false",
    NPM_CONFIG_USERCONFIG: join(destination, "empty-npmrc"),
  };
  delete environment.npm_config_python;
  const versionResult = await execFile(npmExecutable, ["--version"], {
    cwd: REPOSITORY_ROOT,
    env: environment,
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  });
  const npmVersion = versionResult.stdout.trim();
  if (!/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)/u.test(npmVersion)) {
    throw new Error(`npm returned an invalid version: ${npmVersion}`);
  }
  const { stdout, stderr } = await execFile(
    npmExecutable,
    [
      "pack",
      "--workspace",
      "@zachshotamartin/robin",
      "--json",
      "--pack-destination",
      destination,
    ],
    {
      cwd: REPOSITORY_ROOT,
      env: environment,
      encoding: "utf8",
      timeout: 120_000,
      maxBuffer: 8 * 1024 * 1024,
    },
  );
  const unexpectedDiagnostics = stderr
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("npm warn "));
  if (unexpectedDiagnostics.length !== 0) {
    throw new Error(
      `npm pack wrote unexpected stderr: ${unexpectedDiagnostics.join("\n")}`,
    );
  }
  const decoded = JSON.parse(stdout);
  if (!Array.isArray(decoded) || decoded.length !== 1) {
    throw new Error("npm pack must return exactly one package result");
  }
  const result = decoded[0];
  if (
    result === null ||
    typeof result !== "object" ||
    typeof result.filename !== "string" ||
    typeof result.name !== "string" ||
    !Number.isSafeInteger(result.size) ||
    !Array.isArray(result.files)
  ) {
    throw new Error("npm pack returned an invalid result object");
  }
  return Object.freeze({ ...result, npmVersion });
}

async function readBoundedFile(path, maximumBytes, label) {
  const contents = await readFile(path);
  if (contents.length > maximumBytes) {
    throw new Error(`${label} exceeds ${maximumBytes} bytes`);
  }
  return contents;
}

function parseTar(tar) {
  if (tar.length > MAXIMUM_UNPACKED_BYTES) {
    throw new Error("uncompressed tar exceeds the inventory bound");
  }
  const entries = [];
  const paths = new Set();
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      if (!tar.subarray(offset).every((byte) => byte === 0)) {
        throw new Error("tar contains nonzero bytes after its end marker");
      }
      return entries.sort(comparePaths);
    }
    assertTarChecksum(header);
    const name = readTarText(header.subarray(0, 100));
    const prefix = readTarText(header.subarray(345, 500));
    const archivePath = prefix.length === 0 ? name : `${prefix}/${name}`;
    if (!archivePath.startsWith("package/")) {
      throw new Error(`tar path is outside package/: ${archivePath}`);
    }
    const path = archivePath.slice("package/".length);
    if (path.length === 0 || path.includes("..") || paths.has(path)) {
      throw new Error(`tar has an unsafe or duplicate path: ${path}`);
    }
    paths.add(path);
    const typeFlag = header[156];
    if (typeFlag !== 0 && typeFlag !== 0x30) {
      throw new Error(`tar entry is not a regular file: ${path}`);
    }
    const rawMode = parseTarOctal(header.subarray(100, 108), `${path} mode`);
    const mode = rawMode & 0o777;
    if (mode !== 0o644 && mode !== 0o755) {
      throw new Error(`tar entry has an unreviewed mode: ${path} ${mode}`);
    }
    const bytes = parseTarOctal(header.subarray(124, 136), `${path} size`);
    if (bytes > MAXIMUM_FILE_BYTES) {
      throw new Error(`tar entry exceeds ${MAXIMUM_FILE_BYTES} bytes: ${path}`);
    }
    const contentStart = offset + 512;
    const contentEnd = contentStart + bytes;
    if (contentEnd > tar.length) {
      throw new Error(`tar entry extends beyond the archive: ${path}`);
    }
    entries.push({
      path,
      type: "file",
      mode: mode.toString(8).padStart(4, "0"),
      bytes,
      sha256: sha256(tar.subarray(contentStart, contentEnd)),
    });
    offset = contentStart + Math.ceil(bytes / 512) * 512;
  }
  throw new Error("tar archive has no complete end marker");
}

function assertTarChecksum(header) {
  const expected = parseTarOctal(header.subarray(148, 156), "tar checksum");
  let actual = 0;
  for (let index = 0; index < header.length; index += 1) {
    actual += index >= 148 && index < 156 ? 0x20 : header[index];
  }
  if (actual !== expected) {
    throw new Error(`tar checksum mismatch: expected ${expected}, got ${actual}`);
  }
}

function readTarText(field) {
  const nul = field.indexOf(0);
  return field.subarray(0, nul === -1 ? field.length : nul).toString("utf8");
}

function parseTarOctal(field, location) {
  const text = readTarText(field).trim();
  if (!/^[0-7]+$/u.test(text)) {
    throw new Error(`${location} is not a bounded octal value`);
  }
  const value = Number.parseInt(text, 8);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${location} is out of range`);
  }
  return value;
}

function assertPackListing(listing, files) {
  const actual = listing
    .map((file) => ({
      path: file.path,
      mode: Number(file.mode).toString(8).padStart(4, "0"),
      bytes: file.size,
    }))
    .sort(comparePaths);
  const expected = files.map(({ path, mode, bytes }) => ({
    path,
    mode,
    bytes,
  }));
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error("npm file listing differs from the parsed tar inventory");
  }
}

async function mergedProfiles(
  existingPath,
  pack,
  tar,
  files,
  currentProfile,
) {
  const profiles = [];
  if (existingPath !== null) {
    const existing = JSON.parse(await readFile(existingPath, "utf8"));
    if (
      existing.schemaVersion !== 1 ||
      existing.packageName !== pack.name ||
      existing.archive?.filename !== pack.filename ||
      existing.archive?.tar?.bytes !== tar.length ||
      existing.archive?.tar?.sha256 !== sha256(tar) ||
      JSON.stringify(existing.files) !== JSON.stringify(files) ||
      !Array.isArray(existing.archive?.compressionProfiles)
    ) {
      throw new Error(
        "the merge inventory describes different package content",
      );
    }
    profiles.push(...existing.archive.compressionProfiles);
  }
  const cell = profileCell(currentProfile);
  const merged = profiles.filter((profile) => profileCell(profile) !== cell);
  merged.push(currentProfile);
  return merged.sort((left, right) =>
    profileCell(left).localeCompare(profileCell(right), "en"),
  );
}

function profileCell(profile) {
  return `${profile.platform}/${profile.arch}/npm-${profile.npmVersion}`;
}

function profileId(platform, arch, npmVersion) {
  return `${platform}-${arch}-npm-${npmVersion.replaceAll(".", "-")}-gzip-v1`
    .toLowerCase()
    .replaceAll(/[^a-z0-9-]/gu, "-");
}

function comparePaths(left, right) {
  return left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
