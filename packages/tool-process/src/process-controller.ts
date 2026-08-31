import { Buffer } from "node:buffer";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";

import {
  buildProcessEnvironment,
  type ProcessEnvironmentProfile,
  type PreparedProcessEnvironment,
} from "./environment-policy.js";
import {
  resolveExecutable,
  revalidateExecutable,
  type ExecutableResolutionPolicy,
  type ResolvedExecutable,
} from "./executable-resolution.js";
import {
  BoundedOutputMultiplexer,
  type ProcessOutputChunkEvent,
  type ProcessOutputSnapshot,
} from "./output-multiplexer.js";
import { ProcessToolError } from "./process-error.js";
import type { ProcessRequestV1, ProcessStdin } from "./process-schema.js";
import {
  prepareWorkingDirectory,
  revalidateWorkingDirectory,
  type PreparedWorkingDirectory,
} from "./working-directory.js";

export interface ProcessWorkspaceFileReader {
  read(
    path: string,
    maximumBytes: number,
    signal: AbortSignal,
  ): Promise<Uint8Array>;
}

export interface PrepareProcessExecutionInput {
  readonly request: ProcessRequestV1;
  readonly workspaceRoot: string;
  readonly executablePolicy: ExecutableResolutionPolicy;
  readonly environmentProfile: ProcessEnvironmentProfile;
  readonly ambientEnvironment: Readonly<Record<string, string | undefined>>;
  readonly signal: AbortSignal;
  readonly workspaceFileReader?: ProcessWorkspaceFileReader;
}

export interface PreparedProcessStdin {
  readonly kind: ProcessStdin["kind"];
  readonly byteLength: number;
  readonly sha256: string;
  readonly bytesBase64: string;
}

export interface PreparedProcessExecution {
  readonly request: ProcessRequestV1;
  readonly executable: ResolvedExecutable;
  readonly cwd: PreparedWorkingDirectory;
  readonly environment: PreparedProcessEnvironment;
  readonly stdin: PreparedProcessStdin;
  readonly preparedHash: string;
  readonly sandbox: {
    readonly sandboxed: false;
    readonly filesystemIsolation: "none";
    readonly networkIsolation: "none";
  };
}

export type ProcessTerminationRequest =
  | "cancelled"
  | "timeout"
  | "output_limit"
  | "controller_failure";

export type ProcessResultClassification =
  | "success"
  | "nonzero_exit"
  | "signal_exit"
  | "spawn_failed"
  | "cancelled"
  | "timed_out"
  | "output_limit_exceeded"
  | "controller_failed"
  | "termination_incomplete";

export type ProcessLifecycleEvent =
  | {
      readonly type: "prepared";
      readonly preparedHash: string;
      readonly executable: string;
      readonly cwd: string;
      readonly sandboxed: false;
    }
  | {
      readonly type: "started";
      readonly pid: number;
      readonly processGroupId: number | null;
    }
  | {
      readonly type: "leader_exited";
      readonly exitCode: number | null;
      readonly signal: string | null;
    }
  | { readonly type: "output"; readonly chunk: ProcessOutputChunkEvent }
  | {
      readonly type: "termination_requested";
      readonly reason: ProcessTerminationRequest;
      readonly signal: "SIGTERM";
    }
  | {
      readonly type: "termination_escalated";
      readonly reason: ProcessTerminationRequest;
      readonly signal: "SIGKILL";
    }
  | {
      readonly type: "settled";
      readonly classification: ProcessResultClassification;
      readonly durationMs: number;
    };

export interface ProcessTerminationReport {
  readonly requestedReason: ProcessTerminationRequest | null;
  readonly secondaryReasons: readonly ProcessTerminationRequest[];
  readonly gracefulSignalSent: boolean;
  readonly forceSignalSent: boolean;
  readonly groupReaped: boolean;
  readonly supervision: "posix_process_group" | "direct_child_only";
  readonly escapedGroupDetection: "unavailable";
}

