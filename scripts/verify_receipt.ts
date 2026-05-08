#!/usr/bin/env npx ts-node
/**
 * HXQ-Solana Receipt Verifier
 *
 * Offline verification of receipt JSON files. Does not contact Solana RPC.
 * Checks structural integrity, required fields, tx signatures, receipt hashes,
 * rejection error messages, and pass/fail status.
 *
 * Usage:
 *   npx ts-node scripts/verify_receipt.ts receipts/hxq_solana_lifecycle_demo_20260508.json
 *   npx ts-node scripts/verify_receipt.ts receipts/domain_fixture_demos_20260508.json
 */

const fs = require("fs");
const path = require("path");

const EXPECTED_PROGRAM_ID = "EnDRZxswjvqKQhnPuMY6m6AFK3sxCKRX2dokXxAYPYrP";

// 64-char hex string (32 bytes)
const HEX32_RE = /^[0-9a-f]{64}$/;
// Solana base58 tx signature (typically 87-88 chars)
const TX_SIG_RE = /^[1-9A-HJ-NP-Za-km-z]{43,}$/;

interface CheckResult {
  name: string;
  pass: boolean;
  detail?: string;
}

function check(name: string, condition: boolean, detail?: string): CheckResult {
  return { name, pass: condition, detail: condition ? undefined : detail };
}

function isHex32(v: any): boolean {
  return typeof v === "string" && HEX32_RE.test(v);
}

function isTxSig(v: any): boolean {
  return typeof v === "string" && TX_SIG_RE.test(v);
}

