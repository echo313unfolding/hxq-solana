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

// Encode u16 to little-endian 2 bytes
function encodeU16(val: number): Buffer {
  const buf = Buffer.alloc(2);
  buf.writeUInt16LE(val, 0);
  return buf;
}

// Build register_asset instruction data
function buildRegisterData(
  contentHash: Buffer,
  originalHash: Buffer,
  codec: number,
  groupSize: number,
  bitsPerWeight: number,
  cosineMin: number,
  pplDeltaPct: number
): Buffer {
  return Buffer.concat([
    IX_REGISTER_ASSET,
    contentHash,            // [u8; 32]
    originalHash,           // [u8; 32]
    Buffer.from([codec]),   // u8
    encodeU16(groupSize),   // u16
    Buffer.from([bitsPerWeight]), // u8
    encodeF32(cosineMin),   // f32
    encodeF32(pplDeltaPct), // f32
  ]);
}

// Build receipt submission instruction data
function buildReceiptData(discriminator: Buffer, receiptHash: Buffer): Buffer {
  return Buffer.concat([discriminator, receiptHash]);
}

// Deserialize HxqAssetAccount (skip 8-byte discriminator)
function deserializeAsset(data: Buffer) {
  let offset = 8; // Skip Anchor discriminator

  const owner = new PublicKey(data.slice(offset, offset + 32));
  offset += 32;

  const contentHash = data.slice(offset, offset + 32);
  offset += 32;

  const originalHash = data.slice(offset, offset + 32);
  offset += 32;

  const codec = data[offset];
  offset += 1;

  const groupSize = data.readUInt16LE(offset);
  offset += 2;

  const bitsPerWeight = data[offset];
  offset += 1;

  const cosineMin = data.readFloatLE(offset);
  offset += 4;

  const pplDeltaPct = data.readFloatLE(offset);
  offset += 4;

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
    codec,
    groupSize,
    bitsPerWeight,
    cosineMin,
    pplDeltaPct,
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
    cosineMin = 0.999,
    codec = 0,
    groupSize = 128,
    bpw = 6,
    pplDelta = 0.5
  ) {
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
    it("registers a new HXQ tensor asset", async () => {
      const tx = await registerAsset(contentHash, 0.999);
      console.log("  register_asset tx:", tx);

      const asset = await fetchAsset(assetPDA);
      expect(asset.owner.toBase58()).to.equal(owner.publicKey.toBase58());
      expect(asset.codec).to.equal(0);
      expect(asset.groupSize).to.equal(128);
      expect(asset.bitsPerWeight).to.equal(6);
      expect(asset.status).to.equal(STATUS_CANDIDATE);
      expect(asset.transferCount).to.equal(0);
      expect(asset.contentHash).to.deep.equal(contentHash);
      expect(asset.originalHash).to.deep.equal(originalHash);
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
        // Will fail on constraint check, simulation, or missing signature
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

    it("rejects promotion with cosine below threshold", async () => {
      const lowCosHash = sha256Bytes("low-cosine-tensor");
      const [lowCosPDA] = findAssetPDA(lowCosHash);

      await registerAsset(lowCosHash, 0.990);
      await submitReceipt(IX_SUBMIT_FIDELITY, lowCosPDA, fidelityHash);
      await submitReceipt(IX_SUBMIT_BEHAVIORAL, lowCosPDA, behavioralHash);

      try {
        await noArgIx(IX_PROMOTE, lowCosPDA);
        expect.fail("Should have thrown");
      } catch (e: any) {
        expect(e.toString()).to.match(/FidelityBelowThreshold|custom program error/i);
      }
    });

    it("promotes asset with valid receipts and cosine >= 0.998", async () => {
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

      await registerAsset(qHash, 0.9995, 1, 128, 8, 0.3);
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
