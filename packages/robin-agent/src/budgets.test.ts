import assert from "node:assert/strict";
import test from "node:test";

import { isDomainError } from "@guard/contracts";

import { TurnBudgets, type TurnBudgetLimits } from "./index.js";

const LIMITS: TurnBudgetLimits = Object.freeze({
  maximumModelRequests: 2,
  maximumToolCalls: 2,
  maximumOutputBytes: 5,
  maximumProviderEvents: 2,
  maximumWallTimeMs: 10,
});

function domainCode(code: string): (error: unknown) => boolean {
  return (error) => isDomainError(error) && error.code === code;
}

test("allows exact turn-budget limits and returns an immutable snapshot", () => {
  let now = 100;
  const budget = new TurnBudgets({ now: () => now }, LIMITS);
  budget.reserveModelRequest();
  budget.reserveModelRequest();
  budget.reserveToolCall();
  budget.reserveToolCall();
  budget.recordProviderEvent();
  budget.recordProviderEvent();
  budget.recordOutputBytes(2);
  budget.recordOutputBytes(3);
  now = 110;

  assert.deepEqual(budget.snapshot(), {
    modelRequests: 2,
    toolCalls: 2,
    outputBytes: 5,
    providerEvents: 2,
    elapsedMs: 10,
    limits: LIMITS,
  });
  assert.equal(Object.isFrozen(budget.snapshot()), true);
  assert.equal(Object.isFrozen(budget.snapshot().limits), true);
});

test("rejects the first unit beyond every counter budget without overflow", () => {
  const cases: readonly {
    readonly fill: (budget: TurnBudgets) => void;
    readonly overflow: (budget: TurnBudgets) => void;
  }[] = [
    {
      fill: (budget) => {
        budget.reserveModelRequest();
        budget.reserveModelRequest();
      },
      overflow: (budget) => budget.reserveModelRequest(),
    },
    {
      fill: (budget) => {
        budget.reserveToolCall();
        budget.reserveToolCall();
      },
      overflow: (budget) => budget.reserveToolCall(),
    },
    {
      fill: (budget) => {
        budget.recordProviderEvent();
        budget.recordProviderEvent();
      },
      overflow: (budget) => budget.recordProviderEvent(),
    },
    {
      fill: (budget) => budget.recordOutputBytes(5),
      overflow: (budget) => budget.recordOutputBytes(Number.MAX_SAFE_INTEGER),
    },
  ];

  for (const value of cases) {
    const budget = new TurnBudgets({ now: () => 0 }, LIMITS);
    value.fill(budget);
    assert.throws(() => value.overflow(budget), domainCode("budget_exceeded"));
  }
});

test("enforces elapsed wall time and fails closed on a broken monotonic clock", () => {
  let now = 50;
  const exhausted = new TurnBudgets({ now: () => now }, LIMITS);
  now = 61;
  assert.throws(() => exhausted.checkWallTime(), domainCode("budget_exceeded"));

  now = 50;
  const backwards = new TurnBudgets({ now: () => now }, LIMITS);
  backwards.checkWallTime();
  now = 49;
  assert.throws(
    () => backwards.checkWallTime(),
    domainCode("infrastructure_failed"),
  );

  assert.throws(
    () => new TurnBudgets({ now: () => Number.NaN }, LIMITS),
    domainCode("infrastructure_failed"),
  );
  assert.throws(
    () =>
      new TurnBudgets(
        {
          now() {
            throw new Error("clock secret");
          },
        },
        LIMITS,
      ),
    (error: unknown) => {
      assert.equal(domainCode("infrastructure_failed")(error), true);
      assert.equal(JSON.stringify(error).includes("clock secret"), false);
      return true;
    },
  );
});

test("rejects invalid limits and output-accounting input", () => {
  assert.throws(
    () => new TurnBudgets({ now: () => 0 }, { maximumModelRequests: 0 }),
    domainCode("invalid_input"),
  );
  const budget = new TurnBudgets({ now: () => 0 }, LIMITS);
  assert.throws(
    () => budget.recordOutputBytes(-1),
    domainCode("invariant_violated"),
  );
  budget.recordOutputBytes(5);
  assert.equal(budget.remainingOutputBytes, 0);
  assert.throws(
    () => budget.requireOutputCapacity(1),
    domainCode("budget_exceeded"),
  );
});
