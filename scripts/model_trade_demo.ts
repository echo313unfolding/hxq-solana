/**
 * HXQ Solana — Model Trading Demo
 *
 * Full end-to-end flow:
 * 1. Register REAL SBERT embedding layer on-chain
 * 2. Submit fidelity + behavioral receipts
 * 3. Promote to Active
 * 4. Create Token-2022 mint with TransferHook
 * 5. Initialize extra account meta list (link mint → asset)
 * 6. Mint tokens to creator
 * 7. Transfer tokens creator → buyer (should SUCCEED)
 * 8. Verify buyer received tokens
 * 9. Print full trade receipt
 *
 * Usage:
 *   ANCHOR_PROVIDER_URL=http://localhost:8899 \
 *   ANCHOR_WALLET=~/.config/solana/id.json \
 *   npx ts-node scripts/model_trade_demo.ts
 */

const {
  Keypair,
  PublicKey,
  SystemProgram,
  Connection,
  Transaction,
  TransactionInstruction,
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
  getAccount,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} = require("@solana/spl-token");
const { createHash } = require("crypto");
const fs = require("fs");
const path = require("path");

const PROGRAM_ID = new PublicKey("EnDRZxswjvqKQhnPuMY6m6AFK3sxCKRX2dokXxAYPYrP");

// ── Helpers ──────────────────────────────────────────────────────────────────

