import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type UsageKind = "tool" | "financial" | "email" | "external-write";

export interface Remaining {
  costUsd: number;
  toolCalls: number;
  externalWrites: number;
  rates: Record<string, number>;
}

export interface ExhaustedEvent {
  reason: string;
  dimension: string;
  remaining: Remaining;
}

export interface BudgetConfig {
  maxCostUsd?: number;
  maxToolCalls?: number;
  maxExternalWrites?: number;
  /** name -> max events per window, e.g. { refundsPerHour: 5 } */
  rates?: Record<string, number>;
  /** sliding window length in ms for all named rates; default 3_600_000 (1 hour) */
  rateWindowMs?: number;
  scope?: string;
  onExhausted?: (e: ExhaustedEvent) => void;
  /** optional path for an append-only JSONL audit log */
  logJsonl?: string;
  /** injectable clock, used by tests to control time */
  now?: () => number;
}

export interface Usage {
  kind: UsageKind;
  costUsd?: number;
  /** which named rates this event counts toward */
  rateKeys?: string[];
}

export interface CheckResult {
  allowed: boolean;
  reason?: string;
  remaining: Remaining;
}

export interface BudgetSnapshot {
  spent: {
    costUsd: number;
    toolCalls: number;
    externalWrites: number;
    rates: Record<string, number>;
  };
  remaining: Remaining;
  scope: string;
}

export interface Budget {
  /** Pure: evaluates whether the usage fits the budget without mutating state. */
  check(usage: Usage): CheckResult;
  /** Mutates counters, appends the JSONL audit line, fires onExhausted when a dimension hits its cap. */
  record(usage: Usage): void;
  snapshot(): BudgetSnapshot;
  /** Zeroes all counters and clears fired onExhausted flags. The JSONL log is append-only and is not cleared. */
  reset(): void;
}

const DEFAULT_RATE_WINDOW_MS = 3_600_000;
const DEFAULT_SCOPE = "default";

/** Round to cents for human-readable reason strings. */
const fmt = (n: number): string => String(Math.round(n * 100) / 100);

