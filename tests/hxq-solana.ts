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
});
