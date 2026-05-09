/**
 * HXQ-Solana Domain Fixture Demos
 *
 * Proves the program works as a generic receipt-gated provenance
 * state machine for arbitrary off-chain artifacts.
 *
 * Three domains tested:
 *   1. Legal document chain-of-custody (artifact_type=1)
 *   2. Medical record consent (artifact_type=2)
 *   3. Scientific compute receipt (artifact_type=3)
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

const ARTIFACT_TYPES: Record<string, number> = {
  ai_tensor: 0,
  legal_document: 1,
  medical_record: 2,
  scientific_compute: 3,
};

function ixDiscriminator(name: string): Buffer {
  return createHash("sha256").update(`global:${name}`).digest().slice(0, 8);
}

const IX_REGISTER = ixDiscriminator("register_asset");
const IX_FIDELITY = ixDiscriminator("submit_fidelity_receipt");
const IX_BEHAVIORAL = ixDiscriminator("submit_behavioral_receipt");
const IX_RISK = ixDiscriminator("submit_risk_attestation");
const IX_PROMOTE = ixDiscriminator("promote_asset");
const IX_QUARANTINE = ixDiscriminator("quarantine_asset");
const IX_TRANSFER = ixDiscriminator("transfer_asset");

function sha256(data: string): Buffer {
  return createHash("sha256").update(data).digest();
}

function findPDA(contentHash: Buffer): [PublicKey, number] {
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

function buildRegisterData(
  contentHash: Buffer, originalHash: Buffer,
  artifactType: number, threshold: number, metadataHash: Buffer
): Buffer {
  return Buffer.concat([
    IX_REGISTER,
    contentHash, originalHash,
    Buffer.from([artifactType]),
    encodeF32(threshold),
    metadataHash,
  ]);
}

function deserializeAsset(data: Buffer) {
  let o = 8;
  const owner = new PublicKey(data.slice(o, o + 32)); o += 32;
  const contentHash = data.slice(o, o + 32); o += 32;
  const originalHash = data.slice(o, o + 32); o += 32;
  const artifactType = data[o]; o += 1;
  const threshold = data.readFloatLE(o); o += 4;
  const metadataHash = data.slice(o, o + 32); o += 32;
  const status = data[o]; o += 1;
  const fidelityReceiptHash = data.slice(o, o + 32); o += 32;
  const behavioralReceiptHash = data.slice(o, o + 32); o += 32;
  const riskAttestationHash = data.slice(o, o + 32); o += 32;
  const transferCount = data.readUInt32LE(o); o += 4;
  const createdAt = Number(data.readBigInt64LE(o)); o += 8;
  const updatedAt = Number(data.readBigInt64LE(o)); o += 8;
  const bump = data[o];
  return {
    owner, contentHash, originalHash, artifactType, threshold, metadataHash,
    status, fidelityReceiptHash, behavioralReceiptHash, riskAttestationHash,
    transferCount, createdAt, updatedAt, bump,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════

interface DomainFixture {
  artifact_type: string;
  content_identity: string;
  original_identity: string;
  receipts: { fidelity: string; behavioral: string; risk: string };
}

interface DomainResult {
  artifact_type: string;
  artifact_type_id: number;
  fixture_path: string;
  asset_pda: string;
  quarantine_pda: string;
  content_hash: string;
  original_hash: string;
  fidelity_receipt_hash: string;
  behavioral_receipt_hash: string;
  risk_attestation_hash: string;
  register_tx: string;
  fidelity_tx: string;
  behavioral_tx: string;
  promote_tx: string;
  risk_tx: string;
  transfer_tx: string;
  quarantine_tx: string;
  quarantine_transfer_rejected_error: string;
  all_pass: boolean;
}

const FIXTURES: { path: string; data: DomainFixture }[] = [
  {
    path: "examples/legal_document_custody/fixture.json",
    data: JSON.parse(fs.readFileSync(path.resolve(__dirname, "..", "examples/legal_document_custody/fixture.json"), "utf-8")),
  },
  {
    path: "examples/medical_record_consent/fixture.json",
    data: JSON.parse(fs.readFileSync(path.resolve(__dirname, "..", "examples/medical_record_consent/fixture.json"), "utf-8")),
  },
  {
    path: "examples/scientific_compute_receipt/fixture.json",
    data: JSON.parse(fs.readFileSync(path.resolve(__dirname, "..", "examples/scientific_compute_receipt/fixture.json"), "utf-8")),
  },
];

describe("HXQ-Solana Domain Fixture Demos", () => {
  const connection = new Connection("http://localhost:8899", "confirmed");
  const walletKeyfile = require("os").homedir() + "/.config/solana/id.json";
  const walletSecret = Uint8Array.from(
    JSON.parse(fs.readFileSync(walletKeyfile, "utf-8"))
  );
  const owner = Keypair.fromSecretKey(walletSecret);
  const newOwner = Keypair.generate();

  const domainResults: DomainResult[] = [];
  const timestampStart = new Date().toISOString();

  async function fetchAsset(pda: PublicKey) {
    const info = await connection.getAccountInfo(pda);
    if (!info) throw new Error("Account not found");
    return deserializeAsset(info.data);
  }

  async function sendIx(ix: TransactionInstruction): Promise<string> {
    const tx = new Transaction().add(ix);
    return await sendAndConfirmTransaction(connection, tx, [owner]);
  }

  async function register(contentHash: Buffer, originalHash: Buffer, artifactType: number, threshold: number): Promise<string> {
    const [pda] = findPDA(contentHash);
    const metadataHash = sha256(`metadata:${contentHash.toString("hex")}`);
    const data = buildRegisterData(contentHash, originalHash, artifactType, threshold, metadataHash);
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

  async function submitReceipt(disc: Buffer, pda: PublicKey, hash: Buffer): Promise<string> {
    const data = Buffer.concat([disc, hash]);
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

  async function noArg(disc: Buffer, pda: PublicKey): Promise<string> {
    const ix = new TransactionInstruction({
      keys: [
        { pubkey: pda, isSigner: false, isWritable: true },
        { pubkey: owner.publicKey, isSigner: true, isWritable: false },
      ],
      programId: PROGRAM_ID,
      data: disc,
    });
    return await sendIx(ix);
  }

  async function transfer(pda: PublicKey, to: PublicKey): Promise<string> {
    const ix = new TransactionInstruction({
      keys: [
        { pubkey: pda, isSigner: false, isWritable: true },
        { pubkey: owner.publicKey, isSigner: true, isWritable: false },
        { pubkey: to, isSigner: false, isWritable: false },
      ],
      programId: PROGRAM_ID,
      data: IX_TRANSFER,
    });
    return await sendIx(ix);
  }

  for (const fixture of FIXTURES) {
    const f = fixture.data;
    const artifactTypeId = ARTIFACT_TYPES[f.artifact_type] ?? 255;
    const contentHash = sha256(f.content_identity);
    const originalHash = sha256(f.original_identity);
    const fidelityHash = sha256(f.receipts.fidelity);
    const behavioralHash = sha256(f.receipts.behavioral);
    const riskHash = sha256(f.receipts.risk);
    const [assetPDA] = findPDA(contentHash);

    const qContentHash = sha256(f.content_identity + ":quarantine_target");
    const [qPDA] = findPDA(qContentHash);

    const result: DomainResult = {
      artifact_type: f.artifact_type,
      artifact_type_id: artifactTypeId,
      fixture_path: fixture.path,
      asset_pda: assetPDA.toBase58(),
      quarantine_pda: qPDA.toBase58(),
      content_hash: contentHash.toString("hex"),
      original_hash: originalHash.toString("hex"),
      fidelity_receipt_hash: fidelityHash.toString("hex"),
      behavioral_receipt_hash: behavioralHash.toString("hex"),
      risk_attestation_hash: riskHash.toString("hex"),
      register_tx: "", fidelity_tx: "", behavioral_tx: "", promote_tx: "",
      risk_tx: "", transfer_tx: "", quarantine_tx: "",
      quarantine_transfer_rejected_error: "",
      all_pass: false,
    };

    describe(`Domain: ${f.artifact_type} (type=${artifactTypeId})`, () => {
      it("registers Candidate", async () => {
        result.register_tx = await register(contentHash, originalHash, artifactTypeId, 1.0);
        const asset = await fetchAsset(assetPDA);
        expect(asset.status).to.equal(STATUS_CANDIDATE);
        expect(asset.artifactType).to.equal(artifactTypeId);
        console.log(`    [${f.artifact_type}] register tx: ${result.register_tx}`);
      });

      it("submits fidelity receipt", async () => {
        result.fidelity_tx = await submitReceipt(IX_FIDELITY, assetPDA, fidelityHash);
        const asset = await fetchAsset(assetPDA);
        expect(asset.fidelityReceiptHash).to.deep.equal(fidelityHash);
        console.log(`    [${f.artifact_type}] fidelity tx: ${result.fidelity_tx}`);
      });

      it("submits behavioral receipt", async () => {
        result.behavioral_tx = await submitReceipt(IX_BEHAVIORAL, assetPDA, behavioralHash);
        const asset = await fetchAsset(assetPDA);
        expect(asset.behavioralReceiptHash).to.deep.equal(behavioralHash);
        console.log(`    [${f.artifact_type}] behavioral tx: ${result.behavioral_tx}`);
      });

      it("promotes Candidate -> Active", async () => {
        result.promote_tx = await noArg(IX_PROMOTE, assetPDA);
        const asset = await fetchAsset(assetPDA);
        expect(asset.status).to.equal(STATUS_ACTIVE);
        console.log(`    [${f.artifact_type}] promote tx: ${result.promote_tx}`);
      });

      it("submits risk attestation", async () => {
        result.risk_tx = await submitReceipt(IX_RISK, assetPDA, riskHash);
        const asset = await fetchAsset(assetPDA);
        expect(asset.riskAttestationHash).to.deep.equal(riskHash);
        console.log(`    [${f.artifact_type}] risk tx: ${result.risk_tx}`);
      });

      it("transfers Active asset", async () => {
        result.transfer_tx = await transfer(assetPDA, newOwner.publicKey);
        const asset = await fetchAsset(assetPDA);
        expect(asset.owner.toBase58()).to.equal(newOwner.publicKey.toBase58());
        expect(asset.transferCount).to.equal(1);
        console.log(`    [${f.artifact_type}] transfer tx: ${result.transfer_tx}`);
      });

      it("quarantines separate Active asset", async () => {
        await register(qContentHash, originalHash, artifactTypeId, 1.0);
        await submitReceipt(IX_FIDELITY, qPDA, fidelityHash);
        await submitReceipt(IX_BEHAVIORAL, qPDA, behavioralHash);
        await noArg(IX_PROMOTE, qPDA);
        const before = await fetchAsset(qPDA);
        expect(before.status).to.equal(STATUS_ACTIVE);
        result.quarantine_tx = await noArg(IX_QUARANTINE, qPDA);
        const after = await fetchAsset(qPDA);
        expect(after.status).to.equal(STATUS_QUARANTINED);
        console.log(`    [${f.artifact_type}] quarantine tx: ${result.quarantine_tx}`);
      });

      it("rejects transfer on quarantined asset", async () => {
        await submitReceipt(IX_RISK, qPDA, riskHash);
        try {
          await transfer(qPDA, newOwner.publicKey);
          expect.fail("Should have been rejected");
        } catch (e: any) {
          result.quarantine_transfer_rejected_error = e.toString().slice(0, 200);
          expect(e.toString()).to.match(/AssetNotActive|custom program error/i);
          console.log(`    [${f.artifact_type}] quarantined transfer REJECTED`);
        }
        result.all_pass = true;
      });
    });

    domainResults.push(result);
  }

  after(() => {
    let gitCommit = "unknown";
    let repoPath = path.resolve(__dirname, "..");
    try {
      const { execSync } = require("child_process");
      repoPath = execSync("pwd", { cwd: repoPath, encoding: "utf-8" }).trim();
      gitCommit = execSync("git rev-parse HEAD", { cwd: repoPath, encoding: "utf-8" }).trim();
    } catch (e) {}

    const receipt = {
      demo: "HXQ_SOLANA_DOMAIN_FIXTURE_DEMOS_V0",
      program_id: PROGRAM_ID.toBase58(),
      repo_path: repoPath,
      git_commit: gitCommit,
      timestamp_start: timestampStart,
      timestamp_end: new Date().toISOString(),
      domains_tested: domainResults.length,
      all_pass: domainResults.every(d => d.all_pass),
      domains: domainResults,
    };

    const receiptPath = path.resolve(__dirname, "..", "receipts", "domain_fixture_demos_20260508.json");
    fs.mkdirSync(path.dirname(receiptPath), { recursive: true });
    fs.writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + "\n");

    const passCount = domainResults.filter(d => d.all_pass).length;
    console.log("\n  ════════════════════════════════════════════════════");
    console.log(`  DOMAIN FIXTURE DEMOS: ${passCount}/${domainResults.length} domains PASS`);
    domainResults.forEach(d => {
      console.log(`    ${d.artifact_type} (type=${d.artifact_type_id}): ${d.all_pass ? "PASS" : "FAIL"}`);
    });
    console.log(`  Receipt: ${receiptPath}`);
    console.log("  ════════════════════════════════════════════════════\n");
  });
});
