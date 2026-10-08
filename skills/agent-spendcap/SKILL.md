---
name: agent-spendcap
description: "Enforce cost, tool-call, and external-write budgets plus semantic rate limits on an AI agent"
---

# agent-spendcap

Use this skill when an AI agent needs spend protection: cap what an agent may cost, how many tools it may call, how many external writes it may make, and how often named action classes may occur (e.g. max 5 refunds per hour).

## Install

```sh
npm i agent-spendcap
```

## The pattern: check before, record after

Wrap every tool call. `check()` is pure and never mutates state. `record()` updates counters, appends a JSONL audit line, and fires `onExhausted` at most once per exhausted dimension.

```ts
import { createBudget } from "agent-spendcap";

const budget = createBudget({
  maxCostUsd: 5,
  maxToolCalls: 50,
  maxExternalWrites: 5,
  rates: { refundsPerHour: 5 }, // 5 refund actions per hour (default window)
  scope: "task-123",
  onExhausted: (e) => console.error(`budget exhausted: ${e.reason}`),
  logJsonl: "./spend.jsonl",
});

const r = budget.check({ kind: "tool", costUsd: 0.02 });
if (!r.allowed) throw new Error(r.reason);
// ... execute the tool ...
budget.record({ kind: "tool", costUsd: 0.02 });

// a financial action that counts toward the named rate:
budget.record({ kind: "financial", costUsd: 0, rateKeys: ["refundsPerHour"] });
```

## Kinds

`"tool"`, `"financial"`, `"email"`, `"external-write"`. Only `kind === "external-write"` counts toward the external-write cap. Gate `"financial"` and `"email"` with named rates instead of the write cap.

## Reading the meter

```ts
budget.snapshot();
// { spent: { costUsd, toolCalls, externalWrites, rates },
//   remaining: { costUsd, toolCalls, externalWrites, rates },
//   scope: "task-123" }
```

Unconfigured dimensions report `Infinity` remaining. `budget.reset()` zeroes counters and clears fired flags; the JSONL log is append-only and is never cleared.

## Pairs with callgate

callgate decides whether an agent SHOULD perform an action. agent-spendcap decides HOW MUCH the agent may spend performing actions. Use both: gate first, then check the budget.
