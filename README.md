# prompt-to-proof

Open, practical tools to understand LLM streaming & sampling and run a reproducible mini-eval with hash-attested results.

> Measure → Evaluate → Prove.  
> Streaming logger (TTFT & tokens/sec) + coding eval (pass@1 / pass@k) + tamper-evident receipts.

---

## Requirements

- Node **18+**
- A model endpoint:
  - OpenAI-compatible hosted API (e.g., OpenAI), or
  - Local OpenAI-compatible server (vLLM / llama.cpp)

---

## Quickstart — Streaming (TTFT + tokens/sec)

1. `npm i`
2. Copy `.env.example` → `.env`, set `BASE_URL`, `API_KEY` (if hosted), and `MODEL`
3. Run:
   ```bash
   npm run stream -- "Explain recursion in one paragraph with a short JS example."
   ```

**This writes (Streaming):**

- `manifest.json` — model, tokenizer, sampling, prompt hash
- `results/run-*.json` — timings (`ttft_ms`, `generation_ms`), tokens (`input`/`output`/`total`), `rates.tokens_per_sec`, output text

> Note: TTFT varies with network/queue; `tokens/sec` is exact (via tiktoken).

| temp | top_p | TTFT (ms) | tokens/sec | note                    |
| ---: | ----: | --------: | ---------: | ----------------------- |
|  0.0 |   1.0 |     ~1205 |     ~57.25 | baseline, deterministic |
|  0.8 |   0.9 |      ~766 |     ~31.62 | creative phrasing       |

## Quickstart — Eval + Attestations

Run a deterministic eval (**k=1**), verify receipts, and print a summary row:

```bash
K_ATTEMPTS=1 npm run eval
npm run verify -- $(ls -t results/attest-*.jsonl | head -n1)
npm run summarize -- $(ls -t results/eval-*.json | head -n1)
```

**This writes (Eval + Attestations):**

- `results/eval-*.json` — per-task `attempts[]` with `latency_ms` and token counts, plus `totals` (**pass@1 / pass@k**)
- `results/attest-*.jsonl` — **hash-chained receipts** (one JSON line per task)
- The verifier prints `Attestation OK ✓` when the chain is intact

### Results (v0.2 — 16 tasks, deterministic eval: temp=0, top_p=1, k=1)

| model       | setting              | pass@1 | pass@k | median task latency | avg tokens (in / out) |
| ----------- | -------------------- | ------ | ------ | ------------------- | --------------------- |
| GPT-4o-mini | temp=0, top_p=1, k=1 | 16/16  | 16/16  | ~3145 ms            | ~25 / ~75             |
| GPT-4o      | temp=0, top_p=1, k=1 | 16/16  | 16/16  | ~1573 ms            | ~25 / ~79             |

**Notes**

- Both models pass all 16 tasks on the first attempt (**pass@1 = 16/16**).
- GPT-4o shows lower median latency than GPT-4o-mini on this suite (~1.6s vs ~3.1s in latest runs).
- Output token lengths are similar (GPT-4o slightly longer on average).
