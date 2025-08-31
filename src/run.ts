import "dotenv/config";
import fs from "fs";
import vm from "node:vm";
import crypto from "crypto";
import { z } from "zod";
import { startChain, appendRecord } from "./attest";
import { get_encoding, type Tiktoken } from "@dqbd/tiktoken";

// --- env & guards ---
const BASE_URL = process.env.BASE_URL || "https://api.openai.com/v1";
const API_KEY = process.env.API_KEY || process.env.OPENAI_API_KEY || "";
const MODEL = process.env.MODEL || "";
if (!MODEL) throw new Error("MODEL required");
if (!API_KEY && !/^https?:\/\/localhost/.test(BASE_URL)) {
  throw new Error("API_KEY required for hosted APIs");
}

// Attempts/temperature strategy
const K_ATTEMPTS = Number(process.env.K_ATTEMPTS ?? 1);
const EVAL_TEMPERATURE =
  K_ATTEMPTS === 1 ? 0 : Number(process.env.EVAL_TEMPERATURE ?? 0.7);
const EVAL_TOP_P =
  K_ATTEMPTS === 1 ? 1 : Number(process.env.EVAL_TOP_P ?? 0.95);

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

// tokenizer (for token counts)
function chooseEncoding(model: string): "o200k_base" | "cl100k_base" {
  if (/gpt-4o/i.test(model) || /-4o/i.test(model)) return "o200k_base";
  return "cl100k_base";
}
const encName =
  (process.env.TOKENIZER as "o200k_base" | "cl100k_base") ||
  chooseEncoding(MODEL);
const enc: Tiktoken = get_encoding(encName);

// --- attestation setup ---
const runId = String(Date.now());
fs.mkdirSync("results", { recursive: true });
const attestPath = `results/attest-${runId}.jsonl`;
startChain(attestPath);
let prevHash: string | null = null;
let idx = 0;

// --- API call (deterministic when K=1) ---
async function chat(userPrompt: string, seed?: number) {
  const body: any = {
    model: MODEL,
    temperature: EVAL_TEMPERATURE,
    top_p: EVAL_TOP_P,
    max_tokens: 256,
    messages: [
      { role: "system", content: systemPreamble },
      { role: "user", content: userPrompt },
    ],
  };
  if (seed !== undefined) body.seed = seed; // some providers honor this

  const t0 = Date.now();
  const res = await fetch(`${BASE_URL.replace(/\/+$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(API_KEY ? { Authorization: `Bearer ${API_KEY}` } : {}),
    },
    body: JSON.stringify(body),
  });
  const t1 = Date.now();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  const json: any = await res.json();
  const content = String(json.choices?.[0]?.message?.content || "");
  return { content, latency_ms: t1 - t0 };
}

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
let pass1 = 0;
let passk = 0;
let totalInputTokens = 0;
let totalOutputTokens = 0;
let totalLatencyMs = 0;

for (const t of tasks) {
  const attempts: any[] = [];
  let solved = false;
  let chosenCode = "";
  let firstAttemptPass = false;

  for (let a = 0; a < K_ATTEMPTS; a++) {
    const seed = process.env.SEED ? Number(process.env.SEED) + a : undefined;
    const { content, latency_ms } = await chat(t.prompt, seed);
    const code = extractCode(content);

    const inputTokens = enc.encode(t.prompt).length;
    const outputTokens = enc.encode(code).length;
    totalInputTokens += inputTokens;
    totalOutputTokens += outputTokens;
    totalLatencyMs += latency_ms;

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

    attempts.push({
      idx: a + 1,
      seed: seed ?? null,
      latency_ms,
      tokens: { input: inputTokens, output: outputTokens },
      pass: allPass,
    });

    if (a === 0 && allPass) firstAttemptPass = true;
    if (allPass) {
      solved = true;
      chosenCode = code;
      break;
    }
  }

  if (firstAttemptPass) pass1++;
  if (solved) passk++;

  // pick code hash: winning attempt’s code if solved; otherwise last attempt’s
  const codeHash = hash(chosenCode || extractCode(attempts.at(-1) ? "" : ""));

  // summary record
  results.push({
    id: t.id,
    prompt_sha256: hash(t.prompt),
    pass1: firstAttemptPass,
    passk: solved,
    attempts,
  });

  // attestation (one per task, final verdict)
  prevHash = appendRecord(
    attestPath,
    {
      run_id: runId,
      task_id: t.id,
      model: MODEL,
      dataset_sha256,
      prompt_sha256: hash(t.prompt),
      code_sha256: chosenCode ? hash(chosenCode) : "none",
      pass: solved,
      timestamp: new Date().toISOString(),
    },
    prevHash,
    idx++
  );

  process.stdout.write(
    `• ${t.id}: ${
      solved ? (firstAttemptPass ? "PASS@1" : "PASS@k") : "fail"
    } ` + `(k=${K_ATTEMPTS}, temp=${EVAL_TEMPERATURE}, top_p=${EVAL_TOP_P})\n`
  );
}

// --- write summary ---
enc.free();
const summary = {
  run_id: runId,
  startedAt,
  finishedAt: new Date().toISOString(),
  model: MODEL,
  sampling: { temperature: EVAL_TEMPERATURE, top_p: EVAL_TOP_P },
  dataset_sha256,
  k: K_ATTEMPTS,
  totals: {
    pass1,
    passk,
    total: tasks.length,
    latency_ms: totalLatencyMs,
    tokens: {
      input: totalInputTokens,
      output: totalOutputTokens,
      total: totalInputTokens + totalOutputTokens,
    },
  },
  tokenizer: encName,
  results,
  attestation_file: attestPath,
};

const out = `results/eval-${runId}.json`;
fs.writeFileSync(out, JSON.stringify(summary, null, 2));
console.log(
  `\npass@1: ${pass1}/${tasks.length} | pass@${K_ATTEMPTS}: ${passk}/${tasks.length}`
);
console.log(`Saved: ${out}\nAttestations: ${attestPath}`);
