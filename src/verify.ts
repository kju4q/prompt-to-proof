import fs from "fs";
import crypto from "crypto";

const sha256 = (s: string) =>
  crypto.createHash("sha256").update(s).digest("hex");
const stable = (o: any) => JSON.stringify(sortObj(o));
function sortObj(obj: any): any {
  if (obj === null || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map(sortObj);
  return Object.keys(obj)
    .sort()
    .reduce((a: any, k) => {
      a[k] = sortObj(obj[k]);
      return a;
    }, {});
}

const file = process.argv[2];
if (!file) {
  console.error("Usage: npm run verify -- results/attest-<timestamp>.jsonl");
  process.exit(1);
}
if (!fs.existsSync(file)) {
  console.error("File not found:", file);
  process.exit(1);
}

const lines = fs.readFileSync(file, "utf-8").trim().split("\n").filter(Boolean);
let prevHash: string | null = null;
for (let i = 0; i < lines.length; i++) {
  const line = JSON.parse(lines[i]);
  const { hash, idx, prevHash: declaredPrev, ...rest } = line;
  if (declaredPrev !== prevHash) {
    console.error(`Chain break at idx ${idx}: prevHash mismatch`);
    process.exit(1);
  }
  const recomputed = sha256(stable({ ...rest, prevHash }));
  if (recomputed !== hash) {
    console.error(`Hash mismatch at idx ${idx}`);
    process.exit(1);
  }
  prevHash = hash;
}
console.log(`Attestation OK ✓  (${lines.length} records)\nFile: ${file}`);