export interface ProcessRunResult {
  readonly classification: ProcessResultClassification;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly pid: number | null;
  readonly durationMs: number;
  readonly output: ProcessOutputSnapshot;
  readonly executable: ResolvedExecutable;
  readonly cwd: string;
  readonly preparedHash: string;
  readonly termination: ProcessTerminationReport;
  readonly sandbox: PreparedProcessExecution["sandbox"];
}

export interface ProcessRunContext {
  readonly signal: AbortSignal;
  readonly onEvent?: (event: ProcessLifecycleEvent) => void;
}

export interface ProcessControllerOptions {
  readonly forceWaitMs?: number;
  readonly pollIntervalMs?: number;
}

interface PreparedProvenance {
  readonly revalidateStdin: (signal: AbortSignal) => Promise<boolean>;
}

const PREPARED_PROVENANCE = new WeakMap<
  PreparedProcessExecution,
  PreparedProvenance
>();

export async function prepareProcessExecution(
  input: PrepareProcessExecutionInput,
): Promise<PreparedProcessExecution> {
  throwIfAborted(input.signal, "Process preparation was cancelled before observation.");
  const executable = await resolveExecutable(
    input.request.executable,
    input.executablePolicy,
  );
  throwIfAborted(input.signal, "Process preparation was cancelled during executable resolution.");
  const cwd = await prepareWorkingDirectory(
    input.workspaceRoot,
    input.request.cwd,
  );
  throwIfAborted(input.signal, "Process preparation was cancelled during workspace observation.");
  const environment = buildProcessEnvironment({
    profile: input.environmentProfile,
    ambient: input.ambientEnvironment,
    additions: input.request.environment,
  });
  const stdinObservation = await observeStdin(
    input.request.stdin,
    input.workspaceFileReader,
    input.signal,
  );
  throwIfAborted(input.signal, "Process preparation was cancelled during stdin observation.");
  const safeFacts = {
    schemaVersion: 1,
    request: input.request,
    executable: {
      requested: executable.requested,
      physicalPath: executable.physicalPath,
      identity: executable.identity,
    },
    cwd: {
      relativePath: cwd.relativePath,
      physicalPath: cwd.physicalPath,
      rootIdentity: cwd.rootIdentity,
      cwdIdentity: cwd.cwdIdentity,
    },
    environment: input.request.environment,
    environmentSha256: environment.metadata.environmentSha256,
    stdin: stdinObservation.prepared,
    sandboxed: false,
  };
  const prepared = Object.freeze({
    request: input.request,
    executable,
    cwd,
    environment,
    stdin: stdinObservation.prepared,
    preparedHash: createHash("sha256")
      .update(JSON.stringify(safeFacts))
      .digest("hex"),
    sandbox: Object.freeze({
      sandboxed: false as const,
      filesystemIsolation: "none" as const,
      networkIsolation: "none" as const,
    }),
  });
  PREPARED_PROVENANCE.set(
    prepared,
    Object.freeze({
      revalidateStdin: async (signal: AbortSignal) => {
        const current = await observeStdin(
          input.request.stdin,
          input.workspaceFileReader,
          signal,
        );
        return (
          current.prepared.sha256 === stdinObservation.prepared.sha256 &&
          current.prepared.byteLength === stdinObservation.prepared.byteLength &&
          current.prepared.bytesBase64 === stdinObservation.prepared.bytesBase64
        );
      },
    }),
  );
  return prepared;
}

export class ProcessController {
  readonly #forceWaitMs: number;
  readonly #pollIntervalMs: number;

