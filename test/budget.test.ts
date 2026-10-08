import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createBudget } from "../src/index.js";

describe("cost cap", () => {
  it("allows a check that lands exactly on the cap", () => {
    const b = createBudget({ maxCostUsd: 5 });
    b.record({ kind: "tool", costUsd: 2.5 });
    b.record({ kind: "tool", costUsd: 2.5 });
    const r = b.check({ kind: "tool", costUsd: 0 });
    expect(r.allowed).toBe(true);
    expect(r.reason).toBeUndefined();
  });

  it("blocks a check that would push over the cap, with a formatted reason", () => {
    const b = createBudget({ maxCostUsd: 5 });
    b.record({ kind: "tool", costUsd: 2.5 });
    b.record({ kind: "tool", costUsd: 2.5 });
    const r = b.check({ kind: "tool", costUsd: 0.02 });
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe("maxCostUsd exceeded (spent 5.02 / cap 5)");
  });

  it("allows spending exactly the cap on a fresh budget", () => {
    const b = createBudget({ maxCostUsd: 5 });
    expect(b.check({ kind: "tool", costUsd: 5 }).allowed).toBe(true);
  });

  it("clamps remaining at zero instead of going negative", () => {
    const b = createBudget({ maxCostUsd: 1 });
    b.record({ kind: "tool", costUsd: 5 }); // caller skipped check; safety net
    expect(b.snapshot().remaining.costUsd).toBe(0);
  });
});

describe("tool-call and external-write caps", () => {
  it("blocks the (cap+1)th tool call", () => {
    const b = createBudget({ maxToolCalls: 3 });
    for (let i = 0; i < 3; i++) b.record({ kind: "tool" });
    const r = b.check({ kind: "tool" });
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain("maxToolCalls exceeded");
  });

  it("blocks the (cap+1)th external write", () => {
    const b = createBudget({ maxExternalWrites: 2 });
    b.record({ kind: "external-write" });
    b.record({ kind: "external-write" });
    const r = b.check({ kind: "external-write" });
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain("maxExternalWrites exceeded");
  });

  it("does not count financial or email kinds as external writes", () => {
    const b = createBudget({ maxExternalWrites: 1 });
    b.record({ kind: "financial", costUsd: 10 });
    b.record({ kind: "financial", costUsd: 10 });
    b.record({ kind: "email" });
    expect(b.snapshot().spent.externalWrites).toBe(0);
    expect(b.check({ kind: "external-write" }).allowed).toBe(true);
  });
});

describe("sliding-window rates", () => {
  it("blocks the event that exceeds the named rate, then allows again after the window passes", () => {
    let t = 0;
    const b = createBudget({
      rates: { financialPerHour: 2 },
      rateWindowMs: 1000,
      now: () => t,
    });
    b.record({ kind: "financial", rateKeys: ["financialPerHour"] });
    b.record({ kind: "financial", rateKeys: ["financialPerHour"] });
    const blocked = b.check({ kind: "financial", rateKeys: ["financialPerHour"] });
    expect(blocked.allowed).toBe(false);
    expect(blocked.reason).toContain('rate "financialPerHour" exceeded (3 / 2 per 1000ms)');
    t = 1001; // window slides past both events
    expect(b.check({ kind: "financial", rateKeys: ["financialPerHour"] }).allowed).toBe(true);
  });

  it("ignores rateKeys that are not configured", () => {
    const b = createBudget({ rates: { a: 1 } });
    for (let i = 0; i < 10; i++) b.record({ kind: "tool", rateKeys: ["b"] });
    expect(b.check({ kind: "tool", rateKeys: ["b"] }).allowed).toBe(true);
  });

  it("enforces multiple named rates independently", () => {
    let t = 0;
    const b = createBudget({ rates: { a: 1, b: 2 }, rateWindowMs: 1000, now: () => t });
    b.record({ kind: "tool", rateKeys: ["a"] });
    expect(b.check({ kind: "tool", rateKeys: ["a"] }).allowed).toBe(false);
    expect(b.check({ kind: "tool", rateKeys: ["b"] }).allowed).toBe(true);
    expect(b.snapshot().remaining.rates).toEqual({ a: 0, b: 2 });
  });

  it("uses a 1-hour default window", () => {
    let t = 0;
    const b = createBudget({ rates: { x: 1 }, now: () => t });
    b.record({ kind: "tool", rateKeys: ["x"] });
    t = 3_599_999;
    expect(b.check({ kind: "tool", rateKeys: ["x"] }).allowed).toBe(false);
    t = 3_600_001;
    expect(b.check({ kind: "tool", rateKeys: ["x"] }).allowed).toBe(true);
  });
});

