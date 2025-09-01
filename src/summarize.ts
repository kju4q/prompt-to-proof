import fs from "fs";

function median(ns: number[]) {
  if (!ns.length) return 0;
  const a = [...ns].sort((x, y) => x - y);
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : Math.round((a[m - 1] + a[m]) / 2);
}

const file = process.argv[2];
if (!file || !fs.existsSync(file)) {
  console.error("Usage: npm run summarize -- results/eval-<id>.json");
  process.exit(1);
}

const run = JSON.parse(fs.readFileSync(file, "utf-8"));
const total = run.totals?.total ?? run.results?.length ?? 0;
const pass1 = run.totals?.pass1 ?? 0;
const passk = run.totals?.passk ?? pass1;
const toksTotals = run.totals?.tokens ?? { input: 0, output: 0, total: 0 };
const model = run.model ?? "unknown";
const k = run.k ?? 1;
const temp = run.sampling?.temperature ?? "?";
const top_p = run.sampling?.top_p ?? "?";

// Pull per-task latency from either shape:
// - old: r.latency_ms
// - new: r.attempts[0].latency_ms  (first attempt)
const latencies: number[] = (run.results ?? []).map((r: any) => {
  if (typeof r?.latency_ms === "number") return r.latency_ms;
  if (Array.isArray(r?.attempts) && r.attempts[0]?.latency_ms != null)
    return r.attempts[0].latency_ms;
  return 0;
});

const medLatency = median(latencies);
const avgIn = total ? Math.round(toksTotals.input / total) : 0;
const avgOut = total ? Math.round(toksTotals.output / total) : 0;

const row = `| ${model} | temp=${temp}, top_p=${top_p}, k=${k} | ${pass1}/${total} | ${passk}/${total} | ~${medLatency} ms | ~${avgIn} / ~${avgOut} |`;
console.log(row);
