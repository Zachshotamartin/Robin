import assert from "node:assert/strict";
import test from "node:test";

import { isDomainError } from "@guard/contracts";

import { CancellationTree } from "./cancellation-tree.js";

test("turn cancellation fans out to active tools but not the session", () => {
  const tree = new CancellationTree();
  const session = tree.openSession("session:one");
  const turn = tree.openTurn("session:one");
  const firstTool = tree.openTool("session:one");
  const secondTool = tree.openTool("session:one");

  tree.abortTurn("session:one", "test_cancel");
  assert.equal(turn.signal.aborted, true);
  assert.equal(firstTool.signal.aborted, true);
  assert.equal(secondTool.signal.aborted, true);
  assert.equal(session.signal.aborted, false);

  const nextTurn = tree.openTurn("session:one");
  assert.equal(nextTurn.signal.aborted, false);
  tree.close();
  assert.equal(session.signal.aborted, true);
  assert.equal(nextTurn.signal.aborted, true);
});

test("session abort is isolated from sibling sessions", () => {
  const tree = new CancellationTree();
  const first = tree.openSession("session:first");
  const second = tree.openSession("session:second");
  const firstTurn = tree.openTurn("session:first");
  const secondTurn = tree.openTurn("session:second");
  tree.abortSession("session:first");
  assert.equal(first.signal.aborted, true);
  assert.equal(firstTurn.signal.aborted, true);
  assert.equal(second.signal.aborted, false);
  assert.equal(secondTurn.signal.aborted, false);
});

test("tree enforces one session and foreground turn scope", () => {
  const tree = new CancellationTree();
  tree.openSession("session:one");
  assert.throws(
    () => tree.openSession("session:one"),
    (error: unknown) => isDomainError(error) && error.code === "conflict",
  );
  assert.throws(
    () => tree.openTool("session:one"),
    (error: unknown) => isDomainError(error) && error.code === "conflict",
  );
  tree.openTurn("session:one");
  assert.throws(
    () => tree.openTurn("session:one"),
    (error: unknown) => isDomainError(error) && error.code === "conflict",
  );
});

test("closing tool and tree scopes is idempotent", () => {
  const tree = new CancellationTree();
  tree.openSession("session:one");
  tree.openTurn("session:one");
  const tool = tree.openTool("session:one");
  tool.close();
  tool.close();
  tree.closeTurn("session:one");
  tree.closeTurn("session:one");
  tree.close();
  tree.close();
  assert.equal(tool.closed, true);
});
