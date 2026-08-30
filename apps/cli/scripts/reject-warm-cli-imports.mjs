const allowedColdBuiltins = new Set(["node:util/types"]);
const allowedColdCliModules = new Set([
  "argv",
  "bin",
  "exit-codes",
  "generated-build-metadata",
  "main",
]);
const coldCliRoots = [
  new URL("../dist/", import.meta.url).href,
  new URL("../src/", import.meta.url).href,
];
const allowedSupportUrls = new Set([
  new URL("./reject-cold-side-effects.mjs", import.meta.url).href,
]);

export async function resolve(specifier, context, nextResolve) {
  if (
    (specifier.startsWith("node:") && !allowedColdBuiltins.has(specifier)) ||
    isBarePackageSpecifier(specifier)
  ) {
    throw warmImportError(specifier);
  }

  const resolved = await nextResolve(specifier, context);
  const localCliModule = localCliModuleName(resolved.url);
  if (
    resolved.url.includes("/node_modules/@guard/") ||
    (localCliModule !== undefined && !allowedColdCliModules.has(localCliModule)) ||
    (resolved.url.startsWith("file:") &&
      localCliModule === undefined &&
      !allowedSupportUrls.has(resolved.url))
  ) {
    throw warmImportError(resolved.url);
  }
  return resolved;
}

function isBarePackageSpecifier(specifier) {
  return (
    !specifier.startsWith(".") &&
    !specifier.startsWith("/") &&
    !specifier.startsWith("file:") &&
    !specifier.startsWith("node:")
  );
}

function localCliModuleName(url) {
  for (const root of coldCliRoots) {
    if (!url.startsWith(root)) continue;
    const relativePath = url.slice(root.length);
    return relativePath.match(/^([^/]+)\.(?:js|ts)$/u)?.[1] ?? relativePath;
  }
  return undefined;
}

function warmImportError(specifier) {
  return Object.assign(
    new Error(`cold path resolved warm module: ${specifier}`),
    { code: "robin_cold_path_warm_import" },
  );
}
