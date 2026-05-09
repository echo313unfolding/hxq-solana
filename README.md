# HXQ-Solana

HXQ-Solana is a localnet-verified Solana program for **receipt-gated provenance of off-chain artifacts**.

It stores hashes, receipts, and state transitions on-chain while keeping model/tensor artifacts off-chain.

## Current verification

- 16/16 base program tests passing
- 9/9 AI tensor lifecycle demo passing
- 40/40 domain fixture demos passing (legal, medical, scientific, supply chain, credential)
- 9/9 offline receipt verifier tests passing
- **74/74 total tests passing**

## Why this exists

Most blockchain examples prove that a transaction happened. HXQ-Solana proves that an off-chain artifact followed a receipt-gated lifecycle: registered, validated, promoted, transferred, quarantined, and blocked when invalid. The artifact itself never goes on-chain — only its hashes, receipts, and state transitions do.

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
            threshold >= 0.998? ──no──▶ REJECTED
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

### Run domain fixture demos (40 tests across 5 domains)

```bash
npx ts-mocha -p ./tsconfig.json -t 120000 tests/demo_domain_fixtures.ts
```

Expected result: 40/40 tests pass across legal, medical, scientific, supply chain, and credential fixtures. Receipt written to `receipts/domain_fixture_demos_20260508.json`.

### Verify receipts without running localnet

The offline receipt verifier checks structural integrity of receipt JSON files without contacting any Solana RPC:

```bash
npx ts-node --project scripts/tsconfig.json scripts/verify_receipt.ts receipts/hxq_solana_lifecycle_demo_20260508.json
npx ts-node --project scripts/tsconfig.json scripts/verify_receipt.ts receipts/domain_fixture_demos_20260508.json
```

Or via npm script:

```bash
npm run verify:receipt -- receipts/hxq_solana_lifecycle_demo_20260508.json
```

The verifier checks: required fields, program ID, tx signatures, 32-byte hex hashes, rejection error messages (`ThresholdBelowGate`, `AssetNotActive`), pass/fail status, and final state consistency. Exit code 0 on pass, nonzero on fail.

### Run verifier tests (9 tests)

```bash
npx ts-mocha -p ./tsconfig.json -t 10000 tests/test_verifier.ts
```

Tests include validation of both receipt types plus 7 corruption scenarios (wrong program ID, bad hashes, missing steps/domains, zeroed signatures, unknown type).

## On-chain account layout

```
ReceiptGatedAsset (259 bytes)
├── owner: Pubkey                      (32)
├── content_hash: [u8; 32]            (32)  ← SHA-256 of off-chain artifact
├── original_hash: [u8; 32]           (32)  ← SHA-256 of source artifact
├── artifact_type: u8                  (1)   ← 0=AI, 1=Legal, 2=Medical, 3=Scientific, 4=SupplyChain, 5=Credential, 255=Generic
├── threshold: f32                     (4)   ← fidelity gate (e.g. cosine for AI, 1.0 for "all receipts present")
├── metadata_hash: [u8; 32]           (32)  ← SHA-256 of domain-specific metadata
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
- A working Anchor program with 74 passing tests across 4 test suites
- A pattern proven to generalize across 5 domains: AI, legal, medical, scientific, supply chain, and credential

The domain examples are fixtures only. They demonstrate a provenance/state-machine pattern, not legal, medical, or regulatory compliance.

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
| Supply chain | Product passport, BOM | ISO certification, environmental audit | Certification + customs |
| Credentials | License, certification | Board verification, continuing education | Verification + clearance |

## License

ISC
