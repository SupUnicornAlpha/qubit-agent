import { verifyEvidenceChecksum } from "../src/runtime/research-program/evidence-checksum";

const path = process.argv[2];
if (!path) throw new Error("Usage: bun scripts/verify-research-evidence.ts <evidence.json>");
const value: unknown = await Bun.file(path).json();
if (!verifyEvidenceChecksum(value)) {
  console.error("证据包格式或内容校验失败。");
  process.exitCode = 1;
} else {
  console.log("内容校验通过。这不证明来源身份、研究有效性、独立验证或交易资格。");
}
