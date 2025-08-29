import fs from "fs";
import crypto from "crypto";

export type TaskAttestation = {
  run_id: string;
  task_id: string;
  model: string;
  dataset_sha256: string;
  prompt_sha256: string;
  code_sha256: string;
  pass: boolean;
  timestamp: string;
};

type ChainLine = TaskAttestation & {
  idx: number;
  prevHash: string | null;
  hash: string;
};

const sha256 = (s: string) =>
  crypto.createHash("sha256").update(s).digest("hex");
const stable = (o: any) => JSON.stringify(sortObj(o));

function sortObj(obj: any): any {
  if (obj === null || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map(sortObj);
  return Object.keys(obj)
    .sort()
    .reduce((acc: any, k) => {
      acc[k] = sortObj(obj[k]);
      return acc;
    }, {});
}

export function startChain(path: string) {
  fs.writeFileSync(path, ""); // new file
}

export function appendRecord(
  path: string,
  rec: TaskAttestation,
  prevHash: string | null,
  idx: number
): string {
  const contentToHash = stable({ ...rec, prevHash }); // exclude idx/hash from the hash input
  const hash = sha256(contentToHash);
  const line: ChainLine = { ...rec, idx, prevHash, hash };
  fs.appendFileSync(path, JSON.stringify(line) + "\n");
  return hash;
}