function isNonEmptyString(v: any): boolean {
  return typeof v === "string" && v.length > 0;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Lifecycle demo receipt verifier
// ═══════════════════════════════════════════════════════════════════════════════

function verifyLifecycle(receipt: any): CheckResult[] {
  const checks: CheckResult[] = [];

  // Top-level fields
  checks.push(check("demo field", receipt.demo === "HXQ_SOLANA_LIFECYCLE_DEMO_V0",
    `expected HXQ_SOLANA_LIFECYCLE_DEMO_V0, got ${receipt.demo}`));
  checks.push(check("program_id", receipt.program_id === EXPECTED_PROGRAM_ID,
    `expected ${EXPECTED_PROGRAM_ID}, got ${receipt.program_id}`));
  checks.push(check("git_commit present", isNonEmptyString(receipt.git_commit),
    "missing git_commit"));
  checks.push(check("timestamp_start present", isNonEmptyString(receipt.timestamp_start)));
  checks.push(check("timestamp_end present", isNonEmptyString(receipt.timestamp_end)));
  checks.push(check("all_pass is true", receipt.all_pass === true,
    `all_pass = ${receipt.all_pass}`));

  // Hashes
  checks.push(check("content_hash is 32-byte hex", isHex32(receipt.content_hash),
    `got: ${receipt.content_hash}`));
  checks.push(check("original_hash is 32-byte hex", isHex32(receipt.original_hash)));
  checks.push(check("fidelity_receipt_hash is 32-byte hex", isHex32(receipt.fidelity_receipt_hash)));
  checks.push(check("behavioral_receipt_hash is 32-byte hex", isHex32(receipt.behavioral_receipt_hash)));
  checks.push(check("risk_attestation_hash is 32-byte hex", isHex32(receipt.risk_attestation_hash)));

  // PDAs
  checks.push(check("asset_pda present", isNonEmptyString(receipt.asset_pda)));

  // Steps
  const steps = receipt.steps;
  checks.push(check("steps is array", Array.isArray(steps), "steps missing or not array"));

  if (Array.isArray(steps)) {
    checks.push(check(`step count >= 9`, steps.length >= 9,
      `expected >= 9 steps, got ${steps.length}`));

    // All steps pass
    for (const step of steps) {
      checks.push(check(`step ${step.step} (${step.name}) pass`, step.pass === true,
        `step ${step.step} pass = ${step.pass}`));
    }

    // Steps with tx signatures should have valid sigs
    const txSteps = steps.filter((s: any) => s.tx !== null);
    for (const step of txSteps) {
      checks.push(check(`step ${step.step} tx signature valid`, isTxSig(step.tx),
        `step ${step.step} tx = ${step.tx}`));
    }

    // Rejection steps should have error messages
    const rejectionSteps = steps.filter((s: any) => s.name.includes("REJECTED"));
    checks.push(check("rejection steps exist", rejectionSteps.length >= 2,
      `expected >= 2 rejection steps, got ${rejectionSteps.length}`));

    const badPromotion = steps.find((s: any) => s.name === "promote_asset_REJECTED");
    if (badPromotion) {
      checks.push(check("bad promotion has FidelityBelowThreshold error",
        typeof badPromotion.error === "string" && /FidelityBelowThreshold|0x1776/i.test(badPromotion.error),
        `error: ${(badPromotion.error || "").slice(0, 80)}`));
    } else {
      checks.push(check("bad promotion step exists", false, "promote_asset_REJECTED step not found"));
    }

    const quarantineReject = steps.find((s: any) => s.name === "transfer_quarantined_REJECTED");
    if (quarantineReject) {
      checks.push(check("quarantined transfer has AssetNotActive error",
        typeof quarantineReject.error === "string" && /AssetNotActive|0x1772/i.test(quarantineReject.error),
        `error: ${(quarantineReject.error || "").slice(0, 80)}`));
    } else {
      checks.push(check("quarantined transfer step exists", false, "transfer_quarantined_REJECTED step not found"));
    }
  }

  // Final state
  checks.push(check("final_state present", receipt.final_state != null));
  if (receipt.final_state) {
    checks.push(check("final_state.status is Active", receipt.final_state.status === "Active",
      `got: ${receipt.final_state.status}`));
    checks.push(check("final_state.transfer_count >= 1", receipt.final_state.transfer_count >= 1,
      `got: ${receipt.final_state.transfer_count}`));
    checks.push(check("final_state has receipts",
      receipt.final_state.has_fidelity && receipt.final_state.has_behavioral && receipt.final_state.has_risk,
      "missing receipt flags"));
  }

  return checks;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Domain fixture demos receipt verifier
// ═══════════════════════════════════════════════════════════════════════════════

function verifyDomainFixtures(receipt: any): CheckResult[] {
  const checks: CheckResult[] = [];

  // Top-level fields
  checks.push(check("demo field", receipt.demo === "HXQ_SOLANA_DOMAIN_FIXTURE_DEMOS_V0",
    `expected HXQ_SOLANA_DOMAIN_FIXTURE_DEMOS_V0, got ${receipt.demo}`));
  checks.push(check("program_id", receipt.program_id === EXPECTED_PROGRAM_ID,
    `expected ${EXPECTED_PROGRAM_ID}, got ${receipt.program_id}`));
  checks.push(check("git_commit present", isNonEmptyString(receipt.git_commit)));
  checks.push(check("timestamp_start present", isNonEmptyString(receipt.timestamp_start)));
  checks.push(check("timestamp_end present", isNonEmptyString(receipt.timestamp_end)));
  checks.push(check("all_pass is true", receipt.all_pass === true,
    `all_pass = ${receipt.all_pass}`));

  // Domains
  const domains = receipt.domains;
  checks.push(check("domains is array", Array.isArray(domains)));
  checks.push(check("domains_tested >= 3", receipt.domains_tested >= 3,
    `got: ${receipt.domains_tested}`));

  if (!Array.isArray(domains)) return checks;

  const expectedTypes = ["legal_document", "medical_record", "scientific_compute"];
  const foundTypes = domains.map((d: any) => d.artifact_type);
  for (const expected of expectedTypes) {
    checks.push(check(`domain ${expected} present`, foundTypes.includes(expected),
      `missing ${expected}`));
  }

  for (const domain of domains) {
    const t = domain.artifact_type;

    // Pass
    checks.push(check(`${t}: all_pass`, domain.all_pass === true,
      `${t} all_pass = ${domain.all_pass}`));

    // Hashes
    checks.push(check(`${t}: content_hash`, isHex32(domain.content_hash)));
    checks.push(check(`${t}: original_hash`, isHex32(domain.original_hash)));
    checks.push(check(`${t}: fidelity_receipt_hash`, isHex32(domain.fidelity_receipt_hash)));
    checks.push(check(`${t}: behavioral_receipt_hash`, isHex32(domain.behavioral_receipt_hash)));
    checks.push(check(`${t}: risk_attestation_hash`, isHex32(domain.risk_attestation_hash)));

    // PDAs
    checks.push(check(`${t}: asset_pda present`, isNonEmptyString(domain.asset_pda)));
    checks.push(check(`${t}: quarantine_pda present`, isNonEmptyString(domain.quarantine_pda)));

    // Tx signatures
    const txFields = ["register_tx", "fidelity_tx", "behavioral_tx", "promote_tx",
                      "risk_tx", "transfer_tx", "quarantine_tx"];
    for (const field of txFields) {
      checks.push(check(`${t}: ${field} valid`, isTxSig(domain[field]),
        `${field} = ${domain[field]}`));
    }

    // Quarantine rejection
    checks.push(check(`${t}: quarantine transfer rejected`,
      typeof domain.quarantine_transfer_rejected_error === "string" &&
      /AssetNotActive|0x1772/i.test(domain.quarantine_transfer_rejected_error),
      `error: ${(domain.quarantine_transfer_rejected_error || "").slice(0, 80)}`));
  }

  return checks;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Main
// ═══════════════════════════════════════════════════════════════════════════════

function detectType(receipt: any): string | null {
  if (receipt.demo === "HXQ_SOLANA_LIFECYCLE_DEMO_V0") return "lifecycle_demo";
  if (receipt.demo === "HXQ_SOLANA_DOMAIN_FIXTURE_DEMOS_V0") return "domain_fixture_demos";
  return null;
}

function verifyReceipt(receiptPath: string): { checks: CheckResult[]; allPass: boolean } {
  const raw = fs.readFileSync(receiptPath, "utf-8");
  const receipt = JSON.parse(raw);

  const receiptType = detectType(receipt);
  if (!receiptType) {
    return {
      checks: [check("receipt type recognized", false, `unknown demo field: ${receipt.demo}`)],
      allPass: false,
    };
  }

  const checks = receiptType === "lifecycle_demo"
    ? verifyLifecycle(receipt)
    : verifyDomainFixtures(receipt);

  return { checks, allPass: checks.every(c => c.pass) };
}

module.exports = { verifyReceipt };

// CLI entry point
if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error("Usage: npx ts-node scripts/verify_receipt.ts <receipt.json> [receipt2.json ...]");
    process.exit(1);
  }

  let allFilesPass = true;

  for (const receiptPath of args) {
    const resolved = path.resolve(receiptPath);
    if (!fs.existsSync(resolved)) {
      console.error(`File not found: ${resolved}`);
      allFilesPass = false;
      continue;
    }

    const raw = JSON.parse(fs.readFileSync(resolved, "utf-8"));
    const receiptType = detectType(raw);

    console.log("HXQ-Solana Receipt Verifier\n");
    console.log(`receipt: ${receiptPath}`);
    console.log(`type:    ${receiptType || "UNKNOWN"}`);
    console.log("");

    const { checks, allPass } = verifyReceipt(resolved);

    let lastGroup = "";
    for (const c of checks) {
      // Group by domain prefix for domain fixtures
      const match = c.name.match(/^(\w+):/);
      const group = match ? match[1] : "";
      if (group && group !== lastGroup) {
        console.log(`  --- ${group} ---`);
        lastGroup = group;
      }
      const status = c.pass ? "PASS" : "FAIL";
      const detail = c.detail ? ` (${c.detail})` : "";
      console.log(`  ${status} ${c.name}${detail}`);
    }

    const passCount = checks.filter(c => c.pass).length;
    const failCount = checks.filter(c => !c.pass).length;

    console.log("");
    console.log(`RESULT: ${allPass ? "PASS" : "FAIL"} (${passCount} passed, ${failCount} failed)`);
    console.log("");

    if (!allPass) allFilesPass = false;
  }

  process.exit(allFilesPass ? 0 : 1);
}
