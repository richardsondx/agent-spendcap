import { createBudget } from "../src/index.js";

console.log("=== 1. cost budget ===");
const budget = createBudget({ maxCostUsd: 5, scope: "demo-task" });
for (let i = 1; i <= 7; i++) {
  const r = budget.check({ kind: "tool", costUsd: 0.8 });
  if (!r.allowed) {
    console.log(`call ${i}: BLOCKED  ${r.reason}`);
    break;
  }
  budget.record({ kind: "tool", costUsd: 0.8 });
  console.log(
    `call ${i}: allowed   spent $${budget.snapshot().spent.costUsd.toFixed(2)}  ` +
      `remaining $${budget.snapshot().remaining.costUsd.toFixed(2)}`,
  );
}

console.log("");
console.log("=== 2. financialPerHour rate ===");
const hourly = createBudget({ rates: { financialPerHour: 5 }, scope: "demo-task" });
for (let i = 1; i <= 6; i++) {
  const r = hourly.check({ kind: "financial", rateKeys: ["financialPerHour"] });
  if (!r.allowed) {
    console.log(`financial action ${i}: BLOCKED  ${r.reason}`);
    break;
  }
  hourly.record({ kind: "financial", rateKeys: ["financialPerHour"] });
  console.log(
    `financial action ${i}: allowed   ${hourly.snapshot().remaining.rates.financialPerHour} of 5 left this hour`,
  );
}
