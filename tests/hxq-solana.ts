const anchor = require("@coral-xyz/anchor");
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
const borsh = require("borsh");

const PROGRAM_ID = new PublicKey("EnDRZxswjvqKQhnPuMY6m6AFK3sxCKRX2dokXxAYPYrP");

// Status enum values
const STATUS_CANDIDATE = 0;
const STATUS_ACTIVE = 1;
const STATUS_QUARANTINED = 2;

// Artifact types
const ARTIFACT_AI_TENSOR = 0;
const ARTIFACT_LEGAL = 1;
const ARTIFACT_MEDICAL = 2;
const ARTIFACT_SCIENTIFIC = 3;
const ARTIFACT_GENERIC = 255;

// Codec IDs
const CODEC_AFFINE6 = 0;
const CODEC_AFFINE_G128 = 1;
const CODEC_Q5_HIERARCHICAL = 2;
const CODEC_AFFINE4 = 3;

// Architecture types
const ARCH_TRANSFORMER = 0;
const ARCH_SSM = 1;
const ARCH_HYBRID = 2;
const ARCH_MOE = 3;
const ARCH_VISION = 4;

// Anchor instruction discriminators (first 8 bytes of sha256("global:<snake_case_name>"))
function ixDiscriminator(name: string): Buffer {
  const hash = createHash("sha256").update(`global:${name}`).digest();
  return hash.slice(0, 8);
}

const IX_REGISTER_ASSET = ixDiscriminator("register_asset");
const IX_SUBMIT_FIDELITY = ixDiscriminator("submit_fidelity_receipt");
const IX_SUBMIT_BEHAVIORAL = ixDiscriminator("submit_behavioral_receipt");
const IX_SUBMIT_RISK = ixDiscriminator("submit_risk_attestation");
const IX_PROMOTE = ixDiscriminator("promote_asset");
const IX_QUARANTINE = ixDiscriminator("quarantine_asset");
const IX_TRANSFER = ixDiscriminator("transfer_asset");
const IX_DISPUTE = ixDiscriminator("dispute_asset");
const IX_INITIATE_ROTATION = ixDiscriminator("initiate_guardian_rotation");
const IX_FINALIZE_ROTATION = ixDiscriminator("finalize_guardian_rotation");
const IX_CANCEL_ROTATION = ixDiscriminator("cancel_guardian_rotation");

function sha256Bytes(data: string): Buffer {
  return createHash("sha256").update(data).digest();
}

function findAssetPDA(contentHash: Buffer): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("hxq-asset"), contentHash],
    PROGRAM_ID
  );
}

// Encode f32 to little-endian 4 bytes
function encodeF32(val: number): Buffer {
  const buf = Buffer.alloc(4);
  buf.writeFloatLE(val, 0);
  return buf;
}

function encodeU16LE(val: number): Buffer {
  const buf = Buffer.alloc(2);
  buf.writeUInt16LE(val, 0);
  return buf;
}

function encodeI16LE(val: number): Buffer {
  const buf = Buffer.alloc(2);
  buf.writeInt16LE(val, 0);
  return buf;
}

// Build register_asset instruction data
function buildRegisterData(
  contentHash: Buffer,
  originalHash: Buffer,
  artifactType: number,
  threshold: number,
  metadataHash: Buffer,
  codecId: number = 0,
  groupSize: number = 128,
  bitsPerWeight: number = 6,
  architecture: number = ARCH_TRANSFORMER,
  cosineClaim: number = 0.0,
  pplDeltaBps: number = 0,
  artifactCid: Buffer = Buffer.alloc(32),
  guardian: Buffer = Buffer.alloc(32),
): Buffer {
  return Buffer.concat([
    IX_REGISTER_ASSET,
    contentHash,                    // [u8; 32]
    originalHash,                   // [u8; 32]
    Buffer.from([artifactType]),    // u8
    encodeF32(threshold),           // f32
    metadataHash,                   // [u8; 32]
    Buffer.from([codecId]),         // u8
    encodeU16LE(groupSize),         // u16
    Buffer.from([bitsPerWeight]),   // u8
    Buffer.from([architecture]),    // u8
    encodeF32(cosineClaim),         // f32
    encodeI16LE(pplDeltaBps),       // i16
    artifactCid,                    // [u8; 32]
    guardian,                       // Pubkey (32)
  ]);
}

