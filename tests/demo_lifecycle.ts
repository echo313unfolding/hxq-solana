/**
 * HXQ-Solana Lifecycle Demo
 *
 * Walks the full asset state machine with a deterministic tensor hash:
 *   1. Register asset as Candidate
 *   2. Submit fidelity receipt
 *   3. Submit behavioral receipt
 *   4. Attempt bad promotion (cosine < 0.998) — prove rejection
 *   5. Register good asset (cosine >= 0.998), submit receipts, promote → Active
 *   6. Submit risk attestation
 *   7. Transfer to new owner
 *   8. Quarantine a separate active asset
 *   9. Export JSON receipt
 */

const {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  Connection,
  sendAndConfirmTransaction,
} = require("@solana/web3.js");
const { expect } = require("chai");
const { createHash } = require("crypto");
const fs = require("fs");
const path = require("path");

const PROGRAM_ID = new PublicKey("EnDRZxswjvqKQhnPuMY6m6AFK3sxCKRX2dokXxAYPYrP");

const STATUS_CANDIDATE = 0;
const STATUS_ACTIVE = 1;
const STATUS_QUARANTINED = 2;

const STATUS_NAMES = { 0: "Candidate", 1: "Active", 2: "Quarantined" };

function ixDiscriminator(name: string): Buffer {
  return createHash("sha256").update(`global:${name}`).digest().slice(0, 8);
}

const IX_REGISTER_ASSET = ixDiscriminator("register_asset");
const IX_SUBMIT_FIDELITY = ixDiscriminator("submit_fidelity_receipt");
const IX_SUBMIT_BEHAVIORAL = ixDiscriminator("submit_behavioral_receipt");
const IX_SUBMIT_RISK = ixDiscriminator("submit_risk_attestation");
const IX_PROMOTE = ixDiscriminator("promote_asset");
const IX_QUARANTINE = ixDiscriminator("quarantine_asset");
const IX_TRANSFER = ixDiscriminator("transfer_asset");

function sha256Bytes(data: string): Buffer {
  return createHash("sha256").update(data).digest();
}

function findAssetPDA(contentHash: Buffer): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("hxq-asset"), contentHash],
    PROGRAM_ID
  );
}

function encodeF32(val: number): Buffer {
  const buf = Buffer.alloc(4);
  buf.writeFloatLE(val, 0);
  return buf;
}

function encodeU16(val: number): Buffer {
  const buf = Buffer.alloc(2);
  buf.writeUInt16LE(val, 0);
  return buf;
}

function buildRegisterData(
  contentHash: Buffer, originalHash: Buffer,
  codec: number, groupSize: number, bitsPerWeight: number,
  cosineMin: number, pplDeltaPct: number
): Buffer {
  return Buffer.concat([
    IX_REGISTER_ASSET,
    contentHash, originalHash,
    Buffer.from([codec]), encodeU16(groupSize), Buffer.from([bitsPerWeight]),
    encodeF32(cosineMin), encodeF32(pplDeltaPct),
  ]);
}

function buildReceiptData(discriminator: Buffer, receiptHash: Buffer): Buffer {
  return Buffer.concat([discriminator, receiptHash]);
}

