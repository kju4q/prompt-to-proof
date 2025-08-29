import "dotenv/config";
import fs from "fs";
import crypto from "crypto";
import { get_encoding, type Tiktoken } from "@dqbd/tiktoken";

// ---------- helpers ----------
type Sampling = {
  temperature: number;
  top_p: number;
  max_new_tokens: number;
  seed?: number;
};
const nowISO = () => new Date().toISOString().replace(/[:.]/g, "-");
const sha256 = (s: string) =>
  crypto.createHash("sha256").update(s).digest("hex");
const trimSlash = (s: string) => s.replace(/\/+$/, "");

// choose tokenizer for exact token counts (override with TOKENIZER env)
function chooseEncoding(model: string): "o200k_base" | "cl100k_base" {
  if (/gpt-4o/i.test(model) || /-4o/i.test(model)) return "o200k_base";
  return "cl100k_base";
}

// ---------- inputs ----------
const prompt =
  process.argv.slice(2).join(" ") || "Write a 1-paragraph hello to the world.";
const sampling: Sampling = {
  temperature: Number(process.env.TEMPERATURE ?? 0),
  top_p: Number(process.env.TOP_P ?? 1),
  max_new_tokens: Number(process.env.MAX_NEW_TOKENS ?? 200),
  seed: process.env.SEED ? Number(process.env.SEED) : undefined,
};

const BASE_URL = process.env.BASE_URL || "https://api.openai.com/v1";
const API_KEY = process.env.API_KEY || process.env.OPENAI_API_KEY || "";
const MODEL = process.env.MODEL || "";
if (!MODEL) {
  console.error("Missing MODEL env var.");
  process.exit(1);
}
if (!API_KEY && !/^https?:\/\/localhost/.test(BASE_URL)) {
  console.error("Missing API_KEY (not required for some local servers).");
  process.exit(1);
}

fs.mkdirSync("results", { recursive: true });

// ---------- manifest ----------
const manifest = {
  model: MODEL,
  tokenizer: process.env.TOKENIZER || chooseEncoding(MODEL),
  sampling,
  prompt_sha256: sha256(prompt),
  env: { node: process.version },
  code_commit: "N/A",
  created_at: new Date().toISOString(),
};
fs.writeFileSync("manifest.json", JSON.stringify(manifest, null, 2));

// ---------- request (OpenAI-style) ----------
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
  Accept: "text/event-stream",
  ...(API_KEY ? { Authorization: `Bearer ${API_KEY}` } : {}),
};
if (BASE_URL.includes("openrouter.ai")) {
  if (process.env.HTTP_REFERER)
    headers["HTTP-Referer"] = process.env.HTTP_REFERER!;
  if (process.env.X_TITLE) headers["X-Title"] = process.env.X_TITLE!;
}

const url = `${trimSlash(BASE_URL)}/chat/completions`;

// ---------- streaming + timings (manual SSE parser) ----------
const t0 = Date.now();
let tFirst: number | null = null;
let text = "";

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
  let idx: number;
  // SSE events are separated by a blank line
  while ((idx = buf.indexOf("\n\n")) !== -1) {
    const evt = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 2);

    // process lines that start with `data: `
    const lines = evt.split("\n").filter((l) => l.startsWith("data: "));
    for (const line of lines) {
      const data = line.slice(6).trim();
      if (data === "[DONE]") {
        // finish
        buf = ""; // clear any remainder
        break;
      }
      try {
        const json = JSON.parse(data);
        // Chat Completions delta path (OpenAI-compatible)
        const delta =
          json?.choices?.[0]?.delta?.content ??
          // some servers might stream plain text field (rare)
          json?.choices?.[0]?.text ??
          "";

        if (delta) {
          if (tFirst === null) tFirst = Date.now();
          process.stdout.write(delta);
          text += delta;
        }
      } catch {
        // keepalives or comments; ignore
      }
    }
  }
}

const t1 = Date.now();

// ---------- exact token counts ----------
const encName =
  (process.env.TOKENIZER as "o200k_base" | "cl100k_base") ||
  chooseEncoding(MODEL);
const enc: Tiktoken = get_encoding(encName);
const input_tokens = enc.encode(prompt).length;
const output_tokens = enc.encode(text).length;
enc.free();

const ttft_ms = (tFirst ?? t1) - t0;
const gen_ms = t1 - (tFirst ?? t1);
const tokens_per_sec =
  gen_ms > 0 ? +(output_tokens / (gen_ms / 1000)).toFixed(2) : 0;

const summary = {
  prompt,
  model: MODEL,
  tokenizer: encName,
  sampling,
  timings: { ttft_ms, generation_ms: gen_ms, total_ms: t1 - t0 },
  tokens: {
    input: input_tokens,
    output: output_tokens,
    total: input_tokens + output_tokens,
  },
  rates: { tokens_per_sec },
  output: text,
};

const outPath = `results/run-${nowISO()}.json`;
fs.writeFileSync(outPath, JSON.stringify(summary, null, 2));
process.stdout.write(
  `\n\nSaved: ${outPath}\nTTFT: ${ttft_ms} ms | tokens/sec: ${tokens_per_sec}\n`
);
