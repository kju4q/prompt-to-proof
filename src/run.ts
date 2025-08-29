import "dotenv/config";
import fs from "fs";
import vm from "node:vm";
import crypto from "crypto";
import { z } from "zod";
import { startChain, appendRecord } from "./attest";

// --- env & guards ---
const BASE_URL = process.env.BASE_URL || "https://api.openai.com/v1";
const API_KEY = process.env.API_KEY || process.env.OPENAI_API_KEY || "";
const MODEL = process.env.MODEL || "";
if (!MODEL) throw new Error("MODEL required");
if (!API_KEY && !/^https?:\/\/localhost/.test(BASE_URL)) {
  throw new Error("API_KEY required for hosted APIs");
}

// --- dataset load & schema ---
const tasksSchema = z.array(
  z.object({
    id: z.string(),
    prompt: z.string(),
    tests: z.array(z.string()).min(1),
  })
);
const datasetRaw = fs.readFileSync("data/tasks.json", "utf-8");
const tasks = tasksSchema.parse(JSON.parse(datasetRaw));

// --- helpers ---
const hash = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
const dataset_sha256 = hash(datasetRaw);
const systemPreamble =
  "You are a helpful coding assistant. Return ONLY a JavaScript function that solves the task. " +
  "No explanations. Wrap the solution in a single ```javascript code block.";

// --- attestation setup ---
const runId = String(Date.now());
fs.mkdirSync("results", { recursive: true });
const attestPath = `results/attest-${runId}.jsonl`;
startChain(attestPath);
let prevHash: string | null = null;
let idx = 0;

// --- API call (deterministic for evals) ---
async function chat(userPrompt: string) {
  const body = {
    model: MODEL,
    temperature: 0, // reproducible
    top_p: 1,
    max_tokens: 256,
    messages: [
      { role: "system", content: systemPreamble },
      { role: "user", content: userPrompt },
    ],
  };
  const res = await fetch(`${BASE_URL.replace(/\/+$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(API_KEY ? { Authorization: `Bearer ${API_KEY}` } : {}),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  const json: any = await res.json();
  return String(json.choices?.[0]?.message?.content || "");
}

// --- code extraction & sandboxed testing ---
function extractCode(md: string) {
  const m = md.match(/```(?:javascript|js)?\s*([\s\S]*?)```/i);
  return (m ? m[1] : md).trim();
}

function runInSandbox(code: string, testExpr: string): boolean {
  const ctx: any = { console: { log: () => {} } };
  vm.createContext(ctx);
  new vm.Script(code, { timeout: 1000 }).runInContext(ctx, { timeout: 1000 });
  const result = new vm.Script(testExpr, { timeout: 1000 }).runInContext(ctx, {
    timeout: 1000,
  });
  return Boolean(result);
}

// --- main loop ---
const startedAt = new Date().toISOString();
const results: any[] = [];
let passCount = 0;

for (const t of tasks) {
  const completion = await chat(t.prompt);
  const code = extractCode(completion);

  let allPass = true;
  const verdicts: { test: string; pass: boolean }[] = [];

  for (const test of t.tests) {
    let ok = false;
    try {
      ok = runInSandbox(code, test);
    } catch {
      ok = false;
    }
    verdicts.push({ test, pass: ok });
    if (!ok) allPass = false;
  }

  if (allPass) passCount++;

  // record per-task result in summary
  results.push({
    id: t.id,
    prompt_sha256: hash(t.prompt),
    code_sha256: hash(code),
    pass: allPass,
    verdicts,
  });

  // append attestation record (tamper-evident)
  prevHash = appendRecord(
    attestPath,
    {
      run_id: runId,
      task_id: t.id,
      model: MODEL,
      dataset_sha256,
      prompt_sha256: hash(t.prompt),
      code_sha256: hash(code),
      pass: allPass,
      timestamp: new Date().toISOString(),
    },
    prevHash,
    idx++
  );

  process.stdout.write(`• ${t.id}: ${allPass ? "PASS" : "fail"}\n`);
}

// --- write summary ---
const summary = {
  run_id: runId,
  startedAt,
  finishedAt: new Date().toISOString(),
  model: MODEL,
  sampling: { temperature: 0, top_p: 1 },
  dataset_sha256,
  totals: { pass1: passCount, total: tasks.length },
  results,
  attestation_file: attestPath,
};

const out = `results/eval-${runId}.json`;
fs.writeFileSync(out, JSON.stringify(summary, null, 2));
console.log(
  `\npass@1: ${passCount}/${tasks.length}\nSaved: ${out}\nAttestations: ${attestPath}`
);
