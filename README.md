# HXQ-Solana

HXQ-Solana is a localnet-verified Solana program for **receipt-gated provenance of off-chain artifacts**.

It stores hashes, receipts, and state transitions on-chain while keeping model/tensor artifacts off-chain.

## What it proves

- Register an off-chain artifact by content hash
- Submit fidelity and behavioral receipt hashes
- Reject promotion if fidelity score is below threshold (0.998)
- Promote valid assets from Candidate to Active
- Require risk attestation before transfer
- Transfer ownership of Active assets
- Quarantine assets (blocks further transfers)

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
              cosine >= 0.998? ──no──▶ REJECTED
                         │
                        yes
                         │
                         ▼
                  ┌─────────────┐
                  │   Active    │◀── risk attestation ── transfer
                  └──────┬──────┘
                         │
                    quarantine
                         │
                         ▼
                  ┌─────────────┐
                  │ Quarantined │──▶ transfer BLOCKED
                  └─────────────┘
```

## Quick start

Requirements: [Rust](https://rustup.rs/), [Solana CLI](https://docs.solanalabs.com/cli/install), [Anchor](https://www.anchor-lang.com/docs/installation), Node.js 18+.

```bash
git clone https://github.com/echo313unfolding/hxq-solana.git
cd hxq-solana
npm install
anchor build
```

### Run base tests (16 tests)

```bash
solana-test-validator --reset \
  --bpf-program EnDRZxswjvqKQhnPuMY6m6AFK3sxCKRX2dokXxAYPYrP \
  target/deploy/hxq_solana.so --quiet &

npx ts-mocha -p ./tsconfig.json -t 120000 tests/hxq-solana.ts
```

### Run lifecycle demo (9 steps)

```bash
npx ts-mocha -p ./tsconfig.json -t 120000 tests/demo_lifecycle.ts
```

Expected result: 9/9 lifecycle steps pass. Receipt written to `receipts/hxq_solana_lifecycle_demo_20260508.json`.

## On-chain account layout

```
HxqAssetAccount (226 bytes)
├── owner: Pubkey                      (32)
├── content_hash: [u8; 32]            (32)  ← SHA-256 of off-chain artifact
├── original_hash: [u8; 32]           (32)  ← SHA-256 of source artifact
├── codec: u8                          (1)
├── group_size: u16                    (2)
├── bits_per_weight: u8                (1)
├── cosine_min: f32                    (4)   ← fidelity threshold
├── ppl_delta_pct: f32                 (4)
├── status: u8                         (1)   ← 0=Candidate, 1=Active, 2=Quarantined
├── fidelity_receipt_hash: [u8; 32]   (32)
├── behavioral_receipt_hash: [u8; 32] (32)
├── risk_attestation_hash: [u8; 32]   (32)
├── transfer_count: u32               (4)
├── created_at: i64                    (8)
├── updated_at: i64                    (8)
└── bump: u8                           (1)
```

PDA seeds: `["hxq-asset", content_hash]` (content-addressed).

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
- Not production-ready

## What this IS

- A localnet proof of receipt-gated state transitions for off-chain artifacts
- A working Anchor program with 16 base tests and a 9-step lifecycle demo
- A pattern that generalizes beyond AI tensors to any high-value off-chain artifact

## The pattern

```
Private off-chain artifact
  → content hash registered on-chain
  → validation receipts submitted as hashes
  → promotion gated by receipt + threshold
  → transfer gated by risk attestation
  → quarantine blocks further transfers
```

This pattern applies to:

| Domain | Off-chain artifact | Receipts | Threshold |
|--------|-------------------|----------|-----------|
| AI models | Tensor/checkpoint file | Fidelity score, behavioral eval | cosine >= 0.998 |
| Legal | Contract, evidence, filing | Attorney review, notarization | Both parties signed |
| Medical | Patient record, lab result | Provider attestation, consent | HIPAA-compliant access |
| Scientific compute | Dataset, model output | Benchmark validation, replication | Quality threshold |

## License

ISC
