/**
 * HXQ Solana — Transfer Hook Integration Tests
 *
 * Tests the Token-2022 Transfer Hook that gates token transfers
 * based on the linked ReceiptGatedAsset's quality status.
 *
 * Flow:
 * 1. Register an HXQ asset (Candidate)
 * 2. Create Token-2022 mint with TransferHook extension
 * 3. Initialize extra account meta list (links mint → asset)
 * 4. Promote asset to Active (submit receipts first)
 * 5. Transfer tokens — should SUCCEED (Active + cosine above gate)
 * 6. Quarantine asset
 * 7. Transfer tokens — should FAIL (Quarantined)
 */

const anchor = require("@coral-xyz/anchor");
const {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
  LAMPORTS_PER_SOL,
} = require("@solana/web3.js");
const {
  ExtensionType,
  TOKEN_2022_PROGRAM_ID,
  getMintLen,
  createInitializeMintInstruction,
  createInitializeTransferHookInstruction,
  createAssociatedTokenAccountInstruction,
  createMintToInstruction,
  createTransferCheckedWithTransferHookInstruction,
  getAssociatedTokenAddressSync,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} = require("@solana/spl-token");
const { createHash } = require("crypto");
const { expect } = require("chai");

const PROGRAM_ID = new PublicKey("EnDRZxswjvqKQhnPuMY6m6AFK3sxCKRX2dokXxAYPYrP");

// ── Helpers ──────────────────────────────────────────────────────────────────

function ixDiscriminator(name: any): Buffer {
  const hash = createHash("sha256").update(`global:${name}`).digest();
  return hash.slice(0, 8);
}

function findAssetPDA(contentHash: Buffer): [any, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("hxq-asset"), contentHash],
    PROGRAM_ID
  );
}

function findExtraAccountMetaListPDA(mint: any): [any, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("extra-account-metas"), mint.toBuffer()],
    PROGRAM_ID
  );
}

function encodeF32(val: any): Buffer {
  const buf = Buffer.alloc(4);
  buf.writeFloatLE(val, 0);
  return buf;
}

function encodeU16LE(val: any): Buffer {
  const buf = Buffer.alloc(2);
  buf.writeUInt16LE(val, 0);
  return buf;
}

function encodeI16LE(val: any): Buffer {
  const buf = Buffer.alloc(2);
  buf.writeInt16LE(val, 0);
  return buf;
}

function encodeU32LE(val: any): Buffer {
  const buf = Buffer.alloc(4);
  buf.writeUInt32LE(val, 0);
  return buf;
}

function encodeU64LE(val: any): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt(val), 0);
  return buf;
}

