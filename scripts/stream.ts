import "dotenv/config";
import fs from "fs";
import crypto from "crypto";

type Sampling = {
  temperature: number;
  top_p: number;
  max_new_tokens: number;
  seed?: number;
};
const nowISO = () => new Date().toISOString().replace(/[:.]/g, "-");
const sha256 = (s: string) =>
  crypto.createHash("sha256").update(s).digest("hex");

// --- prompt & sampling from CLI/env ---
const prompt =
  process.argv.slice(2).join(" ") || "Write a 1-paragraph hello to the world.";
const sampling: Sampling = {
  temperature: Number(process.env.TEMPERATURE ?? 0),
  top_p: Number(process.env.TOP_P ?? 1),
  max_new_tokens: Number(process.env.MAX_NEW_TOKENS ?? 200),
  seed: process.env.SEED ? Number(process.env.SEED) : undefined,
};

// --- env ---
const BASE_URL = process.env.BASE_URL || "https://api.openai.com/v1";
const API_KEY = process.env.API_KEY || "";
const MODEL = process.env.MODEL || "";
if (!API_KEY || !MODEL) {
  console.error("Missing API_KEY or MODEL env vars.");
  process.exit(1);
}

// outputs
fs.mkdirSync("results", { recursive: true });

// --- manifest (save once per run) ---
const manifest = {
  model: MODEL,
  tokenizer: "unknown@unknown",
  sampling,
  prompt_sha256: sha256(prompt),
  env: { node: process.version },
  code_commit: "N/A",
  created_at: new Date().toISOString(),
};
fs.writeFileSync("manifest.json", JSON.stringify(manifest, null, 2));

// request body (OpenAI-style)
const body = {
  model: MODEL,
  stream: true,
  temperature: sampling.temperature,
  top_p: sampling.top_p,
  max_tokens: sampling.max_new_tokens,
  seed: sampling.seed,
  messages: [{ role: "user", content: prompt }],
};

const headers: Record<string, string> = {
  "Content-Type": "application/json",
  Authorization: `Bearer ${API_KEY}`,
};
// OpenRouter headers if you use it
if (BASE_URL.includes("openrouter.ai")) {
  headers["HTTP-Referer"] = "https://example.com";
  headers["X-Title"] = "prompt-to-proof";
}

const url = `${BASE_URL}/chat/completions`;

// timing + accumulation
const t0 = Date.now();
let tFirst: number | null = null;
let text = "";
let chars = 0;

// simple SSE parser
async function streamAndLog() {
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  if (!res.ok || !res.body) {
    console.error("HTTP error", res.status, await res.text());
    process.exit(1);
  }
  const dec = new TextDecoder();
  let buf = "";

  for await (const chunk of res.body as any as AsyncIterable<Uint8Array>) {
    buf += dec.decode(chunk, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      const evt = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 2);
      const lines = evt.split("\n").filter((l) => l.startsWith("data: "));
      for (const line of lines) {
        const data = line.slice(6).trim();
        if (data === "[DONE]") return;
        try {
          const json = JSON.parse(data);
          const delta = json.choices?.[0]?.delta?.content ?? "";
          if (delta) {
            if (tFirst === null) tFirst = Date.now();
            process.stdout.write(delta);
            text += delta;
            chars += delta.length;
          }
        } catch {
          /* ignore keep-alives */
        }
      }
    }
  }
}

await streamAndLog();
const t1 = Date.now();

const ttft_ms = (tFirst ?? t1) - t0;
const gen_ms = t1 - (tFirst ?? t1);
const approx_tokens = Math.max(1, Math.round(chars / 4)); // rough estimate
const tokens_per_sec =
  gen_ms > 0 ? +(approx_tokens / (gen_ms / 1000)).toFixed(2) : approx_tokens;

const summary = {
  prompt,
  model: MODEL,
  sampling,
  timings: { ttft_ms, generation_ms: gen_ms, total_ms: t1 - t0 },
  sizes: { chars, approx_tokens },
  rates: { approx_tokens_per_sec: tokens_per_sec },
  output: text,
};

const out = `results/run-${nowISO()}.json`;
fs.writeFileSync(out, JSON.stringify(summary, null, 2));
process.stdout.write(
  `\n\nSaved: ${out}\nTTFT: ${ttft_ms} ms | ≈tokens/sec: ${tokens_per_sec}\n`
);