function ixDiscriminator(name: any): Buffer {
  return createHash("sha256").update(`global:${name}`).digest().slice(0, 8);
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

async function main() {
  console.log("=".repeat(65));
  console.log("HXQ Solana — Model Trading Demo");
  console.log("Real SBERT Embedding Layer: all-MiniLM-L6-v2");
  console.log("=".repeat(65));

  // ── Setup ────────────────────────────────────────────────────────────────

  const url = process.env.ANCHOR_PROVIDER_URL || "http://localhost:8899";
  const connection = new Connection(url, "confirmed");
  console.log("\nRPC:", url);

  const walletPath =
    process.env.ANCHOR_WALLET ||
    path.join(process.env.HOME!, ".config/solana/id.json");
  const keypairData = JSON.parse(fs.readFileSync(walletPath, "utf-8"));
  const creator = Keypair.fromSecretKey(Uint8Array.from(keypairData));
  console.log("Creator (seller):", creator.publicKey.toBase58());

  // Generate a buyer keypair
  const buyer = Keypair.generate();
  console.log("Buyer:", buyer.publicKey.toBase58());

  // Fund buyer (localnet)
  if (url.includes("localhost")) {
    const sig = await connection.requestAirdrop(buyer.publicKey, 1 * LAMPORTS_PER_SOL);
    await connection.confirmTransaction(sig);
    console.log("Buyer funded: 1 SOL (localnet airdrop)");
  }

  // Load register params from the real SBERT layer
  const paramsFile = "artifacts/sbert_real_layer/register_params.json";
  const params = JSON.parse(fs.readFileSync(paramsFile, "utf-8"));
  console.log("\nLoaded params from:", paramsFile);

  const contentHash = Buffer.from(params.content_hash);
  const [assetPDA] = findAssetPDA(contentHash);
  console.log("Asset PDA:", assetPDA.toBase58());

  // ── Step 1: Register the real SBERT layer ──────────────────────────────

  console.log("\n── Step 1: Register SBERT embedding layer on-chain ──");

  const guardian = params.guardian ? Buffer.from(params.guardian) : Buffer.alloc(32);
  const registerData = Buffer.concat([
    ixDiscriminator("register_asset"),
    contentHash,
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

  const registerIx = new TransactionInstruction({
    keys: [
      { pubkey: assetPDA, isSigner: false, isWritable: true },
      { pubkey: creator.publicKey, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    programId: PROGRAM_ID,
    data: registerData,
  });

  let sig = await sendAndConfirmTransaction(
    connection,
    new Transaction().add(registerIx),
    [creator]
  );
  console.log("  Registered! Sig:", sig.slice(0, 30) + "...");

  // ── Step 2: Submit fidelity + behavioral receipts ──────────────────────

  console.log("\n── Step 2: Submit fidelity + behavioral receipts ──");

  const fidelityHash = createHash("sha256")
    .update("fidelity-receipt:real-sbert-cos-0.999720")
    .digest();
  const behavioralHash = createHash("sha256")
    .update("behavioral-receipt:sentence-embeddings-0.999888-mean")
    .digest();

  const fidelityIx = new TransactionInstruction({
    keys: [
      { pubkey: assetPDA, isSigner: false, isWritable: true },
      { pubkey: creator.publicKey, isSigner: true, isWritable: false },
    ],
    programId: PROGRAM_ID,
    data: Buffer.concat([ixDiscriminator("submit_fidelity_receipt"), fidelityHash]),
  });

  const behavioralIx = new TransactionInstruction({
    keys: [
      { pubkey: assetPDA, isSigner: false, isWritable: true },
      { pubkey: creator.publicKey, isSigner: true, isWritable: false },
    ],
    programId: PROGRAM_ID,
    data: Buffer.concat([ixDiscriminator("submit_behavioral_receipt"), behavioralHash]),
  });

  sig = await sendAndConfirmTransaction(
    connection,
    new Transaction().add(fidelityIx).add(behavioralIx),
    [creator]
  );
  console.log("  Receipts submitted! Sig:", sig.slice(0, 30) + "...");

  // ── Step 3: Promote to Active ──────────────────────────────────────────

  console.log("\n── Step 3: Promote asset to Active ──");

  const promoteIx = new TransactionInstruction({
    keys: [
      { pubkey: assetPDA, isSigner: false, isWritable: true },
      { pubkey: creator.publicKey, isSigner: true, isWritable: false },
    ],
    programId: PROGRAM_ID,
    data: ixDiscriminator("promote_asset"),
  });

  sig = await sendAndConfirmTransaction(
    connection,
    new Transaction().add(promoteIx),
    [creator]
  );
  console.log("  Promoted to Active! Sig:", sig.slice(0, 30) + "...");

  // Verify status
  const assetInfo = await connection.getAccountInfo(assetPDA);
  const status = assetInfo!.data[184];
  console.log("  Status byte:", status, status === 1 ? "(Active)" : "(UNEXPECTED)");

  // ── Step 4: Create Token-2022 mint with TransferHook ───────────────────

  console.log("\n── Step 4: Create Token-2022 mint with TransferHook ──");

  const mintKeypair = Keypair.generate();
  const decimals = 0; // NFT-like: each token = 1 license
  const mintLen = getMintLen([ExtensionType.TransferHook]);
  const mintLamports = await connection.getMinimumBalanceForRentExemption(mintLen);

  const createMintTx = new Transaction().add(
    SystemProgram.createAccount({
      fromPubkey: creator.publicKey,
      newAccountPubkey: mintKeypair.publicKey,
      space: mintLen,
      lamports: mintLamports,
      programId: TOKEN_2022_PROGRAM_ID,
    }),
    createInitializeTransferHookInstruction(
      mintKeypair.publicKey,
      creator.publicKey,
      PROGRAM_ID,
      TOKEN_2022_PROGRAM_ID
    ),
    createInitializeMintInstruction(
      mintKeypair.publicKey,
      decimals,
      creator.publicKey,
      null,
      TOKEN_2022_PROGRAM_ID
    )
  );

  sig = await sendAndConfirmTransaction(connection, createMintTx, [
    creator,
    mintKeypair,
  ]);
  console.log("  Mint created:", mintKeypair.publicKey.toBase58());
  console.log("  Sig:", sig.slice(0, 30) + "...");

  // ── Step 5: Initialize extra account meta list ─────────────────────────

  console.log("\n── Step 5: Link mint to asset (extra account meta list) ──");

  const [extraMetaPDA] = findExtraAccountMetaListPDA(mintKeypair.publicKey);

  const initMetaIx = new TransactionInstruction({
    keys: [
      { pubkey: creator.publicKey, isSigner: true, isWritable: true },
      { pubkey: extraMetaPDA, isSigner: false, isWritable: true },
      { pubkey: mintKeypair.publicKey, isSigner: false, isWritable: false },
      { pubkey: assetPDA, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    programId: PROGRAM_ID,
    data: ixDiscriminator("initialize_extra_account_meta_list"),
  });

  sig = await sendAndConfirmTransaction(
    connection,
    new Transaction().add(initMetaIx),
    [creator]
  );
  console.log("  Linked! Extra meta PDA:", extraMetaPDA.toBase58());
  console.log("  Sig:", sig.slice(0, 30) + "...");

  // ── Step 6: Mint tokens to creator ─────────────────────────────────────

  console.log("\n── Step 6: Mint license tokens to creator ──");

  const creatorATA = getAssociatedTokenAddressSync(
    mintKeypair.publicKey,
    creator.publicKey,
    false,
    TOKEN_2022_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );

  const buyerATA = getAssociatedTokenAddressSync(
    mintKeypair.publicKey,
    buyer.publicKey,
    false,
    TOKEN_2022_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );

  const mintTokensTx = new Transaction()
    .add(
      createAssociatedTokenAccountInstruction(
        creator.publicKey,
        creatorATA,
        creator.publicKey,
        mintKeypair.publicKey,
        TOKEN_2022_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID
      )
    )
    .add(
      createAssociatedTokenAccountInstruction(
        creator.publicKey,
        buyerATA,
        buyer.publicKey,
        mintKeypair.publicKey,
        TOKEN_2022_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID
      )
    )
    .add(
      createMintToInstruction(
        mintKeypair.publicKey,
        creatorATA,
        creator.publicKey,
        10, // 10 license tokens
        [],
        TOKEN_2022_PROGRAM_ID
      )
    );

  sig = await sendAndConfirmTransaction(connection, mintTokensTx, [creator]);
  console.log("  Minted 10 license tokens to creator");
  console.log("  Creator ATA:", creatorATA.toBase58());
  console.log("  Buyer ATA:", buyerATA.toBase58());

  // ── Step 7: Transfer creator → buyer (the actual trade) ────────────────

  console.log("\n── Step 7: TRADE — Transfer 1 license token creator → buyer ──");
  console.log("  (TransferHook will verify asset quality before allowing transfer)");

  const transferIx = await createTransferCheckedWithTransferHookInstruction(
    connection,
    creatorATA,
    mintKeypair.publicKey,
    buyerATA,
    creator.publicKey,
    BigInt(1), // 1 license token
    decimals,
    [],
    "confirmed",
    TOKEN_2022_PROGRAM_ID
  );

  const transferSig = await sendAndConfirmTransaction(
    connection,
    new Transaction().add(transferIx),
    [creator]
  );
  console.log("  TRADE SUCCESSFUL!");
  console.log("  Signature:", transferSig);

  // ── Step 8: Verify balances ────────────────────────────────────────────

  console.log("\n── Step 8: Verify final balances ──");

  const creatorAccount = await getAccount(
    connection,
    creatorATA,
    "confirmed",
    TOKEN_2022_PROGRAM_ID
  );
  const buyerAccount = await getAccount(
    connection,
    buyerATA,
    "confirmed",
    TOKEN_2022_PROGRAM_ID
  );

  console.log("  Creator balance:", Number(creatorAccount.amount), "tokens");
  console.log("  Buyer balance:  ", Number(buyerAccount.amount), "tokens");

  // ── Step 9: Print trade receipt ────────────────────────────────────────

  console.log("\n" + "=".repeat(65));
  console.log("MODEL TRADE COMPLETE");
  console.log("=".repeat(65));

  const tradeReceipt = {
    receipt_id: `hxq-model-trade-${new Date().toISOString().replace(/[-:T]/g, "").slice(0, 15)}Z`,
    description: "Real SBERT embedding layer traded creator→buyer with quality-gated transfer",
    network: url.includes("devnet") ? "devnet" : "localnet",
    model: "all-MiniLM-L6-v2",
    layer: "embeddings.word_embeddings.weight",
    shape: [30522, 384],
    total_elements: 11720448,
    cosine_claim: params.cosine_claim,
    gate_pass: true,
    program_id: PROGRAM_ID.toBase58(),
    asset_pda: assetPDA.toBase58(),
    mint: mintKeypair.publicKey.toBase58(),
    creator: creator.publicKey.toBase58(),
    buyer: buyer.publicKey.toBase58(),
    transfer_signature: transferSig,
    creator_balance_after: Number(creatorAccount.amount),
    buyer_balance_after: Number(buyerAccount.amount),
    transfer_hook_enforced: true,
    timestamp: new Date().toISOString(),
  };

  const receiptPath = "receipts/model_trade_" +
    new Date().toISOString().replace(/[-:T]/g, "").slice(0, 15) + "Z.json";
  fs.writeFileSync(receiptPath, JSON.stringify(tradeReceipt, null, 2));
  console.log("\nTrade receipt saved:", receiptPath);

  console.log("\nSummary:");
  console.log("  Asset:    SBERT embeddings.word_embeddings.weight (11.7M params)");
  console.log("  Fidelity: cos=" + params.cosine_claim + " (gate PASS)");
  console.log("  Hook:     TransferHook verified quality before allowing transfer");
  console.log("  Result:   1 license token transferred creator → buyer");
  console.log("  Explorer:", `https://explorer.solana.com/tx/${transferSig}?cluster=${url.includes("devnet") ? "devnet" : "custom&customUrl=" + encodeURIComponent(url)}`);
}

main().catch(console.error);
