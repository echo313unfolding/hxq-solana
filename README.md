# HXQ-Solana

Quality-gated AI asset transfers on Solana. Token-2022 Transfer Hook enforces fidelity at protocol level.

HXQ-Solana is a Solana program for **receipt-gated provenance of off-chain artifacts**. It stores hashes, receipts, and state transitions on-chain while keeping model/tensor artifacts off-chain. A **Token-2022 Transfer Hook** automatically blocks token transfers if the underlying asset fails quality checks.

**Live on devnet.** Program ID: `EnDRZxswjvqKQhnPuMY6m6AFK3sxCKRX2dokXxAYPYrP`

## What this enables

- **Model trading**: Creators compress AI models with [helix-codec](https://github.com/echo313unfolding/helix-codec), register on Solana, mint gated tokens. Buyers receive tokens only if fidelity passes the codec threshold. Same codec on both sides.
- **Supply chain**: Sensor data, quality measurements, or inspection reports compressed as embeddings. Token transfers blocked if data integrity degrades.
- **Any domain**: Legal, medical, scientific, credential artifacts — all follow the same receipt-gated lifecycle with domain-specific thresholds.

## Transfer Hook

The Transfer Hook is the core primitive. It makes quality enforcement **self-enforcing at the protocol level** — not a wrapper you can skip.

```
Token-2022 transfer instruction
    → calls Transfer Hook (CPI)
        → reads ReceiptGatedAsset PDA
            → checks: status == Active?
            → checks: cosine_claim >= codec_threshold?
                → YES → transfer succeeds
                → NO  → transfer BLOCKED
```

Every token transfer automatically verifies the underlying asset. You cannot move a token whose compressed intelligence fails the quality gate.

### How it works

1. **Creator** compresses a model/tensor with helix-codec (affine-6, cos ≥ 0.998)
2. **Creator** registers the compressed artifact on Solana (`register_asset`)
3. **Creator** submits fidelity + behavioral receipts, promotes to Active
4. **Creator** mints Token-2022 with TransferHook pointing to this program
5. **Creator** calls `initialize_extra_account_meta_list` to link mint → asset PDA
6. On transfer, **Token-2022 automatically calls the hook** — no opt-out possible
7. **Buyer** receives the token, downloads the compressed file, decompresses with the same codec

## Current verification

- 75/75 base program tests (17 base + 9 lifecycle + 40 domain + 9 verifier)
- **8/8 Transfer Hook integration tests** (Active transfer allowed, Quarantined transfer blocked)
- **Real SBERT model trading demo** — all-MiniLM-L6-v2 embedding layer (11.7M params), creator→buyer transfer with hook enforcement
- **Buyer-side verification** — independent decompression + fidelity check + functional test (sentence embeddings 0.9998+)
- Deployed to Solana devnet

## Model trading demo

Full end-to-end on a real model layer (not test data):

```
Real SBERT weights (44.7 MB, 30522×384)
    → HXQ affine-6 compress (9.5 MB, cos=0.999720)
        → Register on Solana (302-byte PDA)
            → Submit receipts + promote to Active
                → Mint Token-2022 with Transfer Hook
                    → Creator sells 1 license token to Buyer
                        → Hook verifies quality → TRADE ALLOWED
                            → Buyer decompresses with same codec → VERIFIED
```

### Run the demo

```bash
# 1. Start localnet with HXQ program
solana-test-validator --reset \
  --bpf-program EnDRZxswjvqKQhnPuMY6m6AFK3sxCKRX2dokXxAYPYrP \
  target/deploy/hxq_solana.so --quiet &
sleep 4 && solana airdrop 10

# 2. Compress a real SBERT layer
python3 scripts/real_layer_demo.py

# 3. Run the full creator→buyer trade
ANCHOR_PROVIDER_URL=http://localhost:8899 \
ANCHOR_WALLET=~/.config/solana/id.json \
  npx ts-node scripts/model_trade_demo.ts

# 4. Buyer verifies and uses the model
python3 scripts/buyer_decompress.py \
  artifacts/sbert_real_layer/embedding.hxq \
  artifacts/sbert_real_layer/original_embedding.npy
```

### Run Transfer Hook tests

```bash
ANCHOR_PROVIDER_URL=http://localhost:8899 \
ANCHOR_WALLET=~/.config/solana/id.json \
  npx ts-mocha -p ./tsconfig.json -t 120000 tests/transfer_hook.ts
```

Expected: 8/8 pass. Tests cover register → promote → mint → transfer (ALLOWED) → quarantine → transfer (BLOCKED).

## Quick start

Requirements: [Rust](https://rustup.rs/), [Solana CLI](https://docs.solanalabs.com/cli/install), Node.js 18+, Python 3.10+ (for compression scripts).

```bash
git clone https://github.com/echo313unfolding/hxq-solana.git
cd hxq-solana
npm install
cargo build-sbf --no-default-features --features no-idl
```

### Run all tests

```bash
solana-test-validator --reset \
  --bpf-program EnDRZxswjvqKQhnPuMY6m6AFK3sxCKRX2dokXxAYPYrP \
  target/deploy/hxq_solana.so --quiet &
sleep 4 && solana airdrop 10

# Base tests (17)
npx ts-mocha -p ./tsconfig.json -t 120000 tests/hxq-solana.ts

# Lifecycle demo (9)
npx ts-mocha -p ./tsconfig.json -t 120000 tests/demo_lifecycle.ts

# Domain fixtures (40)
npx ts-mocha -p ./tsconfig.json -t 120000 tests/demo_domain_fixtures.ts

# Verifier tests (9)
npx ts-mocha -p ./tsconfig.json -t 10000 tests/test_verifier.ts

# Transfer Hook tests (8)
npx ts-mocha -p ./tsconfig.json -t 120000 tests/transfer_hook.ts
```

## State machine

```
                  ┌─────────────┐
                  │  Candidate  │
                  └──────┬──────┘
                         │
            submit fidelity receipt
            submit behavioral receipt
                         │
                         ▼
            threshold >= 0.998? ──no──▶ REJECTED
                         │
                        yes
                         │
                         ▼
                  ┌─────────────┐
                  │   Active    │◀── risk attestation ── transfer
                  └──────┬──────┘        ▲
                         │               │
                    quarantine     Token-2022 Transfer Hook
                         │         enforces quality on every
                         ▼         token transfer automatically
                  ┌─────────────┐
                  │ Quarantined │──▶ token transfer BLOCKED
                  └─────────────┘
```

## On-chain account layout

```
ReceiptGatedAsset (302 bytes)
├── owner: Pubkey                      (32)
├── content_hash: [u8; 32]            (32)  ← SHA-256 of compressed artifact
├── original_hash: [u8; 32]           (32)  ← SHA-256 of source artifact
├── artifact_type: u8                  (1)   ← 0=AI, 1=Legal, 2=Medical, 3=Scientific, 4=SupplyChain, 5=Credential
├── threshold: f32                     (4)   ← fidelity gate for non-AI types
├── metadata_hash: [u8; 32]           (32)  ← SHA-256 of domain-specific metadata
│   ── Codec-aware fields (AI tensor type) ──
├── codec_id: u8                       (1)   ← 0=Affine6, 1=AffineG128, 2=Q5Hierarchical, 3=Affine4
├── group_size: u16                    (2)
├── bits_per_weight: u8                (1)
├── architecture: u8                   (1)   ← 0=Transformer, 1=SSM, 2=Hybrid, 3=MoE, 4=Vision
├── cosine_claim: f32                  (4)   ← claimed fidelity (independently verifiable)
├── ppl_delta_bps: i16                 (2)   ← PPL delta in basis points
├── artifact_cid: [u8; 32]            (32)  ← content-addressable locator
│   ── State fields ──
├── status: u8                         (1)   ← 0=Candidate, 1=Active, 2=Quarantined
├── fidelity_receipt_hash: [u8; 32]   (32)
├── behavioral_receipt_hash: [u8; 32] (32)
├── risk_attestation_hash: [u8; 32]   (32)
├── transfer_count: u32               (4)
├── created_at: i64                    (8)
├── updated_at: i64                    (8)
└── bump: u8                           (1)
```

### Per-codec threshold gate

AI tensor assets use `cosine_claim` against codec-specific gates:

| Codec | ID | Gate | bpw |
|-------|-----|------|-----|
| Affine6 | 0 | 0.998 | 6.25 |
| AffineG128 | 1 | 0.998 | 8.25 |
| Q5 Hierarchical | 2 | 0.997 | 5.5 |
| Affine4 | 3 | 0.995 | ~4.5 |

## Scripts

| Script | Purpose |
|--------|---------|
| `scripts/real_layer_demo.py` | Extract + compress real SBERT embedding layer |
| `scripts/model_trade_demo.ts` | Full creator→buyer trade with Transfer Hook |
| `scripts/buyer_decompress.py` | Buyer-side decompression, verification, and usage |
| `scripts/register_from_receipt.ts` | Register an artifact from `register_params.json` |
| `scripts/e2e_register_artifact.py` | Generate test tensor + registration params |
| `scripts/verify_claim.py` | Independent off-chain fidelity verifier |

## Program ID

```
EnDRZxswjvqKQhnPuMY6m6AFK3sxCKRX2dokXxAYPYrP
```

## What this is NOT

- Not a token or coin
- Not a marketplace
- Not a mainnet deployment
- Not a medical or legal compliance product
- Not a system that stores private data on-chain

## What this IS

- A devnet-deployed proof of quality-gated AI asset transfers
- A Token-2022 Transfer Hook that enforces fidelity at the protocol level
- A working model trading demo on real SBERT weights (11.7M params)
- A receipt-gated state machine proven across 6 domains with 83+ tests
- A pattern where the same codec (helix-codec) standardizes both compression and verification

## License

ISC