  public constructor(options: ProcessControllerOptions = {}) {
    this.#forceWaitMs = boundedDuration(options.forceWaitMs ?? 2_000, "forceWaitMs");
    this.#pollIntervalMs = boundedDuration(
      options.pollIntervalMs ?? 10,
      "pollIntervalMs",
    );
  }

  public async run(
    prepared: PreparedProcessExecution,
    context: ProcessRunContext,
  ): Promise<ProcessRunResult> {
    const provenance = PREPARED_PROVENANCE.get(prepared);
    if (provenance === undefined) {
      throw new ProcessToolError(
        "invariant_violated",
        "Process execution requires a recognized prepared handle.",
      );
    }
    const startedAt = performance.now();
    const output = new BoundedOutputMultiplexer(prepared.request.output);
    let eventSink = context.onEvent;
    let winner: ProcessTerminationRequest | "exit" | "spawn_failed" | null = null;
    const secondaryReasons = new Set<ProcessTerminationRequest>();
    let child: ChildProcessWithoutNullStreams | null = null;
    let spawned = false;
    let closeObserved = false;
    let exitCode: number | null = null;
    let exitSignal: string | null = null;
    let gracefulSignalSent = false;
    let forceSignalSent = false;
    let groupReaped = true;
    let terminationPromise: Promise<void> | null = null;
    let forceCompletion: (() => void) | null = null;

    const emit = (event: ProcessLifecycleEvent): boolean => {
      if (eventSink === undefined) return true;
      try {
        eventSink(event);
        return true;
      } catch {
        eventSink = undefined;
        return false;
      }
    };

    const startTermination = (): void => {
      if (
        child === null ||
        !spawned ||
        child.pid === undefined ||
        winner === null ||
        winner === "exit" ||
        winner === "spawn_failed" ||
        terminationPromise !== null
      ) {
        return;
      }
      const reason = winner;
      terminationPromise = (async () => {
        const termination = await terminateOwnedProcessGroup({
          child: child as ChildProcessWithoutNullStreams,
          pid: (child as ChildProcessWithoutNullStreams).pid!,
          reason,
          graceMs: prepared.request.terminationGraceMs,
          forceWaitMs: this.#forceWaitMs,
          pollIntervalMs: this.#pollIntervalMs,
          emit,
        });
        gracefulSignalSent = termination.gracefulSignalSent;
        forceSignalSent = termination.forceSignalSent;
        groupReaped = termination.groupReaped;
        if (!closeObserved) {
          await delay(this.#forceWaitMs);
          if (!closeObserved) {
            groupReaped = false;
            forceCompletion?.();
          }
        }
      })();
    };

    const requestTermination = (reason: ProcessTerminationRequest): void => {
      if (closeObserved || winner === "spawn_failed") {
        secondaryReasons.add(reason);
        return;
      }
      if (winner === null || winner === "exit") winner = reason;
      else if (winner !== reason) secondaryReasons.add(reason);
      startTermination();
    };

    if (
      !emit({
        type: "prepared",
        preparedHash: prepared.preparedHash,
        executable: prepared.executable.physicalPath,
        cwd: prepared.cwd.physicalPath,
        sandboxed: false,
      })
    ) {
      requestTermination("controller_failure");
    }

    const onAbort = (): void => requestTermination("cancelled");
    context.signal.addEventListener("abort", onAbort, { once: true });
    if (context.signal.aborted) requestTermination("cancelled");
    const timeout = setTimeout(
      () => requestTermination("timeout"),
      prepared.request.timeoutMs,
    );

    try {
      if (winner === null && !(await revalidateExecutable(prepared.executable))) {
        throw new ProcessToolError(
          "executable_changed",
          "The resolved executable changed before spawn.",
        );
      }
      if (winner === null && !(await revalidateWorkingDirectory(prepared.cwd))) {
        throw new ProcessToolError(
          "cwd_invalid",
          "The process working directory changed before spawn.",
        );
      }
      if (winner === null && !(await provenance.revalidateStdin(context.signal))) {
        throw new ProcessToolError(
          "invalid_request",
          "The process stdin source changed before spawn.",
        );
      }
      if (winner !== null) {
        clearTimeout(timeout);
        return settleWithoutSpawn(
          prepared,
          output,
          startedAt,
          winner,
          secondaryReasons,
          emit,
        );
      }

      const completion = new Promise<
        | { readonly type: "close" }
        | { readonly type: "spawn_error" }
        | { readonly type: "termination_deadline" }
      >((resolve) => {
        forceCompletion = () => resolve({ type: "termination_deadline" });
        try {
          child = spawn(prepared.executable.physicalPath, [...prepared.request.argv], {
            cwd: prepared.cwd.physicalPath,
            env: { ...prepared.environment.values },
            shell: false,
            detached: process.platform !== "win32",
            windowsHide: true,
            stdio: ["pipe", "pipe", "pipe"],
          });
        } catch {
          winner = "spawn_failed";
          resolve({ type: "spawn_error" });
          return;
        }
        child.once("spawn", () => {
          spawned = true;
          const pid = child?.pid;
          if (pid === undefined) {
            requestTermination("controller_failure");
            return;
          }
          if (
            !emit({
              type: "started",
              pid,
              processGroupId: process.platform === "win32" ? null : pid,
            })
          ) {
            requestTermination("controller_failure");
          }
          startTermination();
        });
        child.once("error", () => {
          if (!spawned) {
            winner = "spawn_failed";
            clearTimeout(timeout);
            resolve({ type: "spawn_error" });
          } else {
            requestTermination("controller_failure");
          }
        });
        child.once("exit", (code, signal) => {
          exitCode = code;
          exitSignal = signal;
          if (winner === null) winner = "exit";
          if (!emit({ type: "leader_exited", exitCode: code, signal })) {
            requestTermination("controller_failure");
          }
        });
        child.once("close", (code, signal) => {
          closeObserved = true;
          exitCode ??= code;
          exitSignal ??= signal;
          if (winner === null) winner = "exit";
          clearTimeout(timeout);
          resolve({ type: "close" });
        });
        child.stdout.on("data", (chunk: Buffer) => {
          const event = output.append("stdout", chunk);
          if (!emit({ type: "output", chunk: event })) {
            requestTermination("controller_failure");
          }
          if (event.limitExceeded) requestTermination("output_limit");
        });
        child.stderr.on("data", (chunk: Buffer) => {
          const event = output.append("stderr", chunk);
          if (!emit({ type: "output", chunk: event })) {
            requestTermination("controller_failure");
          }
          if (event.limitExceeded) requestTermination("output_limit");
        });
        child.stdin.on("error", () => undefined);
        const stdinBytes = Buffer.from(prepared.stdin.bytesBase64, "base64");
        child.stdin.end(stdinBytes);
      });

      const completed = await completion;
      const ownedChild = child as ChildProcessWithoutNullStreams | null;
      if (completed.type === "spawn_error") {
        groupReaped = true;
      } else if (completed.type === "termination_deadline") {
        groupReaped = false;
        ownedChild?.stdout.removeAllListeners("data");
        ownedChild?.stderr.removeAllListeners("data");
        ownedChild?.stdout.destroy();
        ownedChild?.stderr.destroy();
        ownedChild?.stdin.destroy();
      } else {
        startTermination();
        if (terminationPromise !== null) await terminationPromise;
        if (
          ownedChild?.pid !== undefined &&
          (await processGroupExists(ownedChild.pid))
        ) {
          const residualReason: ProcessTerminationRequest =
            winner === "exit" || winner === null ? "controller_failure" : winner;
          const residual = await terminateOwnedProcessGroup({
            child: ownedChild,
            pid: ownedChild.pid,
            reason: residualReason,
            graceMs: prepared.request.terminationGraceMs,
            forceWaitMs: this.#forceWaitMs,
            pollIntervalMs: this.#pollIntervalMs,
            emit,
          });
          gracefulSignalSent ||= residual.gracefulSignalSent;
          forceSignalSent ||= residual.forceSignalSent;
          groupReaped = residual.groupReaped;
        }
      }

      const sealed = output.seal();
      const durationMs = elapsed(startedAt);
      let classification = classify(winner, exitCode, exitSignal);
      if (!groupReaped) classification = "termination_incomplete";
      const result = freezeResult({
        prepared,
        classification,
        exitCode,
        exitSignal,
        pid: ownedChild?.pid ?? null,
        durationMs,
        output: sealed,
        termination: {
          requestedReason:
            winner === null || winner === "exit" || winner === "spawn_failed"
              ? null
              : winner,
          secondaryReasons: Object.freeze([...secondaryReasons].sort()),
          gracefulSignalSent,
          forceSignalSent,
          groupReaped,
          supervision:
            process.platform === "win32"
              ? "direct_child_only"
              : "posix_process_group",
          escapedGroupDetection: "unavailable",
        },
      });
      emit({ type: "settled", classification, durationMs });
      return result;
    } finally {
      clearTimeout(timeout);
      context.signal.removeEventListener("abort", onAbort);
    }
  }
}

