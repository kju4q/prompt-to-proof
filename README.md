# prompt-to-proof

Tiny, open tools to understand LLM **streaming & sampling** and run a **reproducible** mini eval with **attestations**.

## Quickstart

1. `npm i`
2. copy `.env.example` → `.env` and fill your key + model
3. `npm run stream -- "Explain recursion in one paragraph with a tiny JS example."`

Outputs:

- `manifest.json` – model, tokenizer, seed, sampling, prompt hash
- `results/run-*.json` – TTFT, approx tokens/sec, output text

| temp | top_p | TTFT (ms) | tokens/sec | note                    |
| ---: | ----: | --------: | ---------: | ----------------------- |
|  0.0 |   1.0 |     ~1205 |     ~57.25 | baseline, deterministic |
|  0.8 |   0.9 |      ~766 |     ~31.62 | creative phrasing       |
