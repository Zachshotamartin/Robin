#!/usr/bin/env python3
"""Deterministic stdlib-only PTY driver for Robin's R1 and R2 terminal gates."""

from __future__ import annotations

import argparse
import base64
import errno
import fcntl
import json
import os
import re
import select
import signal
import struct
import subprocess
import sys
import termios
import time
from typing import NoReturn


ANSI_PATTERN = re.compile(rb"\x1b\[[0-?]*[ -/]*[@-~]")
DEFAULT_TIMEOUT_SECONDS = 12.0

R2_SCENARIOS = frozenset(
    {
        "r2_approve",
        "r2_cancel_approval",
        "r2_deny",
    }
)


def fail(message: str) -> NoReturn:
    raise RuntimeError(message)


def normalized_text(transcript: bytearray) -> str:
    return ANSI_PATTERN.sub(b"", bytes(transcript)).decode("utf-8", "replace")


def set_window_size(file_descriptor: int, columns: int, rows: int) -> None:
    packed = struct.pack("HHHH", rows, columns, 0, 0)
    fcntl.ioctl(file_descriptor, termios.TIOCSWINSZ, packed)


def read_available(master_descriptor: int, transcript: bytearray) -> bool:
    try:
        chunk = os.read(master_descriptor, 65_536)
    except BlockingIOError:
        return True
    except OSError as error:
        if error.errno == errno.EIO:
            return False
        raise
    if not chunk:
        return False
    transcript.extend(chunk)
    if len(transcript) > 8 * 1024 * 1024:
        fail("PTY transcript exceeded its 8 MiB test bound.")
    return True


def wait_for(
    process: subprocess.Popen[bytes],
    master_descriptor: int,
    transcript: bytearray,
    expected: str,
    timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS,
    after_byte: int = 0,
) -> None:
    deadline = time.monotonic() + timeout_seconds
    while time.monotonic() < deadline:
        if expected in normalized_text(transcript[after_byte:]):
            return
        readable, _, _ = select.select([master_descriptor], [], [], 0.05)
        if readable and not read_available(master_descriptor, transcript):
            break
        if process.poll() is not None and not readable:
            read_available(master_descriptor, transcript)
            break
    preview = normalized_text(transcript)[-2_000:]
    fail(f"Timed out waiting for {expected!r}. Transcript tail: {preview!r}")


def write_all(master_descriptor: int, value: bytes) -> None:
    view = memoryview(value)
    while view:
        written = os.write(master_descriptor, view)
        view = view[written:]


def wait_for_exit(
    process: subprocess.Popen[bytes],
    master_descriptor: int,
    transcript: bytearray,
) -> int:
    deadline = time.monotonic() + DEFAULT_TIMEOUT_SECONDS
    while time.monotonic() < deadline:
        readable, _, _ = select.select([master_descriptor], [], [], 0.05)
        if readable:
            read_available(master_descriptor, transcript)
        result = process.poll()
        if result is not None:
            while True:
                readable, _, _ = select.select([master_descriptor], [], [], 0)
                if not readable or not read_available(master_descriptor, transcript):
                    break
            return result
    fail("Robin did not exit within the PTY test deadline.")


def answer_approval(
    process: subprocess.Popen[bytes],
    master_descriptor: int,
    transcript: bytearray,
    decision: str,
    expected_tool: str | None = None,
) -> str:
    """Wait for one complete approval block and type one exact decision."""
    approval_start = len(transcript)
    wait_for(
        process,
        master_descriptor,
        transcript,
        "Approval required - there is no default decision.",
        after_byte=approval_start,
    )
    if expected_tool is not None:
        wait_for(
            process,
            master_descriptor,
            transcript,
            f"Tool: {expected_tool}",
            after_byte=approval_start,
        )
    wait_for(
        process,
        master_descriptor,
        transcript,
        "Decision: type exactly y or allow-once",
        after_byte=approval_start,
    )
    approval_text = normalized_text(transcript[approval_start:])
    tools = re.findall(r"Tool: ([^\r\n]+)", approval_text)
    if not tools:
        fail("The complete approval block did not contain a tool identity.")
    tool_name = tools[-1].strip()
    if expected_tool is not None and tool_name != expected_tool:
        fail(
            f"Expected approval for {expected_tool!r}, received {tool_name!r}."
        )
    write_all(master_descriptor, decision.encode("ascii") + b"\r")
    if decision == "deny":
        wait_for(
            process,
            master_descriptor,
            transcript,
            "was denied; no execution authority was granted.",
            after_byte=approval_start,
        )
    elif decision != "allow-once":
        fail(f"Unsupported exact approval decision: {decision!r}")
    return tool_name