async function observeStdin(
  stdin: ProcessStdin,
  reader: ProcessWorkspaceFileReader | undefined,
  signal: AbortSignal,
): Promise<{
  readonly prepared: PreparedProcessStdin;
}> {
  if (signal.aborted) {
    throw new ProcessToolError("cancelled", "Process stdin observation was cancelled.");
  }
  let bytes: Buffer;
  if (stdin.kind === "closed") bytes = Buffer.alloc(0);
  else if (stdin.kind === "inline_utf8") bytes = Buffer.from(stdin.text, "utf8");
  else {
    if (reader === undefined) {
      throw new ProcessToolError(
        "invalid_request",
        "Workspace-file stdin requires the workspace read boundary.",
      );
    }
    bytes = Buffer.from(await reader.read(stdin.path, stdin.maximumBytes, signal));
    if (bytes.byteLength > stdin.maximumBytes) {
      throw new ProcessToolError(
        "invalid_request",
        "Workspace-file stdin exceeded its approved byte bound.",
      );
    }
    const observedHash = createHash("sha256").update(bytes).digest("hex");
    if (observedHash !== stdin.expectedSha256) {
      throw new ProcessToolError(
        "invalid_request",
        "Workspace-file stdin did not match its approved preimage.",
      );
    }
  }
  return Object.freeze({
    prepared: Object.freeze({
      kind: stdin.kind,
      byteLength: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      bytesBase64: bytes.toString("base64"),
    }),
  });
}