function deserializeAsset(data: Buffer) {
  let offset = 8;
  const owner = new PublicKey(data.slice(offset, offset + 32)); offset += 32;
  const contentHash = data.slice(offset, offset + 32); offset += 32;
  const originalHash = data.slice(offset, offset + 32); offset += 32;
  const codec = data[offset]; offset += 1;
  const groupSize = data.readUInt16LE(offset); offset += 2;
  const bitsPerWeight = data[offset]; offset += 1;
  const cosineMin = data.readFloatLE(offset); offset += 4;
  const pplDeltaPct = data.readFloatLE(offset); offset += 4;
  const status = data[offset]; offset += 1;
  const fidelityReceiptHash = data.slice(offset, offset + 32); offset += 32;
  const behavioralReceiptHash = data.slice(offset, offset + 32); offset += 32;
  const riskAttestationHash = data.slice(offset, offset + 32); offset += 32;
  const transferCount = data.readUInt32LE(offset); offset += 4;
  const createdAt = Number(data.readBigInt64LE(offset)); offset += 8;
  const updatedAt = Number(data.readBigInt64LE(offset)); offset += 8;
  const bump = data[offset];
  return {
    owner, contentHash, originalHash, codec, groupSize, bitsPerWeight,
    cosineMin, pplDeltaPct, status, fidelityReceiptHash, behavioralReceiptHash,
    riskAttestationHash, transferCount, createdAt, updatedAt, bump,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Demo receipt collector
// ═══════════════════════════════════════════════════════════════════════════════

interface StepResult {
  step: number;
  name: string;
  tx: string | null;
  error: string | null;
  status_before: string | null;
  status_after: string | null;
  pass: boolean;
}

const receipt: {
  demo: string;
  program_id: string;
  repo_path: string;
  git_commit: string;
  timestamp_start: string;
  timestamp_end: string;
  deterministic_content: string;
  content_hash: string;
  original_hash: string;
  asset_pda: string;
  bad_asset_pda: string;
  quarantine_asset_pda: string;
  fidelity_receipt_hash: string;
  behavioral_receipt_hash: string;
  risk_attestation_hash: string;
  new_owner_pubkey: string;
  steps: StepResult[];
  final_state: any;
  all_pass: boolean;
} = {
  demo: "HXQ_SOLANA_LIFECYCLE_DEMO_V0",
  program_id: PROGRAM_ID.toBase58(),
  repo_path: "",
  git_commit: "",
  timestamp_start: new Date().toISOString(),
  timestamp_end: "",
  deterministic_content: "",
  content_hash: "",
  original_hash: "",
  asset_pda: "",
  bad_asset_pda: "",
  quarantine_asset_pda: "",
  fidelity_receipt_hash: "",
  behavioral_receipt_hash: "",
  risk_attestation_hash: "",
  new_owner_pubkey: "",
  steps: [],
  final_state: null,
  all_pass: false,
};

describe("HXQ-Solana Lifecycle Demo", () => {
  const connection = new Connection("http://localhost:8899", "confirmed");

  const walletKeyfile = require("os").homedir() + "/.config/solana/id.json";
  const walletSecret = Uint8Array.from(
    JSON.parse(require("fs").readFileSync(walletKeyfile, "utf-8"))
  );
  const owner = Keypair.fromSecretKey(walletSecret);

  // Deterministic content: a known tensor identity string
  const TENSOR_IDENTITY = "hxq:qwen2.5-coder-3b:layer.0.self_attn.q_proj:af6:g128:cos0.9993";
  const contentHash = sha256Bytes(TENSOR_IDENTITY);
  const originalHash = sha256Bytes("original:qwen2.5-coder-3b:layer.0.self_attn.q_proj:fp16");
  const fidelityHash = sha256Bytes("fidelity:cos=0.9993:ppl_delta=+0.53%:receipt_id=af6_bench_20260508");
  const behavioralHash = sha256Bytes("behavioral:25/25_tasks:tied_q4km:receipt_id=tiny_behavior_eval_20260503");
  const riskHash = sha256Bytes("risk:sentinel_v01:clear:no_anomalies:receipt_id=sentinel_risk_20260508");

  const [assetPDA] = findAssetPDA(contentHash);

  // Bad asset: cosine 0.990 (below 0.998 threshold)
  const BAD_TENSOR = "hxq:bad-codec:cos0.990:should_fail_promotion";
  const badContentHash = sha256Bytes(BAD_TENSOR);
  const [badAssetPDA] = findAssetPDA(badContentHash);

  // Quarantine asset: separate lifecycle
  const Q_TENSOR = "hxq:qwen2.5-coder-3b:layer.5.mlp.gate_proj:af6:quarantine_demo";
  const qContentHash = sha256Bytes(Q_TENSOR);
  const [qAssetPDA] = findAssetPDA(qContentHash);

  const newOwner = Keypair.generate();

  // Fill receipt metadata
  receipt.deterministic_content = TENSOR_IDENTITY;
  receipt.content_hash = contentHash.toString("hex");
  receipt.original_hash = originalHash.toString("hex");
  receipt.asset_pda = assetPDA.toBase58();
  receipt.bad_asset_pda = badAssetPDA.toBase58();
  receipt.quarantine_asset_pda = qAssetPDA.toBase58();
  receipt.fidelity_receipt_hash = fidelityHash.toString("hex");
  receipt.behavioral_receipt_hash = behavioralHash.toString("hex");
  receipt.risk_attestation_hash = riskHash.toString("hex");
  receipt.new_owner_pubkey = newOwner.publicKey.toBase58();

  async function fetchAsset(pda: PublicKey) {
    const info = await connection.getAccountInfo(pda);
    if (!info) throw new Error("Account not found");
    return deserializeAsset(info.data);
  }

  async function sendIx(ix: TransactionInstruction, signers: any[] = [owner]): Promise<string> {
    const tx = new Transaction().add(ix);
    return await sendAndConfirmTransaction(connection, tx, signers);
  }

  async function registerAsset(hash: Buffer, cosineMin: number, codec = 0, groupSize = 128, bpw = 6, pplDelta = 0.53) {
    const [pda] = findAssetPDA(hash);
    const data = buildRegisterData(hash, originalHash, codec, groupSize, bpw, cosineMin, pplDelta);
    const ix = new TransactionInstruction({
      keys: [
        { pubkey: pda, isSigner: false, isWritable: true },
        { pubkey: owner.publicKey, isSigner: true, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      programId: PROGRAM_ID,
      data,
    });
    return await sendIx(ix);
  }

  async function submitReceipt(discriminator: Buffer, pda: PublicKey, receiptHash: Buffer) {
    const data = buildReceiptData(discriminator, receiptHash);
    const ix = new TransactionInstruction({
      keys: [
        { pubkey: pda, isSigner: false, isWritable: true },
        { pubkey: owner.publicKey, isSigner: true, isWritable: false },
      ],
      programId: PROGRAM_ID,
      data,
    });
    return await sendIx(ix);
  }

  async function noArgIx(discriminator: Buffer, pda: PublicKey) {
    const ix = new TransactionInstruction({
      keys: [
        { pubkey: pda, isSigner: false, isWritable: true },
        { pubkey: owner.publicKey, isSigner: true, isWritable: false },
      ],
      programId: PROGRAM_ID,
      data: discriminator,
    });
    return await sendIx(ix);
  }

  async function transferAssetIx(pda: PublicKey, newOwnerPubkey: PublicKey) {
    const ix = new TransactionInstruction({
      keys: [
        { pubkey: pda, isSigner: false, isWritable: true },
        { pubkey: owner.publicKey, isSigner: true, isWritable: false },
        { pubkey: newOwnerPubkey, isSigner: false, isWritable: false },
      ],
      programId: PROGRAM_ID,
      data: IX_TRANSFER,
    });
    return await sendIx(ix);
  }

  function log(step: number, msg: string) {
    console.log(`  [Step ${step}] ${msg}`);
  }

  let stepNum = 0;

  // ═══════════════════════════════════════════════════════════════════════════
  // Step 1: Register good asset as Candidate
  // ═══════════════════════════════════════════════════════════════════════════
  it("Step 1: Register asset as Candidate (cosine=0.9993)", async () => {
    stepNum = 1;
    const tx = await registerAsset(contentHash, 0.9993);
    log(stepNum, `register_asset tx: ${tx}`);

    const asset = await fetchAsset(assetPDA);
    expect(asset.status).to.equal(STATUS_CANDIDATE);
    expect(asset.cosineMin).to.be.closeTo(0.9993, 0.001);
    log(stepNum, `Status: ${STATUS_NAMES[asset.status]}, cosine_min: ${asset.cosineMin}`);

    receipt.steps.push({
      step: stepNum, name: "register_asset", tx, error: null,
      status_before: null, status_after: "Candidate", pass: true,
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Step 2: Submit fidelity receipt
  // ═══════════════════════════════════════════════════════════════════════════
  it("Step 2: Submit fidelity receipt hash", async () => {
    stepNum = 2;
    const tx = await submitReceipt(IX_SUBMIT_FIDELITY, assetPDA, fidelityHash);
    log(stepNum, `submit_fidelity_receipt tx: ${tx}`);

    const asset = await fetchAsset(assetPDA);
    expect(asset.fidelityReceiptHash).to.deep.equal(fidelityHash);
    expect(asset.status).to.equal(STATUS_CANDIDATE);
    log(stepNum, `Fidelity hash stored. Status still: ${STATUS_NAMES[asset.status]}`);

    receipt.steps.push({
      step: stepNum, name: "submit_fidelity_receipt", tx, error: null,
      status_before: "Candidate", status_after: "Candidate", pass: true,
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Step 3: Submit behavioral receipt
  // ═══════════════════════════════════════════════════════════════════════════
  it("Step 3: Submit behavioral receipt hash", async () => {
    stepNum = 3;
    const tx = await submitReceipt(IX_SUBMIT_BEHAVIORAL, assetPDA, behavioralHash);
    log(stepNum, `submit_behavioral_receipt tx: ${tx}`);

    const asset = await fetchAsset(assetPDA);
    expect(asset.behavioralReceiptHash).to.deep.equal(behavioralHash);
    log(stepNum, `Behavioral hash stored. Status: ${STATUS_NAMES[asset.status]}`);

    receipt.steps.push({
      step: stepNum, name: "submit_behavioral_receipt", tx, error: null,
      status_before: "Candidate", status_after: "Candidate", pass: true,
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Step 4: Bad promotion — cosine < 0.998 must reject
  // ═══════════════════════════════════════════════════════════════════════════
  it("Step 4: Bad promotion rejected (cosine=0.990 < 0.998 threshold)", async () => {
    stepNum = 4;

    // Register a bad asset with cosine=0.990
    await registerAsset(badContentHash, 0.990);
    await submitReceipt(IX_SUBMIT_FIDELITY, badAssetPDA, fidelityHash);
    await submitReceipt(IX_SUBMIT_BEHAVIORAL, badAssetPDA, behavioralHash);

    let errorMsg: string | null = null;
    try {
      await noArgIx(IX_PROMOTE, badAssetPDA);
      expect.fail("Promotion should have been rejected");
    } catch (e: any) {
      errorMsg = e.toString();
      expect(errorMsg).to.match(/FidelityBelowThreshold|custom program error/i);
      log(stepNum, `Promotion correctly REJECTED: ${errorMsg.slice(0, 120)}`);
    }

    const asset = await fetchAsset(badAssetPDA);
    expect(asset.status).to.equal(STATUS_CANDIDATE);
    log(stepNum, `Bad asset remains: ${STATUS_NAMES[asset.status]}`);

    receipt.steps.push({
      step: stepNum, name: "promote_asset_REJECTED", tx: null, error: errorMsg,
      status_before: "Candidate", status_after: "Candidate", pass: true,
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Step 5: Good promotion — Candidate → Active
  // ═══════════════════════════════════════════════════════════════════════════
  it("Step 5: Promote asset Candidate -> Active (cosine=0.9993 >= 0.998)", async () => {
    stepNum = 5;
    const tx = await noArgIx(IX_PROMOTE, assetPDA);
    log(stepNum, `promote_asset tx: ${tx}`);

    const asset = await fetchAsset(assetPDA);
    expect(asset.status).to.equal(STATUS_ACTIVE);
    log(stepNum, `Status: ${STATUS_NAMES[asset.status]}`);

    receipt.steps.push({
      step: stepNum, name: "promote_asset", tx, error: null,
      status_before: "Candidate", status_after: "Active", pass: true,
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Step 6: Submit risk attestation
  // ═══════════════════════════════════════════════════════════════════════════
  it("Step 6: Submit risk attestation", async () => {
    stepNum = 6;
    const tx = await submitReceipt(IX_SUBMIT_RISK, assetPDA, riskHash);
    log(stepNum, `submit_risk_attestation tx: ${tx}`);

    const asset = await fetchAsset(assetPDA);
    expect(asset.riskAttestationHash).to.deep.equal(riskHash);
    log(stepNum, `Risk attestation stored. Status: ${STATUS_NAMES[asset.status]}`);

    receipt.steps.push({
      step: stepNum, name: "submit_risk_attestation", tx, error: null,
      status_before: "Active", status_after: "Active", pass: true,
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Step 7: Transfer to new owner
  // ═══════════════════════════════════════════════════════════════════════════
  it("Step 7: Transfer asset to new owner", async () => {
    stepNum = 7;
    const tx = await transferAssetIx(assetPDA, newOwner.publicKey);
    log(stepNum, `transfer_asset tx: ${tx}`);

    const asset = await fetchAsset(assetPDA);
    expect(asset.owner.toBase58()).to.equal(newOwner.publicKey.toBase58());
    expect(asset.transferCount).to.equal(1);
    expect(asset.status).to.equal(STATUS_ACTIVE);
    log(stepNum, `Owner: ${asset.owner.toBase58().slice(0, 12)}..., transfers: ${asset.transferCount}`);

    receipt.steps.push({
      step: stepNum, name: "transfer_asset", tx, error: null,
      status_before: "Active", status_after: "Active", pass: true,
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Step 8: Quarantine a separate active asset
  // ═══════════════════════════════════════════════════════════════════════════
  it("Step 8: Quarantine a separate active asset", async () => {
    stepNum = 8;

    // Register, receipt, promote a separate asset
    await registerAsset(qContentHash, 0.9995, 0, 128, 6, 0.3);
    await submitReceipt(IX_SUBMIT_FIDELITY, qAssetPDA, fidelityHash);
    await submitReceipt(IX_SUBMIT_BEHAVIORAL, qAssetPDA, behavioralHash);
    await noArgIx(IX_PROMOTE, qAssetPDA);

    const beforeAsset = await fetchAsset(qAssetPDA);
    expect(beforeAsset.status).to.equal(STATUS_ACTIVE);

    const tx = await noArgIx(IX_QUARANTINE, qAssetPDA);
    log(stepNum, `quarantine_asset tx: ${tx}`);

    const asset = await fetchAsset(qAssetPDA);
    expect(asset.status).to.equal(STATUS_QUARANTINED);
    log(stepNum, `Status: ${STATUS_NAMES[asset.status]}`);

    receipt.steps.push({
      step: stepNum, name: "quarantine_asset", tx, error: null,
      status_before: "Active", status_after: "Quarantined", pass: true,
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Step 9: Verify quarantined asset cannot transfer
  // ═══════════════════════════════════════════════════════════════════════════
  it("Step 9: Verify quarantined asset rejects transfer", async () => {
    stepNum = 9;
    await submitReceipt(IX_SUBMIT_RISK, qAssetPDA, riskHash);

    let errorMsg: string | null = null;
    try {
      await transferAssetIx(qAssetPDA, newOwner.publicKey);
      expect.fail("Transfer should have been rejected");
    } catch (e: any) {
      errorMsg = e.toString();
      expect(errorMsg).to.match(/AssetNotActive|custom program error/i);
      log(stepNum, `Transfer correctly REJECTED on quarantined asset`);
    }

    receipt.steps.push({
      step: stepNum, name: "transfer_quarantined_REJECTED", tx: null, error: errorMsg,
      status_before: "Quarantined", status_after: "Quarantined", pass: true,
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // After: Export receipt JSON
  // ═══════════════════════════════════════════════════════════════════════════
  after(async () => {
    // Fetch final state of the main asset
    try {
      const finalAsset = await fetchAsset(assetPDA);
      receipt.final_state = {
        owner: finalAsset.owner.toBase58(),
        status: STATUS_NAMES[finalAsset.status] || finalAsset.status,
        codec: finalAsset.codec,
        group_size: finalAsset.groupSize,
        bits_per_weight: finalAsset.bitsPerWeight,
        cosine_min: finalAsset.cosineMin,
        ppl_delta_pct: finalAsset.pplDeltaPct,
        transfer_count: finalAsset.transferCount,
        has_fidelity: !finalAsset.fidelityReceiptHash.equals(Buffer.alloc(32)),
        has_behavioral: !finalAsset.behavioralReceiptHash.equals(Buffer.alloc(32)),
        has_risk: !finalAsset.riskAttestationHash.equals(Buffer.alloc(32)),
      };
    } catch (e) {
      receipt.final_state = { error: "Could not fetch final state" };
    }

    // Get git info
    try {
      const { execSync } = require("child_process");
      receipt.repo_path = execSync("pwd", { cwd: path.resolve(__dirname, ".."), encoding: "utf-8" }).trim();
      receipt.git_commit = execSync("git rev-parse HEAD", { cwd: path.resolve(__dirname, ".."), encoding: "utf-8" }).trim();
    } catch (e) {
      receipt.repo_path = path.resolve(__dirname, "..");
      receipt.git_commit = "unknown";
    }

    receipt.timestamp_end = new Date().toISOString();
    receipt.all_pass = receipt.steps.every(s => s.pass);

    const receiptPath = path.resolve(__dirname, "..", "receipts", "hxq_solana_lifecycle_demo_20260508.json");
    fs.mkdirSync(path.dirname(receiptPath), { recursive: true });
    fs.writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + "\n");

    console.log("\n  ════════════════════════════════════════════");
    console.log(`  LIFECYCLE DEMO: ${receipt.all_pass ? "ALL PASS" : "FAILURES"} (${receipt.steps.length} steps)`);
    console.log(`  Receipt: ${receiptPath}`);
    console.log("  ════════════════════════════════════════════\n");
  });
});
