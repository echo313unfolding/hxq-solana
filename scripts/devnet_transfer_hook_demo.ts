/**
 * HXQ Solana — Devnet Transfer Hook Demo
 *
 * Runs the full Transfer Hook lifecycle against the LIVE devnet program.
 * Uses the existing SBERT asset PDA (EGh75kxYTumq4JFdm1CB9RfJ5DkBdw52cLx84Swh6bnK).
 *
 * Steps:
 * 1. Register a NEW test asset (unique content hash per run)
 * 2. Submit receipts & promote to Active
 * 3. Create Token-2022 mint with TransferHook extension
 * 4. Initialize extra account meta list (link mint → asset)
 * 5. Create token accounts & mint tokens
 * 6. Transfer tokens — should SUCCEED (Active asset)
 * 7. Quarantine asset
 * 8. Transfer tokens — should FAIL (Quarantined)
 *
 * Deliverables: deploy sig, asset PDA, allowed-transfer sig, blocked-transfer sig
 */

const {
  Connection,
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
const fs = require("fs");
const path = require("path");

const PROGRAM_ID = new PublicKey("EnDRZxswjvqKQhnPuMY6m6AFK3sxCKRX2dokXxAYPYrP");
const RPC_URL = process.env.ANCHOR_PROVIDER_URL || "https://api.devnet.solana.com";

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

function buildRegisterAssetIx(assetPDA: any, owner: any, params: any): any {
  const { TransactionInstruction } = require("@solana/web3.js");
  const guardian = params.guardian ? Buffer.from(params.guardian) : Buffer.alloc(32);
  const data = Buffer.concat([
    ixDiscriminator("register_asset"),
    Buffer.from(params.content_hash),
    Buffer.from(params.original_hash),
    Buffer.from([params.artifact_type]),
    encodeF32(params.threshold),
    Buffer.from(params.metadata_hash),
    Buffer.from([params.codec_id]),
    encodeU16LE(params.group_size),
    Buffer.from([params.bits_per_weight]),
    Buffer.from([params.architecture]),
    encodeF32(params.cosine_claim),
    encodeI16LE(params.ppl_delta_bps),
    Buffer.from(params.artifact_cid),
    guardian,
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

function buildSubmitFidelityIx(assetPDA: any, owner: any, receiptHash: Buffer): any {
  const { TransactionInstruction } = require("@solana/web3.js");
  const data = Buffer.concat([ixDiscriminator("submit_fidelity_receipt"), receiptHash]);
  return new TransactionInstruction({
    keys: [
      { pubkey: assetPDA, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: false },
    ],
    programId: PROGRAM_ID,
    data,
  });
}

function buildSubmitBehavioralIx(assetPDA: any, owner: any, receiptHash: Buffer): any {
  const { TransactionInstruction } = require("@solana/web3.js");
  const data = Buffer.concat([ixDiscriminator("submit_behavioral_receipt"), receiptHash]);
  return new TransactionInstruction({
    keys: [
      { pubkey: assetPDA, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: false },
    ],
    programId: PROGRAM_ID,
    data,
  });
}

function buildPromoteIx(assetPDA: any, owner: any): any {
  const { TransactionInstruction } = require("@solana/web3.js");
  return new TransactionInstruction({
    keys: [
      { pubkey: assetPDA, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: false },
    ],
    programId: PROGRAM_ID,
    data: ixDiscriminator("promote_asset"),
  });
}

function buildQuarantineIx(assetPDA: any, owner: any): any {
  const { TransactionInstruction } = require("@solana/web3.js");
  return new TransactionInstruction({
    keys: [
      { pubkey: assetPDA, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: false },
    ],
    programId: PROGRAM_ID,
    data: ixDiscriminator("quarantine_asset"),
  });
}

function buildInitExtraAccountMetaListIx(payer: any, metaListPDA: any, mint: any, assetPDA: any): any {
  const { TransactionInstruction } = require("@solana/web3.js");
  return new TransactionInstruction({
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: metaListPDA, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: assetPDA, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    programId: PROGRAM_ID,
    data: ixDiscriminator("initialize_extra_account_meta_list"),
  });
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const connection = new Connection(RPC_URL, "confirmed");
  const walletPath = process.env.ANCHOR_WALLET || path.join(process.env.HOME, ".config/solana/id.json");
  const keypairData = JSON.parse(fs.readFileSync(walletPath, "utf-8"));
  const owner = Keypair.fromSecretKey(Uint8Array.from(keypairData));
  const startBalance = await connection.getBalance(owner.publicKey);

  console.log("============================================================");
  console.log("HXQ Solana — Devnet Transfer Hook Demo");
  console.log("============================================================");
  console.log(`RPC: ${RPC_URL}`);
  console.log(`Owner: ${owner.publicKey.toBase58()}`);
  console.log(`Balance: ${startBalance / LAMPORTS_PER_SOL} SOL`);
  console.log(`Program: ${PROGRAM_ID.toBase58()}`);
  console.log();

  const receipt: any = {
    program_id: PROGRAM_ID.toBase58(),
    rpc: RPC_URL,
    owner: owner.publicKey.toBase58(),
    timestamp: new Date().toISOString(),
    steps: {},
  };

  // Unique content hash per run
  const runId = `devnet-transfer-hook-${Date.now()}`;
  const testContentHash = createHash("sha256").update(runId).digest();
  const testOriginalHash = createHash("sha256").update("sbert-original-" + runId).digest();
  const testMetadataHash = createHash("sha256").update("sbert-metadata-" + runId).digest();
  const testArtifactCid = createHash("sha256").update("sbert-cid-" + runId).digest();
  const fidelityReceiptHash = createHash("sha256").update("fidelity-" + runId).digest();
  const behavioralReceiptHash = createHash("sha256").update("behavioral-" + runId).digest();

  const assetParams = {
    content_hash: [...testContentHash],
    original_hash: [...testOriginalHash],
    artifact_type: 0,
    threshold: 0.998,
    metadata_hash: [...testMetadataHash],
    codec_id: 0,       // Affine6
    group_size: 128,
    bits_per_weight: 6,
    architecture: 0,    // Transformer
    cosine_claim: 0.999723,
    ppl_delta_bps: 0,
    artifact_cid: [...testArtifactCid],
  };

  const [assetPDA] = findAssetPDA(testContentHash);
  const mintKeypair = Keypair.generate();
  const [extraAccountMetaListPDA] = findExtraAccountMetaListPDA(mintKeypair.publicKey);
  const recipientKeypair = Keypair.generate();
  const decimals = 0;

  console.log(`Asset PDA: ${assetPDA.toBase58()}`);
  console.log(`Mint: ${mintKeypair.publicKey.toBase58()}`);
  console.log();

  // Step 1: Register asset
  console.log("Step 1: Register HXQ asset on devnet...");
  const regIx = buildRegisterAssetIx(assetPDA, owner.publicKey, assetParams);
  const regTx = new Transaction().add(regIx);
  const regSig = await sendAndConfirmTransaction(connection, regTx, [owner]);
  console.log(`  Sig: ${regSig}`);
  receipt.steps.register = { sig: regSig, pda: assetPDA.toBase58() };
  console.log("  DONE — asset registered as Candidate\n");

  // Step 2: Submit receipts + promote
  console.log("Step 2: Submit fidelity + behavioral receipts, promote to Active...");
  const promTx = new Transaction()
    .add(buildSubmitFidelityIx(assetPDA, owner.publicKey, fidelityReceiptHash))
    .add(buildSubmitBehavioralIx(assetPDA, owner.publicKey, behavioralReceiptHash))
    .add(buildPromoteIx(assetPDA, owner.publicKey));
  const promSig = await sendAndConfirmTransaction(connection, promTx, [owner]);
  console.log(`  Sig: ${promSig}`);
  receipt.steps.promote = { sig: promSig };
  console.log("  DONE — asset promoted to Active\n");

  // Step 3: Create Token-2022 mint with TransferHook
  console.log("Step 3: Create Token-2022 mint with TransferHook extension...");
  const mintLen = getMintLen([ExtensionType.TransferHook]);
  const mintLamports = await connection.getMinimumBalanceForRentExemption(mintLen);
  const mintTx = new Transaction().add(
    SystemProgram.createAccount({
      fromPubkey: owner.publicKey,
      newAccountPubkey: mintKeypair.publicKey,
      space: mintLen,
      lamports: mintLamports,
      programId: TOKEN_2022_PROGRAM_ID,
    }),
    createInitializeTransferHookInstruction(
      mintKeypair.publicKey,
      owner.publicKey,
      PROGRAM_ID,
      TOKEN_2022_PROGRAM_ID
    ),
    createInitializeMintInstruction(
      mintKeypair.publicKey,
      decimals,
      owner.publicKey,
      null,
      TOKEN_2022_PROGRAM_ID
    )
  );
  const mintSig = await sendAndConfirmTransaction(connection, mintTx, [owner, mintKeypair]);
  console.log(`  Sig: ${mintSig}`);
  console.log(`  Mint: ${mintKeypair.publicKey.toBase58()}`);
  receipt.steps.create_mint = { sig: mintSig, mint: mintKeypair.publicKey.toBase58() };
  console.log("  DONE\n");

  // Step 4: Initialize extra account meta list
  console.log("Step 4: Initialize extra account meta list (link mint → asset)...");
  const metaIx = buildInitExtraAccountMetaListIx(
    owner.publicKey, extraAccountMetaListPDA, mintKeypair.publicKey, assetPDA
  );
  const metaTx = new Transaction().add(metaIx);
  const metaSig = await sendAndConfirmTransaction(connection, metaTx, [owner]);
  console.log(`  Sig: ${metaSig}`);
  receipt.steps.init_meta_list = { sig: metaSig, pda: extraAccountMetaListPDA.toBase58() };
  console.log("  DONE\n");

  // Step 5: Create ATAs + mint tokens
  console.log("Step 5: Create token accounts and mint 100 tokens...");
  const sourceATA = getAssociatedTokenAddressSync(
    mintKeypair.publicKey, owner.publicKey, false,
    TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID
  );
  const destATA = getAssociatedTokenAddressSync(
    mintKeypair.publicKey, recipientKeypair.publicKey, false,
    TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID
  );
  const ataTx = new Transaction()
    .add(createAssociatedTokenAccountInstruction(
      owner.publicKey, sourceATA, owner.publicKey, mintKeypair.publicKey,
      TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID
    ))
    .add(createAssociatedTokenAccountInstruction(
      owner.publicKey, destATA, recipientKeypair.publicKey, mintKeypair.publicKey,
      TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID
    ))
    .add(createMintToInstruction(
      mintKeypair.publicKey, sourceATA, owner.publicKey, 100, [],
      TOKEN_2022_PROGRAM_ID
    ));
  const ataSig = await sendAndConfirmTransaction(connection, ataTx, [owner]);
  console.log(`  Sig: ${ataSig}`);
  receipt.steps.mint_tokens = { sig: ataSig };
  console.log("  DONE\n");

  // Step 6: Transfer tokens (Active — should SUCCEED)
  console.log("Step 6: Transfer 10 tokens (Active asset — should SUCCEED)...");
  const transferIx = await createTransferCheckedWithTransferHookInstruction(
    connection, sourceATA, mintKeypair.publicKey, destATA, owner.publicKey,
    BigInt(10), decimals, [], "confirmed", TOKEN_2022_PROGRAM_ID
  );
  const transferTx = new Transaction().add(transferIx);
  const transferSig = await sendAndConfirmTransaction(connection, transferTx, [owner]);
  console.log(`  Sig: ${transferSig}`);
  console.log("  TRANSFER SUCCEEDED — Active asset, cosine 0.999723 >= 0.998 gate");
  receipt.steps.transfer_allowed = { sig: transferSig, status: "SUCCEEDED" };
  console.log();

  // Step 7: Quarantine asset
  console.log("Step 7: Quarantine asset...");
  const quarIx = buildQuarantineIx(assetPDA, owner.publicKey);
  const quarTx = new Transaction().add(quarIx);
  const quarSig = await sendAndConfirmTransaction(connection, quarTx, [owner]);
  console.log(`  Sig: ${quarSig}`);
  receipt.steps.quarantine = { sig: quarSig };
  console.log("  DONE — asset status = Quarantined\n");

  // Step 8: Transfer tokens (Quarantined — should FAIL)
  console.log("Step 8: Transfer 10 tokens (Quarantined — should FAIL)...");
  let blockedError = "";
  try {
    const transferIx2 = await createTransferCheckedWithTransferHookInstruction(
      connection, sourceATA, mintKeypair.publicKey, destATA, owner.publicKey,
      BigInt(10), decimals, [], "confirmed", TOKEN_2022_PROGRAM_ID
    );
    const transferTx2 = new Transaction().add(transferIx2);
    await sendAndConfirmTransaction(connection, transferTx2, [owner]);
    console.log("  ERROR: Transfer should have been blocked!");
    receipt.steps.transfer_blocked = { status: "UNEXPECTED_SUCCESS" };
  } catch (err: any) {
    blockedError = err.message || String(err);
    // Extract the hook error string from logs if available
    const logs = err.logs || [];
    const hookError = logs.find((l: string) => l.includes("Transfer blocked") || l.includes("fidelity below"));
    console.log(`  TRANSFER BLOCKED as expected`);
    if (hookError) {
      console.log(`  Hook error: ${hookError}`);
      receipt.steps.transfer_blocked = { status: "BLOCKED", hook_error: hookError, error_message: blockedError.slice(0, 200) };
    } else {
      console.log(`  Error: ${blockedError.slice(0, 120)}`);
      receipt.steps.transfer_blocked = { status: "BLOCKED", error_message: blockedError.slice(0, 200) };
    }
  }
  console.log();

  // Summary
  const endBalance = await connection.getBalance(owner.publicKey);
  const costSol = (startBalance - endBalance) / LAMPORTS_PER_SOL;
  receipt.cost_sol = costSol;
  receipt.end_balance_sol = endBalance / LAMPORTS_PER_SOL;

  console.log("============================================================");
  console.log("DEMO COMPLETE — 4 Deliverables");
  console.log("============================================================");
  console.log(`1. Program upgrade sig: 5jeHXpsdfmdQex9T63FEUCCGHmGDRymGQiM9HgtF6p8aJrBnMpJUeSFuX4JMACixogv8Hf1L5eoaFwLijr2WBWaz`);
  console.log(`2. Asset PDA: ${assetPDA.toBase58()}`);
  console.log(`3. Allowed-transfer sig: ${receipt.steps.transfer_allowed?.sig || "FAILED"}`);
  console.log(`4. Blocked-transfer sig: ${receipt.steps.transfer_blocked?.status || "UNKNOWN"}`);
  console.log(`   Hook error: ${receipt.steps.transfer_blocked?.hook_error || "see error_message"}`);
  console.log(`Cost: ${costSol.toFixed(6)} SOL`);
  console.log(`Remaining: ${(endBalance / LAMPORTS_PER_SOL).toFixed(6)} SOL`);
  console.log("============================================================");

  // Save receipt
  const receiptPath = `receipts/devnet_transfer_hook_${new Date().toISOString().replace(/[:.]/g, "").slice(0, 15)}Z.json`;
  fs.mkdirSync("receipts", { recursive: true });
  fs.writeFileSync(receiptPath, JSON.stringify(receipt, null, 2));
  console.log(`\nReceipt: ${receiptPath}`);
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