async function terminateOwnedProcessGroup(input: {
  readonly child: ChildProcessWithoutNullStreams;
  readonly pid: number;
  readonly reason: ProcessTerminationRequest;
  readonly graceMs: number;
  readonly forceWaitMs: number;
  readonly pollIntervalMs: number;
  readonly emit: (event: ProcessLifecycleEvent) => boolean;
}): Promise<{
  readonly gracefulSignalSent: boolean;
  readonly forceSignalSent: boolean;
  readonly groupReaped: boolean;
}> {
  let gracefulSignalSent = false;
  let forceSignalSent = false;
  if (await processGroupExists(input.pid)) {
    gracefulSignalSent = signalOwnedProcess(input.child, input.pid, "SIGTERM");
    input.emit({
      type: "termination_requested",
      reason: input.reason,
      signal: "SIGTERM",
    });
  }
  if (
    await waitForGroupAbsence(
      input.pid,
      input.graceMs,
      input.pollIntervalMs,
    )
  ) {
    return { gracefulSignalSent, forceSignalSent, groupReaped: true };
  }
  forceSignalSent = signalOwnedProcess(input.child, input.pid, "SIGKILL");
  input.emit({
    type: "termination_escalated",
    reason: input.reason,
    signal: "SIGKILL",
  });
  const groupReaped = await waitForGroupAbsence(
    input.pid,
    input.forceWaitMs,
    input.pollIntervalMs,
  );
  return { gracefulSignalSent, forceSignalSent, groupReaped };
}

