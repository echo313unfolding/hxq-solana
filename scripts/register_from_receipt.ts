/**
 * HXQ Solana — Register artifact from receipt params
 *
 * Reads register_params.json from the e2e script and submits
 * a register_asset transaction to localnet or devnet.
 *
 * Usage:
 *   ANCHOR_PROVIDER_URL=http://localhost:8899 \
 *   ANCHOR_WALLET=~/.config/solana/id.json \
 *   npx ts-node scripts/register_from_receipt.ts artifacts/sbert_demo/register_params.json
 */

const {
  Keypair,
  PublicKey,
  SystemProgram,
  Connection,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} = require("@solana/web3.js");
const { createHash } = require("crypto");
const fs = require("fs");
const path = require("path");

const PROGRAM_ID = new PublicKey("EnDRZxswjvqKQhnPuMY6m6AFK3sxCKRX2dokXxAYPYrP");

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
  const paramsFile = process.argv[2];
  if (!paramsFile) {
    console.error("Usage: npx ts-node register_from_receipt.ts <register_params.json>");
    process.exit(1);
  }

  // Load params
  const params = JSON.parse(fs.readFileSync(paramsFile, "utf-8"));
  console.log("Loaded params from:", paramsFile);

  // Connection
  const url = process.env.ANCHOR_PROVIDER_URL || "http://localhost:8899";
  const connection = new Connection(url, "confirmed");
  console.log("RPC:", url);

  // Wallet
  const walletPath = process.env.ANCHOR_WALLET ||
    path.join(process.env.HOME!, ".config/solana/id.json");
  const keypairData = JSON.parse(fs.readFileSync(walletPath, "utf-8"));
  const owner = Keypair.fromSecretKey(Uint8Array.from(keypairData));
  console.log("Owner:", owner.publicKey.toBase58());

  const balance = await connection.getBalance(owner.publicKey);
  console.log("Balance:", balance / 1e9, "SOL");

  if (balance < 10000000) {
    console.error("ERROR: Insufficient balance. Need at least 0.01 SOL.");
    process.exit(1);
  }

  // Convert params to buffers
  const contentHash = Buffer.from(params.content_hash);
  const originalHash = Buffer.from(params.original_hash);
  const metadataHash = Buffer.from(params.metadata_hash);
  const artifactCid = Buffer.from(params.artifact_cid);

  // Find PDA
  const [assetPDA, bump] = findAssetPDA(contentHash);
  console.log("Asset PDA:", assetPDA.toBase58());

  // Build instruction data
  const ix_disc = ixDiscriminator("register_asset");
  const guardian = params.guardian ? Buffer.from(params.guardian) : Buffer.alloc(32);
  const data = Buffer.concat([
    ix_disc,
    contentHash,                              // [u8; 32]
    originalHash,                             // [u8; 32]
    Buffer.from([params.artifact_type]),       // u8
    encodeF32(params.threshold),              // f32
    metadataHash,                             // [u8; 32]
    Buffer.from([params.codec_id]),           // u8
    encodeU16LE(params.group_size),           // u16
    Buffer.from([params.bits_per_weight]),    // u8
    Buffer.from([params.architecture]),       // u8
    encodeF32(params.cosine_claim),           // f32
    encodeI16LE(params.ppl_delta_bps),        // i16
    artifactCid,                              // [u8; 32]
    guardian,                                 // Pubkey (32)
  ]);

  console.log("Instruction data:", data.length, "bytes");

  // Build transaction
  const ix = new TransactionInstruction({
    keys: [
      { pubkey: assetPDA, isSigner: false, isWritable: true },
      { pubkey: owner.publicKey, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    programId: PROGRAM_ID,
    data: data,
  });

  const tx = new Transaction().add(ix);

  console.log("\nSending register_asset transaction...");
  try {
    const sig = await sendAndConfirmTransaction(connection, tx, [owner], {
      commitment: "confirmed",
    });
    console.log("SUCCESS!");
    console.log("Signature:", sig);
    console.log("Explorer:", `https://explorer.solana.com/tx/${sig}?cluster=${url.includes("devnet") ? "devnet" : "custom&customUrl=" + encodeURIComponent(url)}`);

    // Fetch and verify the account
    const accountInfo = await connection.getAccountInfo(assetPDA);
    if (accountInfo) {
      console.log("\nOn-chain account:");
      console.log("  Size:", accountInfo.data.length, "bytes");
      console.log("  Owner:", accountInfo.owner.toBase58());
      console.log("  Lamports:", accountInfo.lamports);

      // Read status byte (offset after 8-byte discriminator + 32 owner + 32 content_hash +
      // 32 original_hash + 1 artifact_type + 4 threshold + 32 metadata_hash +
      // 1 codec_id + 2 group_size + 1 bits_per_weight + 1 architecture + 4 cosine_claim +
      // 2 ppl_delta_bps + 32 artifact_cid = offset 184)
      const statusByte = accountInfo.data[184];
      const statusMap: any = { 0: "Candidate", 1: "Active", 2: "Quarantined" };
      console.log("  Status:", statusMap[statusByte] || `Unknown(${statusByte})`);
    }

    // Save on-chain receipt
    const receipt = {
      receipt_id: `hxq-onchain-register-${new Date().toISOString().replace(/[-:T]/g, "").slice(0, 15)}Z`,
      network: url.includes("devnet") ? "devnet" : "localnet",
      signature: sig,
      asset_pda: assetPDA.toBase58(),
      owner: owner.publicKey.toBase58(),
      content_hash: contentHash.toString("hex"),
      cosine_claim: params.cosine_claim,
      codec_id: params.codec_id,
      timestamp: new Date().toISOString(),
    };

    const receiptPath = paramsFile.replace("register_params.json", "onchain_receipt.json");
    fs.writeFileSync(receiptPath, JSON.stringify(receipt, null, 2));
    console.log("\nReceipt saved:", receiptPath);

  } catch (err) {
    console.error("Transaction failed:", (err as any).message);
    if ((err as any).logs) {
      console.error("Program logs:");
      (err as any).logs.forEach((log: any) => console.error("  ", log));
    }
    process.exit(1);
  }
}

main().catch(console.error);