// Build receipt submission instruction data
function buildReceiptData(discriminator: Buffer, receiptHash: Buffer): Buffer {
  return Buffer.concat([discriminator, receiptHash]);
}

// Deserialize ReceiptGatedAsset (skip 8-byte discriminator)
function deserializeAsset(data: Buffer) {
  let offset = 8; // Skip Anchor discriminator

  const owner = new PublicKey(data.slice(offset, offset + 32));
  offset += 32;

  const contentHash = data.slice(offset, offset + 32);
  offset += 32;

  const originalHash = data.slice(offset, offset + 32);
  offset += 32;

  const artifactType = data[offset];
  offset += 1;

  const threshold = data.readFloatLE(offset);
  offset += 4;

  const metadataHash = data.slice(offset, offset + 32);
  offset += 32;

  // Codec-aware fields
  const codecId = data[offset]; offset += 1;
  const groupSize = data.readUInt16LE(offset); offset += 2;
  const bitsPerWeight = data[offset]; offset += 1;
  const architecture = data[offset]; offset += 1;
  const cosineClaim = data.readFloatLE(offset); offset += 4;
  const pplDeltaBps = data.readInt16LE(offset); offset += 2;
  const artifactCid = data.slice(offset, offset + 32); offset += 32;

  const status = data[offset];
  offset += 1;

  const fidelityReceiptHash = data.slice(offset, offset + 32);
  offset += 32;

  const behavioralReceiptHash = data.slice(offset, offset + 32);
  offset += 32;

  const riskAttestationHash = data.slice(offset, offset + 32);
  offset += 32;

  const transferCount = data.readUInt32LE(offset);
  offset += 4;

  const createdAt = Number(data.readBigInt64LE(offset));
  offset += 8;

  const updatedAt = Number(data.readBigInt64LE(offset));
  offset += 8;

  const bump = data[offset];
  offset += 1;

  const guardian = new PublicKey(data.slice(offset, offset + 32));
  offset += 32;

  const pendingGuardian = new PublicKey(data.slice(offset, offset + 32));
  offset += 32;

  const rotationEligibleAt = Number(data.readBigInt64LE(offset));
  offset += 8;

  return {
    owner,
    contentHash,
    originalHash,
    artifactType,
    threshold,
    metadataHash,
    codecId,
    groupSize,
    bitsPerWeight,
    architecture,
    cosineClaim,
    pplDeltaBps,
    artifactCid,
    status,
    fidelityReceiptHash,
    behavioralReceiptHash,
    riskAttestationHash,
    transferCount,
    createdAt,
    updatedAt,
    bump,
    guardian,
    pendingGuardian,
    rotationEligibleAt,
  };
}