export function createBudget(config: BudgetConfig = {}): Budget {
  const maxCostUsd = config.maxCostUsd;
  const maxToolCalls = config.maxToolCalls;
  const maxExternalWrites = config.maxExternalWrites;
  const rates: Record<string, number> = config.rates ?? {};
  const rateWindowMs = config.rateWindowMs ?? DEFAULT_RATE_WINDOW_MS;
  const scope = config.scope ?? DEFAULT_SCOPE;
  const onExhausted = config.onExhausted;
  const logJsonl = config.logJsonl;
  const now = config.now ?? (() => Date.now());

  let spentCost = 0;
  let toolCalls = 0;
  let externalWrites = 0;
  const rateEvents: Record<string, number[]> = {};
  for (const name of Object.keys(rates)) rateEvents[name] = [];
  const fired = new Set<string>();

  /** Count of events for a rate name inside the sliding window. Pure, no mutation. */
  function rateCount(name: string): number {
    const cutoff = now() - rateWindowMs;
    const arr = rateEvents[name];
    if (!arr) return 0;
    let n = 0;
    for (const t of arr) if (t >= cutoff) n++;
    return n;
  }

  function remaining(): Remaining {
    const r: Record<string, number> = {};
    for (const name of Object.keys(rates)) {
      r[name] = Math.max(0, rates[name] - rateCount(name));
    }
    return {
      costUsd: maxCostUsd === undefined ? Infinity : Math.max(0, maxCostUsd - spentCost),
      toolCalls:
        maxToolCalls === undefined ? Infinity : Math.max(0, maxToolCalls - toolCalls),
      externalWrites:
        maxExternalWrites === undefined
          ? Infinity
          : Math.max(0, maxExternalWrites - externalWrites),
      rates: r,
    };
  }

  function check(usage: Usage): CheckResult {
    const cost = usage.costUsd ?? 0;

    if (maxCostUsd !== undefined && spentCost + cost > maxCostUsd) {
      return {
        allowed: false,
        reason: `maxCostUsd exceeded (spent ${fmt(spentCost + cost)} / cap ${fmt(maxCostUsd)})`,
        remaining: remaining(),
      };
    }
    if (usage.kind === "tool" && maxToolCalls !== undefined && toolCalls + 1 > maxToolCalls) {
      return {
        allowed: false,
        reason: `maxToolCalls exceeded (${toolCalls + 1} / cap ${maxToolCalls})`,
        remaining: remaining(),
      };
    }
    if (
      usage.kind === "external-write" &&
      maxExternalWrites !== undefined &&
      externalWrites + 1 > maxExternalWrites
    ) {
      return {
        allowed: false,
        reason: `maxExternalWrites exceeded (${externalWrites + 1} / cap ${maxExternalWrites})`,
        remaining: remaining(),
      };
    }
    for (const key of usage.rateKeys ?? []) {
      const limit = rates[key];
      if (limit === undefined) continue;
      const wouldBe = rateCount(key) + 1;
      if (wouldBe > limit) {
        return {
          allowed: false,
          reason: `rate "${key}" exceeded (${wouldBe} / ${limit} per ${rateWindowMs}ms)`,
          remaining: remaining(),
        };
      }
    }
    return { allowed: true, remaining: remaining() };
  }

  function exhaustedDimensions(): Array<{ dimension: string; reason: string }> {
    const out: Array<{ dimension: string; reason: string }> = [];
    if (maxCostUsd !== undefined && spentCost >= maxCostUsd) {
      out.push({
        dimension: "costUsd",
        reason: `maxCostUsd exceeded (spent ${fmt(spentCost)} / cap ${fmt(maxCostUsd)})`,
      });
    }
    if (maxToolCalls !== undefined && toolCalls >= maxToolCalls) {
      out.push({
        dimension: "toolCalls",
        reason: `maxToolCalls exceeded (${toolCalls} / cap ${maxToolCalls})`,
      });
    }
    if (maxExternalWrites !== undefined && externalWrites >= maxExternalWrites) {
      out.push({
        dimension: "externalWrites",
        reason: `maxExternalWrites exceeded (${externalWrites} / cap ${maxExternalWrites})`,
      });
    }
    for (const name of Object.keys(rates)) {
      const count = rateCount(name);
      if (count >= rates[name]) {
        out.push({
          dimension: `rate:${name}`,
          reason: `rate "${name}" exhausted (${count} / ${rates[name]} per ${rateWindowMs}ms)`,
        });
      }
    }
    return out;
  }

  function record(usage: Usage): void {
    const t = now();
    const cost = usage.costUsd ?? 0;
    spentCost += cost;
    if (usage.kind === "tool") toolCalls += 1;
    // external-writes counts ONLY kind === "external-write". "financial" and
    // "email" are their own kinds; gate them with named rates instead.
    if (usage.kind === "external-write") externalWrites += 1;
    for (const key of usage.rateKeys ?? []) {
      if (rates[key] === undefined) continue;
      const arr = rateEvents[key] ?? (rateEvents[key] = []);
      arr.push(t);
    }
    // Bound memory: drop timestamps that fell out of the window.
    const cutoff = t - rateWindowMs;
    for (const name of Object.keys(rateEvents)) {
      rateEvents[name] = rateEvents[name].filter((ts) => ts >= cutoff);
    }
    if (logJsonl) {
      mkdirSync(dirname(logJsonl), { recursive: true });
      appendFileSync(
        logJsonl,
        JSON.stringify({
          ts: t,
          scope,
          kind: usage.kind,
          costUsd: cost,
          rateKeys: usage.rateKeys ?? [],
        }) + "\n",
      );
    }
    if (onExhausted) {
      const rem = remaining();
      for (const { dimension, reason } of exhaustedDimensions()) {
        if (fired.has(dimension)) continue;
        fired.add(dimension);
        onExhausted({ reason, dimension, remaining: rem });
      }
    }
  }

  function snapshot(): BudgetSnapshot {
    const spentRates: Record<string, number> = {};
    for (const name of Object.keys(rates)) spentRates[name] = rateCount(name);
    return {
      spent: { costUsd: spentCost, toolCalls, externalWrites, rates: spentRates },
      remaining: remaining(),
      scope,
    };
  }

  function reset(): void {
    spentCost = 0;
    toolCalls = 0;
    externalWrites = 0;
    for (const name of Object.keys(rateEvents)) rateEvents[name] = [];
    fired.clear();
  }

  return { check, record, snapshot, reset };
}