describe("onExhausted", () => {
  it("fires at most once per dimension until reset", () => {
    const fn = vi.fn();
    const b = createBudget({ maxToolCalls: 1, onExhausted: fn });
    b.record({ kind: "tool" });
    expect(fn).toHaveBeenCalledTimes(1);
    b.record({ kind: "tool" });
    b.record({ kind: "tool" });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("fires again after reset", () => {
    const fn = vi.fn();
    const b = createBudget({ maxToolCalls: 1, onExhausted: fn });
    b.record({ kind: "tool" });
    b.reset();
    b.record({ kind: "tool" });
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("receives dimension, reason, and remaining", () => {
    const fn = vi.fn();
    const b = createBudget({ maxToolCalls: 2, onExhausted: fn });
    b.record({ kind: "tool" });
    b.record({ kind: "tool" });
    expect(fn).toHaveBeenCalledTimes(1);
    const e = fn.mock.calls[0][0];
    expect(e.dimension).toBe("toolCalls");
    expect(e.reason).toContain("maxToolCalls exceeded");
    expect(e.remaining.toolCalls).toBe(0);
  });

  it("fires even when the caller skipped check (safety net)", () => {
    const fn = vi.fn();
    const b = createBudget({ maxCostUsd: 1, onExhausted: fn });
    b.record({ kind: "tool", costUsd: 2 });
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn.mock.calls[0][0].dimension).toBe("costUsd");
  });
});

describe("check() purity", () => {
  it("does not mutate state and does not fire onExhausted", () => {
    const fn = vi.fn();
    const b = createBudget({ maxToolCalls: 1, onExhausted: fn });
    const before = JSON.stringify(b.snapshot());
    const r = b.check({ kind: "tool" });
    expect(r.allowed).toBe(true);
    const blocked = b.check({ kind: "tool" });
    expect(blocked.allowed).toBe(true); // still 0 recorded; check never counts
    expect(JSON.stringify(b.snapshot())).toBe(before);
    expect(fn).not.toHaveBeenCalled();
  });
});

describe("reset, remaining, snapshot", () => {
  it("reset restores full remaining", () => {
    const b = createBudget({ maxCostUsd: 5, maxToolCalls: 10 });
    b.record({ kind: "tool", costUsd: 5 });
    expect(b.snapshot().remaining.costUsd).toBe(0);
    b.reset();
    expect(b.snapshot().remaining.costUsd).toBe(5);
    expect(b.snapshot().remaining.toolCalls).toBe(10);
    expect(b.snapshot().spent.costUsd).toBe(0);
  });

  it("unconfigured dimensions report Infinity remaining", () => {
    const b = createBudget({});
    const r = b.snapshot().remaining;
    expect(r.costUsd).toBe(Infinity);
    expect(r.toolCalls).toBe(Infinity);
    expect(r.externalWrites).toBe(Infinity);
    expect(r.rates).toEqual({});
  });

  it("snapshot carries spent, remaining, and scope", () => {
    const b = createBudget({ maxCostUsd: 5, scope: "task-123" });
    b.record({ kind: "tool", costUsd: 1.5 });
    const s = b.snapshot();
    expect(s.scope).toBe("task-123");
    expect(s.spent.costUsd).toBe(1.5);
    expect(s.spent.toolCalls).toBe(1);
    expect(s.remaining.costUsd).toBe(3.5);
  });

  it("defaults scope to 'default'", () => {
    expect(createBudget({}).snapshot().scope).toBe("default");
  });
});

describe("JSONL audit log", () => {
  it("appends one parseable line per record with scope", () => {
    const dir = mkdtempSync(join(tmpdir(), "spendcap-"));
    const file = join(dir, "nested", "spend.jsonl");
    const b = createBudget({ scope: "task-9", logJsonl: file });
    b.record({ kind: "tool", costUsd: 0.02 });
    b.record({ kind: "financial", rateKeys: ["financialPerHour"] });
    const lines = readFileSync(file, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0]);
    expect(first.scope).toBe("task-9");
    expect(first.kind).toBe("tool");
    expect(first.costUsd).toBe(0.02);
    expect(typeof first.ts).toBe("number");
    const second = JSON.parse(lines[1]);
    expect(second.rateKeys).toEqual(["financialPerHour"]);
  });
});