describe("hxq-solana", () => {
  const connection = new Connection("http://localhost:8899", "confirmed");

  // Load wallet keypair from file
  const walletKeyfile = require("os").homedir() + "/.config/solana/id.json";
  const walletSecret = Uint8Array.from(
    JSON.parse(require("fs").readFileSync(walletKeyfile, "utf-8"))
  );
  const owner = Keypair.fromSecretKey(walletSecret);

  const contentHash = sha256Bytes("test-tensor-compressed-v1");
  const originalHash = sha256Bytes("test-tensor-original-v1");
  const metadataHash = sha256Bytes("metadata:codec=affine_6:g128:bpw=6:ppl_delta=0.5");
  const fidelityHash = sha256Bytes("fidelity-receipt-cosine-0.999");
  const behavioralHash = sha256Bytes("behavioral-receipt-pass");
  const riskHash = sha256Bytes("risk-attestation-clear");

  const [assetPDA, assetBump] = findAssetPDA(contentHash);

  async function fetchAsset(pda: PublicKey) {
    const info = await connection.getAccountInfo(pda);
    if (!info) throw new Error("Account not found");
    return deserializeAsset(info.data);
  }

  async function sendIx(
    ix: TransactionInstruction,
    signers: any[] = [owner]
  ): Promise<string> {
    const tx = new Transaction().add(ix);
    return await sendAndConfirmTransaction(connection, tx, signers);
  }

  // Helper: register an asset
  async function registerAsset(
    hash: Buffer,
    threshold = 0.999,
    artifactType = ARTIFACT_AI_TENSOR,
    metadata = metadataHash,
    codecId = CODEC_AFFINE6,
    groupSize = 128,
    bitsPerWeight = 6,
    architecture = ARCH_TRANSFORMER,
    cosineClaim = 0.999,
    pplDeltaBps = 53,
  ) {
    const [pda] = findAssetPDA(hash);
    const data = buildRegisterData(
      hash, originalHash, artifactType, threshold, metadata,
      codecId, groupSize, bitsPerWeight, architecture, cosineClaim, pplDeltaBps,
    );
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

  // Helper: submit receipt
  async function submitReceipt(
    discriminator: Buffer,
    pda: PublicKey,
    receiptHash: Buffer,
    signer = owner
  ) {
    const data = buildReceiptData(discriminator, receiptHash);
    const ix = new TransactionInstruction({
      keys: [
        { pubkey: pda, isSigner: false, isWritable: true },
        { pubkey: signer.publicKey, isSigner: true, isWritable: false },
      ],
      programId: PROGRAM_ID,
      data,
    });
    return await sendIx(ix, [signer]);
  }

  // Helper: no-arg instruction (promote, quarantine)
  async function noArgIx(discriminator: Buffer, pda: PublicKey, signer = owner) {
    const ix = new TransactionInstruction({
      keys: [
        { pubkey: pda, isSigner: false, isWritable: true },
        { pubkey: signer.publicKey, isSigner: true, isWritable: false },
      ],
      programId: PROGRAM_ID,
      data: discriminator,
    });
    return await sendIx(ix, [signer]);
  }

  // Helper: transfer
  async function transferAsset(pda: PublicKey, newOwnerPubkey: PublicKey, signer = owner) {
    const ix = new TransactionInstruction({
      keys: [
        { pubkey: pda, isSigner: false, isWritable: true },
        { pubkey: signer.publicKey, isSigner: true, isWritable: false },
        { pubkey: newOwnerPubkey, isSigner: false, isWritable: false },
      ],
      programId: PROGRAM_ID,
      data: IX_TRANSFER,
    });
    return await sendIx(ix, [signer]);
  }

  describe("register_asset", () => {
    it("registers a new codec-aware receipt-gated asset", async () => {
      const tx = await registerAsset(contentHash, 0.999);
      console.log("  register_asset tx:", tx);

      const asset = await fetchAsset(assetPDA);
      expect(asset.owner.toBase58()).to.equal(owner.publicKey.toBase58());
      expect(asset.artifactType).to.equal(ARTIFACT_AI_TENSOR);
      expect(asset.status).to.equal(STATUS_CANDIDATE);
      expect(asset.transferCount).to.equal(0);
      expect(asset.contentHash).to.deep.equal(contentHash);
      expect(asset.originalHash).to.deep.equal(originalHash);
      // Codec-aware fields
      expect(asset.codecId).to.equal(CODEC_AFFINE6);
      expect(asset.groupSize).to.equal(128);
      expect(asset.bitsPerWeight).to.equal(6);
      expect(asset.architecture).to.equal(ARCH_TRANSFORMER);
      expect(asset.cosineClaim).to.be.closeTo(0.999, 0.001);
      expect(asset.pplDeltaBps).to.equal(53);
    });

    it("rejects duplicate registration (same content_hash)", async () => {
      try {
        await registerAsset(contentHash, 0.999);
        expect.fail("Should have thrown");
      } catch (e: any) {
        expect(e.toString()).to.match(/already in use|custom program error/i);
      }
    });
  });

  describe("submit_fidelity_receipt", () => {
    it("submits fidelity receipt hash", async () => {
      const tx = await submitReceipt(IX_SUBMIT_FIDELITY, assetPDA, fidelityHash);
      console.log("  submit_fidelity_receipt tx:", tx);

      const asset = await fetchAsset(assetPDA);
      expect(asset.fidelityReceiptHash).to.deep.equal(fidelityHash);
      expect(asset.status).to.equal(STATUS_CANDIDATE);
    });

    it("rejects non-owner fidelity submission", async () => {
      const imposter = Keypair.generate();
      try {
        await submitReceipt(IX_SUBMIT_FIDELITY, assetPDA, fidelityHash, imposter);
        expect.fail("Should have thrown");
      } catch (e: any) {
        expect(e.toString()).to.match(/Unauthorized|signature|custom program error|Simulation failed|unknown signer/i);
      }
    });
  });

  describe("submit_behavioral_receipt", () => {
    it("submits behavioral receipt hash", async () => {
      const tx = await submitReceipt(IX_SUBMIT_BEHAVIORAL, assetPDA, behavioralHash);
      console.log("  submit_behavioral_receipt tx:", tx);

      const asset = await fetchAsset(assetPDA);
      expect(asset.behavioralReceiptHash).to.deep.equal(behavioralHash);
    });
  });

  describe("promote_asset", () => {
    it("rejects promotion without receipts", async () => {
      const noReceiptHash = sha256Bytes("no-receipt-tensor");
      const [noReceiptPDA] = findAssetPDA(noReceiptHash);

      await registerAsset(noReceiptHash, 0.999);

      try {
        await noArgIx(IX_PROMOTE, noReceiptPDA);
        expect.fail("Should have thrown");
      } catch (e: any) {
        expect(e.toString()).to.match(/MissingFidelityReceipt|custom program error/i);
      }
    });

    it("rejects promotion with cosine_claim below per-codec gate", async () => {
      const lowHash = sha256Bytes("low-threshold-asset");
      const [lowPDA] = findAssetPDA(lowHash);

      // cosine_claim=0.990 < affine6 gate of 0.998
      await registerAsset(lowHash, 0.990, ARTIFACT_AI_TENSOR, metadataHash,
        CODEC_AFFINE6, 128, 6, ARCH_TRANSFORMER, 0.990, 0);
      await submitReceipt(IX_SUBMIT_FIDELITY, lowPDA, fidelityHash);
      await submitReceipt(IX_SUBMIT_BEHAVIORAL, lowPDA, behavioralHash);

      try {
        await noArgIx(IX_PROMOTE, lowPDA);
        expect.fail("Should have thrown");
      } catch (e: any) {
        expect(e.toString()).to.match(/ThresholdBelowGate|custom program error/i);
      }
    });

    it("accepts affine4 at 0.996 (per-codec gate 0.995) but rejects at 0.994", async () => {
      // 0.996 >= 0.995 gate for affine4 → should promote
      const okHash = sha256Bytes("affine4-ok-tensor");
      const [okPDA] = findAssetPDA(okHash);
      await registerAsset(okHash, 0.996, ARTIFACT_AI_TENSOR, metadataHash,
        CODEC_AFFINE4, 128, 4, ARCH_TRANSFORMER, 0.996, 1100);
      await submitReceipt(IX_SUBMIT_FIDELITY, okPDA, fidelityHash);
      await submitReceipt(IX_SUBMIT_BEHAVIORAL, okPDA, behavioralHash);
      await noArgIx(IX_PROMOTE, okPDA);
      const okAsset = await fetchAsset(okPDA);
      expect(okAsset.status).to.equal(STATUS_ACTIVE);

      // 0.994 < 0.995 gate for affine4 → should reject
      const badHash = sha256Bytes("affine4-bad-tensor");
      const [badPDA] = findAssetPDA(badHash);
      await registerAsset(badHash, 0.994, ARTIFACT_AI_TENSOR, metadataHash,
        CODEC_AFFINE4, 128, 4, ARCH_TRANSFORMER, 0.994, 1500);
      await submitReceipt(IX_SUBMIT_FIDELITY, badPDA, fidelityHash);
      await submitReceipt(IX_SUBMIT_BEHAVIORAL, badPDA, behavioralHash);
      try {
        await noArgIx(IX_PROMOTE, badPDA);
        expect.fail("Should have thrown");
      } catch (e: any) {
        expect(e.toString()).to.match(/ThresholdBelowGate|custom program error/i);
      }
    });

    it("promotes asset with valid receipts and threshold >= 0.998", async () => {
      const tx = await noArgIx(IX_PROMOTE, assetPDA);
      console.log("  promote_asset tx:", tx);

      const asset = await fetchAsset(assetPDA);
      expect(asset.status).to.equal(STATUS_ACTIVE);
    });

    it("rejects double promotion (already active)", async () => {
      try {
        await noArgIx(IX_PROMOTE, assetPDA);
        expect.fail("Should have thrown");
      } catch (e: any) {
        expect(e.toString()).to.match(/AssetNotCandidate|custom program error/i);
      }
    });
  });

  describe("submit_risk_attestation", () => {
    it("submits risk attestation on active asset", async () => {
      const tx = await submitReceipt(IX_SUBMIT_RISK, assetPDA, riskHash);
      console.log("  submit_risk_attestation tx:", tx);

      const asset = await fetchAsset(assetPDA);
      expect(asset.riskAttestationHash).to.deep.equal(riskHash);
    });
  });

  describe("transfer_asset", () => {
    const newOwner = Keypair.generate();

    it("rejects transfer without risk attestation", async () => {
      const noRiskHash = sha256Bytes("no-risk-tensor");
      const [noRiskPDA] = findAssetPDA(noRiskHash);

      await registerAsset(noRiskHash, 0.999);
      await submitReceipt(IX_SUBMIT_FIDELITY, noRiskPDA, fidelityHash);
      await submitReceipt(IX_SUBMIT_BEHAVIORAL, noRiskPDA, behavioralHash);
      await noArgIx(IX_PROMOTE, noRiskPDA);

      try {
        await transferAsset(noRiskPDA, newOwner.publicKey);
        expect.fail("Should have thrown");
      } catch (e: any) {
        expect(e.toString()).to.match(/MissingRiskAttestation|custom program error/i);
      }
    });

    it("transfers active asset with risk attestation", async () => {
      const tx = await transferAsset(assetPDA, newOwner.publicKey);
      console.log("  transfer_asset tx:", tx);

      const asset = await fetchAsset(assetPDA);
      expect(asset.owner.toBase58()).to.equal(newOwner.publicKey.toBase58());
      expect(asset.transferCount).to.equal(1);
    });

    it("rejects transfer from old owner after ownership change", async () => {
      try {
        const anotherBuyer = Keypair.generate();
        await transferAsset(assetPDA, anotherBuyer.publicKey);
        expect.fail("Should have thrown");
      } catch (e: any) {
        expect(e.toString()).to.match(/Unauthorized|ConstraintHasOne|custom program error/i);
      }
    });
  });

  describe("quarantine_asset", () => {
    it("quarantines an active asset", async () => {
      const qHash = sha256Bytes("quarantine-test-tensor");
      const [qPDA] = findAssetPDA(qHash);

      await registerAsset(qHash, 0.9995, ARTIFACT_AI_TENSOR);
      await submitReceipt(IX_SUBMIT_FIDELITY, qPDA, fidelityHash);
      await submitReceipt(IX_SUBMIT_BEHAVIORAL, qPDA, behavioralHash);
      await noArgIx(IX_PROMOTE, qPDA);

      const tx = await noArgIx(IX_QUARANTINE, qPDA);
      console.log("  quarantine_asset tx:", tx);

      const asset = await fetchAsset(qPDA);
      expect(asset.status).to.equal(STATUS_QUARANTINED);
    });

    it("rejects transfer on quarantined asset", async () => {
      const qHash = sha256Bytes("quarantine-test-tensor");
      const [qPDA] = findAssetPDA(qHash);
      const buyer = Keypair.generate();

      await submitReceipt(IX_SUBMIT_RISK, qPDA, riskHash);

      try {
        await transferAsset(qPDA, buyer.publicKey);
        expect.fail("Should have thrown");
      } catch (e: any) {
        expect(e.toString()).to.match(/AssetNotActive|custom program error/i);
      }
    });

    it("rejects quarantine on candidate asset", async () => {
      const cHash = sha256Bytes("candidate-no-quarantine");
      const [cPDA] = findAssetPDA(cHash);

      await registerAsset(cHash, 0.999);

      try {
        await noArgIx(IX_QUARANTINE, cPDA);
        expect.fail("Should have thrown");
      } catch (e: any) {
        expect(e.toString()).to.match(/AssetNotActive|custom program error/i);
      }
    });
  });

  describe("dispute_asset (GuardianCell)", () => {
    const guardian = Keypair.generate();
    const disputeReceiptHash = sha256Bytes("dispute:sentinel_v01:anomaly_detected:cos_drift=-0.003");
    const gHash = sha256Bytes("guardian-test-tensor");
    const [gPDA] = findAssetPDA(gHash);

    // Helper: register asset with guardian
    async function registerWithGuardian(
      hash: Buffer,
      guardianPubkey: PublicKey,
      threshold = 0.999,
      cosineClaim = 0.999,
    ) {
      const [pda] = findAssetPDA(hash);
      const data = buildRegisterData(
        hash, originalHash, ARTIFACT_AI_TENSOR, threshold, metadataHash,
        CODEC_AFFINE6, 128, 6, ARCH_TRANSFORMER, cosineClaim, 53,
        Buffer.alloc(32), guardianPubkey.toBuffer(),
      );
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

    // Helper: build dispute instruction (owner pays fee, guardian signs)
    async function disputeAsset(pda: PublicKey, guardianKp: typeof Keypair, receipt: Buffer) {
      const data = Buffer.concat([IX_DISPUTE, receipt]);
      const ix = new TransactionInstruction({
        keys: [
          { pubkey: pda, isSigner: false, isWritable: true },
          { pubkey: guardianKp.publicKey, isSigner: true, isWritable: false },
        ],
        programId: PROGRAM_ID,
        data,
      });
      const tx = new Transaction().add(ix);
      tx.feePayer = owner.publicKey;
      return await sendAndConfirmTransaction(connection, tx, [owner, guardianKp]);
    }

    it("registers asset with guardian set", async () => {
      await registerWithGuardian(gHash, guardian.publicKey);
      const asset = await fetchAsset(gPDA);
      expect(asset.guardian.toBase58()).to.equal(guardian.publicKey.toBase58());
      expect(asset.status).to.equal(STATUS_CANDIDATE);
    });

    it("promotes guardian-backed asset to Active", async () => {
      await submitReceipt(IX_SUBMIT_FIDELITY, gPDA, fidelityHash);
      await submitReceipt(IX_SUBMIT_BEHAVIORAL, gPDA, behavioralHash);
      await noArgIx(IX_PROMOTE, gPDA);
      const asset = await fetchAsset(gPDA);
      expect(asset.status).to.equal(STATUS_ACTIVE);
    });

    it("guardian disputes Active asset → Quarantined", async () => {
      const tx = await disputeAsset(gPDA, guardian, disputeReceiptHash);
      console.log("  dispute_asset tx:", tx);
      const asset = await fetchAsset(gPDA);
      expect(asset.status).to.equal(STATUS_QUARANTINED);
      expect(asset.riskAttestationHash).to.deep.equal(disputeReceiptHash);
    });

    it("rejects dispute from non-guardian", async () => {
      // Register a fresh active asset with guardian
      const h2 = sha256Bytes("guardian-test-tensor-2");
      const [pda2] = findAssetPDA(h2);
      await registerWithGuardian(h2, guardian.publicKey);
      await submitReceipt(IX_SUBMIT_FIDELITY, pda2, fidelityHash);
      await submitReceipt(IX_SUBMIT_BEHAVIORAL, pda2, behavioralHash);
      await noArgIx(IX_PROMOTE, pda2);

      const imposter = Keypair.generate();
      try {
        await disputeAsset(pda2, imposter, disputeReceiptHash);
        expect.fail("Should have thrown");
      } catch (e: any) {
        expect(e.toString()).to.match(/DisputeNotAuthorized|ConstraintHasOne|custom program error|Simulation failed/i);
      }
    });

    it("rejects dispute on non-Active asset", async () => {
      // Register asset with guardian but don't promote (stays Candidate)
      const h3 = sha256Bytes("guardian-test-tensor-3");
      const [pda3] = findAssetPDA(h3);
      await registerWithGuardian(h3, guardian.publicKey);

      try {
        await disputeAsset(pda3, guardian, disputeReceiptHash);
        expect.fail("Should have thrown");
      } catch (e: any) {
        expect(e.toString()).to.match(/AssetNotActive|custom program error|Simulation failed/i);
      }
    });

    it("rejects dispute with zero receipt hash", async () => {
      const h4 = sha256Bytes("guardian-test-tensor-4");
      const [pda4] = findAssetPDA(h4);
      await registerWithGuardian(h4, guardian.publicKey);
      await submitReceipt(IX_SUBMIT_FIDELITY, pda4, fidelityHash);
      await submitReceipt(IX_SUBMIT_BEHAVIORAL, pda4, behavioralHash);
      await noArgIx(IX_PROMOTE, pda4);

      try {
        await disputeAsset(pda4, guardian, Buffer.alloc(32));
        expect.fail("Should have thrown");
      } catch (e: any) {
        expect(e.toString()).to.match(/MissingDisputeReceipt|custom program error|Simulation failed/i);
      }
    });

    it("rejects dispute when no guardian is set (zero pubkey)", async () => {
      // Register asset WITHOUT guardian (default zero pubkey)
      const h5 = sha256Bytes("no-guardian-test-tensor");
      const [pda5] = findAssetPDA(h5);
      await registerAsset(h5, 0.999);
      await submitReceipt(IX_SUBMIT_FIDELITY, pda5, fidelityHash);
      await submitReceipt(IX_SUBMIT_BEHAVIORAL, pda5, behavioralHash);
      await noArgIx(IX_PROMOTE, pda5);

      // Guardian doesn't match → has_one constraint fails
      try {
        await disputeAsset(pda5, guardian, disputeReceiptHash);
        expect.fail("Should have thrown");
      } catch (e: any) {
        expect(e.toString()).to.match(/DisputeNotAuthorized|ConstraintHasOne|custom program error|Simulation failed/i);
      }
    });
  });

  describe("guardian rotation (timelock)", () => {
    const guardian = Keypair.generate();
    const newGuardian = Keypair.generate();
    const rHash = sha256Bytes("rotation-test-tensor");
    const [rPDA] = findAssetPDA(rHash);

    // Helper: initiate rotation (owner signs)
    async function initiateRotation(pda: PublicKey, newGuardianPubkey: PublicKey) {
      const data = Buffer.concat([IX_INITIATE_ROTATION, newGuardianPubkey.toBuffer()]);
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

    // Helper: finalize rotation (owner signs)
    async function finalizeRotation(pda: PublicKey) {
      const ix = new TransactionInstruction({
        keys: [
          { pubkey: pda, isSigner: false, isWritable: true },
          { pubkey: owner.publicKey, isSigner: true, isWritable: false },
        ],
        programId: PROGRAM_ID,
        data: IX_FINALIZE_ROTATION,
      });
      return await sendIx(ix);
    }

    // Helper: cancel rotation (guardian signs, owner pays)
    async function cancelRotation(pda: PublicKey, guardianKp: typeof Keypair) {
      const ix = new TransactionInstruction({
        keys: [
          { pubkey: pda, isSigner: false, isWritable: true },
          { pubkey: guardianKp.publicKey, isSigner: true, isWritable: false },
        ],
        programId: PROGRAM_ID,
        data: IX_CANCEL_ROTATION,
      });
      const tx = new Transaction().add(ix);
      tx.feePayer = owner.publicKey;
      return await sendAndConfirmTransaction(connection, tx, [owner, guardianKp]);
    }

    it("registers asset with guardian for rotation tests", async () => {
      const data = buildRegisterData(
        rHash, originalHash, ARTIFACT_AI_TENSOR, 0.999, metadataHash,
        CODEC_AFFINE6, 128, 6, ARCH_TRANSFORMER, 0.999, 53,
        Buffer.alloc(32), guardian.publicKey.toBuffer(),
      );
      const ix = new TransactionInstruction({
        keys: [
          { pubkey: rPDA, isSigner: false, isWritable: true },
          { pubkey: owner.publicKey, isSigner: true, isWritable: true },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ],
        programId: PROGRAM_ID,
        data,
      });
      await sendIx(ix);
      const asset = await fetchAsset(rPDA);
      expect(asset.guardian.toBase58()).to.equal(guardian.publicKey.toBase58());
      expect(asset.pendingGuardian.toBase58()).to.equal(PublicKey.default.toBase58());
      expect(asset.rotationEligibleAt).to.equal(0);
    });

    it("owner initiates guardian rotation", async () => {
      const tx = await initiateRotation(rPDA, newGuardian.publicKey);
      console.log("  initiate_guardian_rotation tx:", tx);
      const asset = await fetchAsset(rPDA);
      expect(asset.pendingGuardian.toBase58()).to.equal(newGuardian.publicKey.toBase58());
      expect(asset.rotationEligibleAt).to.be.greaterThan(0);
      // Guardian should still be the original
      expect(asset.guardian.toBase58()).to.equal(guardian.publicKey.toBase58());
    });

    it("rejects finalization before timelock expires", async () => {
      try {
        await finalizeRotation(rPDA);
        expect.fail("Should have thrown");
      } catch (e: any) {
        expect(e.toString()).to.match(/RotationNotEligible|custom program error|Simulation failed/i);
      }
    });

    it("rejects duplicate initiation while rotation pending", async () => {
      const another = Keypair.generate();
      try {
        await initiateRotation(rPDA, another.publicKey);
        expect.fail("Should have thrown");
      } catch (e: any) {
        expect(e.toString()).to.match(/RotationAlreadyPending|custom program error|Simulation failed/i);
      }
    });

    it("current guardian cancels rotation", async () => {
      const tx = await cancelRotation(rPDA, guardian);
      console.log("  cancel_guardian_rotation tx:", tx);
      const asset = await fetchAsset(rPDA);
      expect(asset.pendingGuardian.toBase58()).to.equal(PublicKey.default.toBase58());
      expect(asset.rotationEligibleAt).to.equal(0);
      // Guardian unchanged
      expect(asset.guardian.toBase58()).to.equal(guardian.publicKey.toBase58());
    });

    it("rejects cancel when no rotation pending", async () => {
      try {
        await cancelRotation(rPDA, guardian);
        expect.fail("Should have thrown");
      } catch (e: any) {
        expect(e.toString()).to.match(/NoRotationPending|custom program error|Simulation failed/i);
      }
    });

    it("rejects initiation with zero pubkey", async () => {
      try {
        await initiateRotation(rPDA, PublicKey.default);
        expect.fail("Should have thrown");
      } catch (e: any) {
        expect(e.toString()).to.match(/InvalidNewGuardian|custom program error|Simulation failed/i);
      }
    });

    it("rejects cancel from non-guardian", async () => {
      // Initiate again so there's something to cancel
      await initiateRotation(rPDA, newGuardian.publicKey);

      const imposter = Keypair.generate();
      try {
        await cancelRotation(rPDA, imposter);
        expect.fail("Should have thrown");
      } catch (e: any) {
        expect(e.toString()).to.match(/DisputeNotAuthorized|ConstraintHasOne|custom program error|Simulation failed/i);
      }

      // Clean up: cancel with real guardian
      await cancelRotation(rPDA, guardian);
    });
  });
});