def run_scenario(args: argparse.Namespace) -> dict[str, object]:
    master_descriptor, slave_descriptor = os.openpty()
    set_window_size(slave_descriptor, 80, 24)
    before = termios.tcgetattr(slave_descriptor)
    transcript = bytearray()
    is_r2 = args.scenario in R2_SCENARIOS
    model_id = "synthetic-r2-v1" if is_r2 else "synthetic-r1-v1"
    command = [args.node, args.binary, "--model", model_id]
    if args.scenario == "initial":
        command.append("Why does the fixture total fail?")
    environment = dict(os.environ)
    environment.update(
        {
            "TERM": "xterm-256color",
            "LANG": "C.UTF-8",
            "LC_ALL": "C.UTF-8",
        }
    )
    environment.pop("NO_COLOR", None)
    process: subprocess.Popen[bytes] | None = None
    try:
        process = subprocess.Popen(
            command,
            cwd=args.cwd,
            env=environment,
            stdin=slave_descriptor,
            stdout=slave_descriptor,
            stderr=slave_descriptor,
            close_fds=True,
        )
        os.set_blocking(master_descriptor, False)
        # Consume the complete initial readiness header before any scenario
        # records its transcript boundary. A partial "Robin" match can leave
        # the remainder of this first header eligible to satisfy a later
        # post-turn readiness wait during a cold installed-package start.
        wait_for(process, master_descriptor, transcript, "Robin · ready")

        approval_tools: list[str] = []
        approval_decisions: list[str] = []
        if args.scenario in ("happy", "initial"):
            first_turn_start = len(transcript)
            if args.scenario == "happy":
                write_all(master_descriptor, b"Why does the fixture total fail?\r")
            wait_for(
                process,
                master_descriptor,
                transcript,
                "No physical repository was read or changed.",
                after_byte=first_turn_start,
            )
            wait_for(
                process,
                master_descriptor,
                transcript,
                "Robin · ready",
                after_byte=first_turn_start,
            )
            second_turn_start = len(transcript)
            write_all(master_descriptor, b"What exact change should I make?\r")
            wait_for(
                process,
                master_descriptor,
                transcript,
                "negative total.",
                after_byte=second_turn_start,
            )
            wait_for(
                process,
                master_descriptor,
                transcript,
                "Robin · ready",
                after_byte=second_turn_start,
            )
            write_all(master_descriptor, b"\x04")
        elif args.scenario == "queue":
            scenario_start = len(transcript)
            write_all(master_descriptor, b"[scenario:slow]\r")
            wait_for(process, master_descriptor, transcript, "Working on the synthetic fixture")
            write_all(master_descriptor, b"Why does the fixture total fail?\r")
            wait_for(process, master_descriptor, transcript, "Queued 1/1")
            write_all(master_descriptor, b"\x03")
            wait_for(
                process,
                master_descriptor,
                transcript,
                "No physical repository was read or changed.",
                after_byte=scenario_start,
            )
            wait_for(
                process,
                master_descriptor,
                transcript,
                "Robin · ready",
                after_byte=scenario_start,
            )
            write_all(master_descriptor, b"\x04")
        elif args.scenario == "cancel":
            scenario_start = len(transcript)
            write_all(master_descriptor, b"[scenario:slow]\r")
            wait_for(process, master_descriptor, transcript, "Working on the synthetic fixture")
            write_all(master_descriptor, b"\x03")
            wait_for(
                process,
                master_descriptor,
                transcript,
                "cancelled",
                after_byte=scenario_start,
            )
            wait_for(
                process,
                master_descriptor,
                transcript,
                "Robin · ready",
                after_byte=scenario_start,
            )
            write_all(master_descriptor, b"\x04")
        elif args.scenario == "double_interrupt":
            write_all(master_descriptor, b"[scenario:slow]\r")
            wait_for(process, master_descriptor, transcript, "Working on the synthetic fixture")
            write_all(master_descriptor, b"\x03\x03")
        elif args.scenario == "resize":
            set_window_size(slave_descriptor, 40, 12)
            process.send_signal(signal.SIGWINCH)
            wait_for(process, master_descriptor, transcript, "40x12")
            write_all(master_descriptor, b"\x04")
        elif args.scenario == "provider_error":
            scenario_start = len(transcript)
            write_all(master_descriptor, b"[scenario:provider-error]\r")
            wait_for(
                process,
                master_descriptor,
                transcript,
                "Error:",
                after_byte=scenario_start,
            )
            wait_for(
                process,
                master_descriptor,
                transcript,
                "Robin · ready",
                after_byte=scenario_start,
            )
            write_all(master_descriptor, b"\x04")
        elif args.scenario == "tool_error":
            scenario_start = len(transcript)
            write_all(master_descriptor, b"[scenario:tool-error]\r")
            wait_for(
                process,
                master_descriptor,
                transcript,
                "failed",
                after_byte=scenario_start,
            )
            wait_for(
                process,
                master_descriptor,
                transcript,
                "Robin · ready",
                after_byte=scenario_start,
            )
            write_all(master_descriptor, b"\x04")
        elif args.scenario == "paste":
            scenario_start = len(transcript)
            write_all(
                master_descriptor,
                b"\x1b[200~/exit\nhidden prompt\x1b[201~",
            )
            wait_for(process, master_descriptor, transcript, "/exit")
            time.sleep(0.1)
            if process.poll() is not None:
                fail("Bracketed paste unexpectedly submitted a local command.")
            write_all(master_descriptor, b"\x15Why does the fixture total fail?\r")
            wait_for(
                process,
                master_descriptor,
                transcript,
                "No physical repository was read or changed.",
                after_byte=scenario_start,
            )
            wait_for(
                process,
                master_descriptor,
                transcript,
                "Robin · ready",
                after_byte=scenario_start,
            )
            write_all(master_descriptor, b"\x04")
        elif args.scenario == "r2_approve":
            scenario_start = len(transcript)
            write_all(
                master_descriptor,
                b"Diagnose and fix the deterministic coding fixture, run its tests, and review the diff.\r",
            )
            expected_approval_tools = (
                "robin.edit.apply_patch@1",
                "robin.process.run@1",
                "robin.edit.apply_patch@1",
                "robin.process.run@1",
            )
            for expected_tool in expected_approval_tools:
                approval_tools.append(
                    answer_approval(
                        process,
                        master_descriptor,
                        transcript,
                        "allow-once",
                        expected_tool,
                    )
                )
                approval_decisions.append("allow-once")
            wait_for(
                process,
                master_descriptor,
                transcript,
                "robin.git.status@1",
                timeout_seconds=30.0,
                after_byte=scenario_start,
            )
            wait_for(
                process,
                master_descriptor,
                transcript,
                "robin.git.diff@1",
                after_byte=scenario_start,
            )
            wait_for(
                process,
                master_descriptor,
                transcript,
                "Robin · ready",
                after_byte=scenario_start,
            )
            write_all(master_descriptor, b"\x04")
        elif args.scenario == "r2_deny":
            scenario_start = len(transcript)
            write_all(
                master_descriptor,
                b"Diagnose and fix the deterministic coding fixture.\r",
            )
            approval_tools.append(
                answer_approval(
                    process,
                    master_descriptor,
                    transcript,
                    "deny",
                )
            )
            approval_decisions.append("deny")
            wait_for(
                process,
                master_descriptor,
                transcript,
                "No effect occurred for the refused action.",
                after_byte=scenario_start,
            )
            wait_for(
                process,
                master_descriptor,
                transcript,
                "Robin · ready",
                after_byte=scenario_start,
            )
            write_all(master_descriptor, b"\x04")
        elif args.scenario == "r2_cancel_approval":
            scenario_start = len(transcript)
            write_all(
                master_descriptor,
                b"Diagnose and fix the deterministic coding fixture.\r",
            )
            approval_start = len(transcript)
            wait_for(
                process,
                master_descriptor,
                transcript,
                "Approval required - there is no default decision.",
                after_byte=approval_start,
            )
            wait_for(
                process,
                master_descriptor,
                transcript,
                "Decision: type exactly y or allow-once",
                after_byte=approval_start,
            )
            approval_text = normalized_text(transcript[approval_start:])
            tools = re.findall(r"Tool: ([^\r\n]+)", approval_text)
            if not tools:
                fail("The cancellable approval block did not contain a tool identity.")
            approval_tools.append(tools[-1].strip())
            write_all(master_descriptor, b"\x03")
            wait_for(
                process,
                master_descriptor,
                transcript,
                "cancelled",
                after_byte=scenario_start,
            )
            wait_for(
                process,
                master_descriptor,
                transcript,
                "Robin · ready",
                after_byte=scenario_start,
            )
            write_all(master_descriptor, b"\x04")
        else:
            fail(f"Unsupported PTY scenario: {args.scenario}")

        exit_code = wait_for_exit(process, master_descriptor, transcript)
        after = termios.tcgetattr(slave_descriptor)
        return {
            "schemaVersion": 1,
            "scenario": args.scenario,
            "modelId": model_id,
            "exitCode": exit_code,
            "approvalTools": approval_tools,
            "approvalDecisions": approval_decisions,
            "termiosRestored": before == after,
            "transcriptBase64": base64.b64encode(bytes(transcript)).decode("ascii"),
            "normalizedTranscript": normalized_text(transcript),
        }
    finally:
        if process is not None and process.poll() is None:
            process.kill()
            process.wait(timeout=2)
        os.close(master_descriptor)
        os.close(slave_descriptor)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--scenario",
        required=True,
        choices=[
            "happy",
            "initial",
            "queue",
            "cancel",
            "double_interrupt",
            "resize",
            "provider_error",
            "tool_error",
            "paste",
            "r2_approve",
            "r2_cancel_approval",
            "r2_deny",
        ],
    )
    parser.add_argument("--cwd", required=True)
    parser.add_argument("--node", required=True)
    parser.add_argument("--binary", required=True)
    args = parser.parse_args()
    try:
        print(json.dumps(run_scenario(args), ensure_ascii=True, separators=(",", ":")))
        return 0
    except Exception as error:  # The Node harness treats any stderr as a hard failure.
        print(f"robin_pty_driver: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