function signalOwnedProcess(
  child: ChildProcessWithoutNullStreams,
  pid: number,
  signal: NodeJS.Signals,
): boolean {
  try {
    if (process.platform === "win32") return child.kill(signal);
    process.kill(-pid, signal);
    return true;
  } catch (error: unknown) {
    if (hasCode(error, "ESRCH")) return false;
    return false;
  }
}

async function processGroupExists(pid: number): Promise<boolean> {
  try {
    if (process.platform === "win32") {
      process.kill(pid, 0);
    } else {
      process.kill(-pid, 0);
    }
    return true;
  } catch (error: unknown) {
    return !hasCode(error, "ESRCH");
  }
}

async function waitForGroupAbsence(
  pid: number,
  maximumWaitMs: number,
  pollIntervalMs: number,
): Promise<boolean> {
  const deadline = performance.now() + maximumWaitMs;
  do {
    if (!(await processGroupExists(pid))) return true;
    await delay(Math.min(pollIntervalMs, Math.max(0, deadline - performance.now())));
  } while (performance.now() < deadline);
  return !(await processGroupExists(pid));
}

function settleWithoutSpawn(
  prepared: PreparedProcessExecution,
  output: BoundedOutputMultiplexer,
  startedAt: number,
  winner: Exclude<ProcessTerminationRequest | "exit" | "spawn_failed", "exit" | "spawn_failed">,
  secondaryReasons: ReadonlySet<ProcessTerminationRequest>,
  emit: (event: ProcessLifecycleEvent) => boolean,
): ProcessRunResult {
  const durationMs = elapsed(startedAt);
  const classification = classify(winner, null, null);
  const result = freezeResult({
    prepared,
    classification,
    exitCode: null,
    exitSignal: null,
    pid: null,
    durationMs,
    output: output.seal(),
    termination: {
      requestedReason: winner,
      secondaryReasons: Object.freeze([...secondaryReasons].sort()),
      gracefulSignalSent: false,
      forceSignalSent: false,
      groupReaped: true,
      supervision:
        process.platform === "win32" ? "direct_child_only" : "posix_process_group",
      escapedGroupDetection: "unavailable",
    },
  });
  emit({ type: "settled", classification, durationMs });
  return result;
}

function classify(
  winner: ProcessTerminationRequest | "exit" | "spawn_failed" | null,
  exitCode: number | null,
  exitSignal: string | null,
): ProcessResultClassification {
  if (winner === "spawn_failed") return "spawn_failed";
  if (winner === "cancelled") return "cancelled";
  if (winner === "timeout") return "timed_out";
  if (winner === "output_limit") return "output_limit_exceeded";
  if (winner === "controller_failure") return "controller_failed";
  if (exitSignal !== null) return "signal_exit";
  return exitCode === 0 ? "success" : "nonzero_exit";
}

function freezeResult(input: {
  readonly prepared: PreparedProcessExecution;
  readonly classification: ProcessResultClassification;
  readonly exitCode: number | null;
  readonly exitSignal: string | null;
  readonly pid: number | null;
  readonly durationMs: number;
  readonly output: ProcessOutputSnapshot;
  readonly termination: ProcessTerminationReport;
}): ProcessRunResult {
  return Object.freeze({
    classification: input.classification,
    exitCode: input.exitCode,
    signal: input.exitSignal,
    pid: input.pid,
    durationMs: input.durationMs,
    output: input.output,
    executable: input.prepared.executable,
    cwd: input.prepared.cwd.physicalPath,
    preparedHash: input.prepared.preparedHash,
    termination: Object.freeze(input.termination),
    sandbox: input.prepared.sandbox,
  });
}

function hasCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === code
  );
}

function elapsed(startedAt: number): number {
  return Math.max(0, Math.round(performance.now() - startedAt));
}

function boundedDuration(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 60_000) {
    throw new ProcessToolError("invalid_request", `${label} is invalid.`);
  }
  return value;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function throwIfAborted(signal: AbortSignal, message: string): void {
  if (signal.aborted) throw new ProcessToolError("cancelled", message);
}