// Build a register_asset instruction
function buildRegisterAssetIx(
  assetPDA: any,
  owner: any,
  params: any
): any {
  const { TransactionInstruction } = require("@solana/web3.js");
  const contentHash = Buffer.from(params.content_hash);
  const originalHash = Buffer.from(params.original_hash);
  const metadataHash = Buffer.from(params.metadata_hash);
  const artifactCid = Buffer.from(params.artifact_cid);

  const data = Buffer.concat([
    ixDiscriminator("register_asset"),
    contentHash,
    originalHash,
    Buffer.from([params.artifact_type]),
    encodeF32(params.threshold),
    metadataHash,
    Buffer.from([params.codec_id]),
    encodeU16LE(params.group_size),
    Buffer.from([params.bits_per_weight]),
    Buffer.from([params.architecture]),
    encodeF32(params.cosine_claim),
    encodeI16LE(params.ppl_delta_bps),
    artifactCid,
  ]);

  return new TransactionInstruction({
    keys: [
      { pubkey: assetPDA, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    programId: PROGRAM_ID,
    data,
  });
}

// Build a submit_fidelity_receipt instruction
function buildSubmitFidelityIx(assetPDA: any, owner: any, receiptHash: Buffer): any {
  const { TransactionInstruction } = require("@solana/web3.js");
  const data = Buffer.concat([
    ixDiscriminator("submit_fidelity_receipt"),
    receiptHash,
  ]);
  return new TransactionInstruction({
    keys: [
      { pubkey: assetPDA, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: false },
    ],
    programId: PROGRAM_ID,
    data,
  });
}

// Build a submit_behavioral_receipt instruction
function buildSubmitBehavioralIx(assetPDA: any, owner: any, receiptHash: Buffer): any {
  const { TransactionInstruction } = require("@solana/web3.js");
  const data = Buffer.concat([
    ixDiscriminator("submit_behavioral_receipt"),
    receiptHash,
  ]);
  return new TransactionInstruction({
    keys: [
      { pubkey: assetPDA, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: false },
    ],
    programId: PROGRAM_ID,
    data,
  });
}

// Build a promote_asset instruction
function buildPromoteIx(assetPDA: any, owner: any): any {
  const { TransactionInstruction } = require("@solana/web3.js");
  const data = ixDiscriminator("promote_asset");
  return new TransactionInstruction({
    keys: [
      { pubkey: assetPDA, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: false },
    ],
    programId: PROGRAM_ID,
    data,
  });
}

// Build a quarantine_asset instruction
function buildQuarantineIx(assetPDA: any, owner: any): any {
  const { TransactionInstruction } = require("@solana/web3.js");
  const data = ixDiscriminator("quarantine_asset");
  return new TransactionInstruction({
    keys: [
      { pubkey: assetPDA, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: false },
    ],
    programId: PROGRAM_ID,
    data,
  });
}

// Build initialize_extra_account_meta_list instruction
function buildInitExtraAccountMetaListIx(
  payer: any,
  extraAccountMetaListPDA: any,
  mint: any,
  assetPDA: any,
): any {
  const { TransactionInstruction } = require("@solana/web3.js");
  const data = ixDiscriminator("initialize_extra_account_meta_list");
  return new TransactionInstruction({
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: extraAccountMetaListPDA, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: assetPDA, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    programId: PROGRAM_ID,
    data,
  });
}

// ── Test Suite ────────────────────────────────────────────────────────────────

describe("HXQ Transfer Hook", () => {
  const url = process.env.ANCHOR_PROVIDER_URL || "http://localhost:8899";
  const { Connection } = require("@solana/web3.js");
  const connection = new Connection(url, "confirmed");
  const fs = require("fs");
  const path = require("path");

  const walletPath =
    process.env.ANCHOR_WALLET ||
    path.join(process.env.HOME, ".config/solana/id.json");
  const keypairData = JSON.parse(fs.readFileSync(walletPath, "utf-8"));
  const owner = Keypair.fromSecretKey(Uint8Array.from(keypairData));

  // Test asset params (same structure as e2e demo but unique content hash)
  const testContentHash = createHash("sha256")
    .update("hxq-transfer-hook-test-" + Date.now())
    .digest();
  const testOriginalHash = createHash("sha256")
    .update("original-test-data")
    .digest();
  const testMetadataHash = createHash("sha256")
    .update("metadata-test")
    .digest();
  const testArtifactCid = createHash("sha256")
    .update("artifact-cid-test")
    .digest();
  const fidelityReceiptHash = createHash("sha256")
    .update("fidelity-receipt-verified")
    .digest();
  const behavioralReceiptHash = createHash("sha256")
    .update("behavioral-receipt-verified")
    .digest();

  const assetParams = {
    content_hash: [...testContentHash],
    original_hash: [...testOriginalHash],
    artifact_type: 0, // AI tensor
    threshold: 0.998,
    metadata_hash: [...testMetadataHash],
    codec_id: 0, // Affine6
    group_size: 128,
    bits_per_weight: 6,
    architecture: 0, // Transformer
    cosine_claim: 0.999723,
    ppl_delta_bps: 0,
    artifact_cid: [...testArtifactCid],
  };

  const [assetPDA] = findAssetPDA(testContentHash);
  const mintKeypair = Keypair.generate();
  const [extraAccountMetaListPDA] = findExtraAccountMetaListPDA(
    mintKeypair.publicKey
  );

  const decimals = 0;
  let recipientKeypair: any;
  let sourceATA: any;
  let destATA: any;

  before(async () => {
    recipientKeypair = Keypair.generate();

    // Airdrop to owner if needed
    const balance = await connection.getBalance(owner.publicKey);
    if (balance < 2 * LAMPORTS_PER_SOL) {
      const sig = await connection.requestAirdrop(
        owner.publicKey,
        5 * LAMPORTS_PER_SOL
      );
      await connection.confirmTransaction(sig);
    }
  });

  it("1. Register the HXQ asset", async () => {
    const ix = buildRegisterAssetIx(assetPDA, owner.publicKey, assetParams);
    const tx = new Transaction().add(ix);
    const sig = await sendAndConfirmTransaction(connection, tx, [owner]);
    console.log("  Register asset sig:", sig.slice(0, 20) + "...");

    const info = await connection.getAccountInfo(assetPDA);
    expect(info).to.not.be.null;
    expect(info.data.length).to.equal(302);
    expect(info.data[184]).to.equal(0); // Candidate
  });

  it("2. Submit fidelity + behavioral receipts and promote to Active", async () => {
    // Submit fidelity receipt
    const ix1 = buildSubmitFidelityIx(
      assetPDA,
      owner.publicKey,
      fidelityReceiptHash
    );
    // Submit behavioral receipt
    const ix2 = buildSubmitBehavioralIx(
      assetPDA,
      owner.publicKey,
      behavioralReceiptHash
    );
    // Promote
    const ix3 = buildPromoteIx(assetPDA, owner.publicKey);

    const tx = new Transaction().add(ix1).add(ix2).add(ix3);
    const sig = await sendAndConfirmTransaction(connection, tx, [owner]);
    console.log("  Promote sig:", sig.slice(0, 20) + "...");

    const info = await connection.getAccountInfo(assetPDA);
    expect(info.data[184]).to.equal(1); // Active
  });

  it("3. Create Token-2022 mint with TransferHook extension", async () => {
    const mintLen = getMintLen([ExtensionType.TransferHook]);
    const lamports = await connection.getMinimumBalanceForRentExemption(mintLen);

    const tx = new Transaction().add(
      // Create account for the mint
      SystemProgram.createAccount({
        fromPubkey: owner.publicKey,
        newAccountPubkey: mintKeypair.publicKey,
        space: mintLen,
        lamports,
        programId: TOKEN_2022_PROGRAM_ID,
      }),
      // Initialize TransferHook extension — points to our HXQ program
      createInitializeTransferHookInstruction(
        mintKeypair.publicKey,
        owner.publicKey, // authority
        PROGRAM_ID, // transfer hook program
        TOKEN_2022_PROGRAM_ID
      ),
      // Initialize the mint itself
      createInitializeMintInstruction(
        mintKeypair.publicKey,
        decimals,
        owner.publicKey, // mint authority
        null, // freeze authority
        TOKEN_2022_PROGRAM_ID
      )
    );

    const sig = await sendAndConfirmTransaction(connection, tx, [
      owner,
      mintKeypair,
    ]);
    console.log("  Create mint sig:", sig.slice(0, 20) + "...");
    console.log("  Mint:", mintKeypair.publicKey.toBase58());
  });

  it("4. Initialize extra account meta list (link mint → asset)", async () => {
    const ix = buildInitExtraAccountMetaListIx(
      owner.publicKey,
      extraAccountMetaListPDA,
      mintKeypair.publicKey,
      assetPDA
    );
    const tx = new Transaction().add(ix);
    const sig = await sendAndConfirmTransaction(connection, tx, [owner]);
    console.log("  Init meta list sig:", sig.slice(0, 20) + "...");

    // Verify the PDA was created
    const info = await connection.getAccountInfo(extraAccountMetaListPDA);
    expect(info).to.not.be.null;
    expect(info.owner.toBase58()).to.equal(PROGRAM_ID.toBase58());
  });

  it("5. Create token accounts and mint tokens", async () => {
    sourceATA = getAssociatedTokenAddressSync(
      mintKeypair.publicKey,
      owner.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );
    destATA = getAssociatedTokenAddressSync(
      mintKeypair.publicKey,
      recipientKeypair.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );

    const tx = new Transaction()
      .add(
        createAssociatedTokenAccountInstruction(
          owner.publicKey,
          sourceATA,
          owner.publicKey,
          mintKeypair.publicKey,
          TOKEN_2022_PROGRAM_ID,
          ASSOCIATED_TOKEN_PROGRAM_ID
        )
      )
      .add(
        createAssociatedTokenAccountInstruction(
          owner.publicKey,
          destATA,
          recipientKeypair.publicKey,
          mintKeypair.publicKey,
          TOKEN_2022_PROGRAM_ID,
          ASSOCIATED_TOKEN_PROGRAM_ID
        )
      )
      .add(
        createMintToInstruction(
          mintKeypair.publicKey,
          sourceATA,
          owner.publicKey,
          100, // mint 100 tokens
          [],
          TOKEN_2022_PROGRAM_ID
        )
      );

    const sig = await sendAndConfirmTransaction(connection, tx, [owner]);
    console.log("  Mint tokens sig:", sig.slice(0, 20) + "...");
  });

  it("6. Transfer tokens — should SUCCEED (Active asset, cosine above gate)", async () => {
    // createTransferCheckedWithTransferHookInstruction resolves extra accounts
    const transferIx = await createTransferCheckedWithTransferHookInstruction(
      connection,
      sourceATA,
      mintKeypair.publicKey,
      destATA,
      owner.publicKey,
      BigInt(10), // transfer 10 tokens
      decimals,
      [],
      "confirmed",
      TOKEN_2022_PROGRAM_ID
    );

    const tx = new Transaction().add(transferIx);
    const sig = await sendAndConfirmTransaction(connection, tx, [owner]);
    console.log("  Transfer (Active) sig:", sig.slice(0, 20) + "...");
    console.log("  Transfer SUCCEEDED as expected (asset Active, cosine PASS)");
  });

  it("7. Quarantine asset", async () => {
    const ix = buildQuarantineIx(assetPDA, owner.publicKey);
    const tx = new Transaction().add(ix);
    const sig = await sendAndConfirmTransaction(connection, tx, [owner]);
    console.log("  Quarantine sig:", sig.slice(0, 20) + "...");

    const info = await connection.getAccountInfo(assetPDA);
    expect(info.data[184]).to.equal(2); // Quarantined
  });

  it("8. Transfer tokens — should FAIL (Quarantined asset)", async () => {
    try {
      const transferIx =
        await createTransferCheckedWithTransferHookInstruction(
          connection,
          sourceATA,
          mintKeypair.publicKey,
          destATA,
          owner.publicKey,
          BigInt(10),
          decimals,
          [],
          "confirmed",
          TOKEN_2022_PROGRAM_ID
        );

      const tx = new Transaction().add(transferIx);
      await sendAndConfirmTransaction(connection, tx, [owner]);

      // Should not reach here
      expect.fail("Transfer should have been blocked by quarantine");
    } catch (err: any) {
      console.log("  Transfer correctly BLOCKED:", err.message.slice(0, 80));
      // The error should come from our transfer hook
      expect(err.message).to.include("failed");
    }
  });
});
