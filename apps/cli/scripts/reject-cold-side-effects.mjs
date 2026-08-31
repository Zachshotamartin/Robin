function sideEffectError(operation) {
  return Object.assign(
    new Error(`cold path attempted side effect: ${operation}`),
    { code: "robin_cold_path_side_effect" },
  );
}

if (typeof process.getBuiltinModule === "function") {
  Object.defineProperty(process, "getBuiltinModule", {
    configurable: true,
    enumerable: false,
    writable: true,
    value(specifier) {
      throw sideEffectError(`process.getBuiltinModule(${specifier})`);
    },
  });
}

for (const name of [
  "binding",
  "_debugProcess",
  "_kill",
  "_linkedBinding",
  "abort",
  "chdir",
  "dlopen",
  "execve",
  "initgroups",
  "kill",
  "setegid",
  "seteuid",
  "setgid",
  "setgroups",
  "setuid",
  "umask",
]) {
  if (typeof process[name] !== "function") continue;
  Object.defineProperty(process, name, {
    configurable: true,
    enumerable: false,
    writable: true,
    value(...args) {
      throw sideEffectError(
        `process.${name}(${typeof args[0] === "string" ? args[0] : "..."})`,
      );
    },
  });
}

if (typeof process.report?.writeReport === "function") {
  Object.defineProperty(process.report, "writeReport", {
    configurable: true,
    enumerable: false,
    writable: true,
    value() {
      throw sideEffectError("process.report.writeReport");
    },
  });
}

for (const name of ["fetch", "WebSocket", "EventSource"]) {
  if (!(name in globalThis)) continue;
  Object.defineProperty(globalThis, name, {
    configurable: true,
    enumerable: false,
    writable: true,
    value() {
      throw sideEffectError(`globalThis.${name}`);
    },
  });
}

Object.defineProperty(process.stdin, "setRawMode", {
  configurable: true,
  enumerable: false,
  writable: true,
  value() {
    throw sideEffectError("process.stdin.setRawMode");
  },
});

if (typeof process.loadEnvFile === "function") {
  Object.defineProperty(process, "loadEnvFile", {
    configurable: true,
    enumerable: false,
    writable: true,
    value() {
      throw sideEffectError("process.loadEnvFile");
    },
  });
}
