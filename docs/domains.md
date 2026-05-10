# Domain Architecture

## Two layers

HXQ-Solana separates two concerns that are often conflated:

```
Layer 1 — Artifact layer
  The actual thing: tensor, document, record, dataset, credential, passport.
  Stored off-chain. May or may not use HXQ codec.

Layer 2 — Receipt-gated state layer
  The on-chain proof: hashes, receipts, lifecycle state, transfer rules.
  Same state machine for every artifact type.
```

The codec makes artifacts efficient. The receipt-gated state machine makes artifacts trustworthy and governable. They are independent.

## What ReceiptGatedAsset does

For any off-chain artifact, the on-chain account answers:

- What is the content hash of this artifact?
- What is the metadata hash?
- What receipt hashes prove that checks happened?
- What is the current lifecycle state?
- Can this artifact be transferred, used, or relied upon right now?

The program does not know or care what the artifact is. It enforces the state machine:

```
Candidate → (receipts + threshold gate) → Active → (risk attestation) → transferable
Active → quarantine → blocked
```

## Artifact types

The `artifact_type` field is a `u8` for off-chain indexing. The program treats all types identically.

| ID | Type | Example artifact | Example receipts |
|----|------|-----------------|-----------------|
| 0 | AI tensor | Model weights, checkpoint | Fidelity score, behavioral eval, risk attestation |
| 1 | Legal document | Contract, evidence, filing | Attorney review, notarization, filing receipt |
| 2 | Medical record | Lab result, patient record | Provider attestation, patient consent, audit |
| 3 | Scientific compute | Dataset, model output | Benchmark validation, replication, peer review |
| 4 | Supply chain | Product passport, BOM | ISO certification, environmental audit, customs clearance |
| 5 | Credential | License, certification | Board verification, continuing education, disciplinary clearance |
| 255 | Generic | Any off-chain artifact | Any three-receipt attestation chain |

## The codec is optional

A legal contract does not need HXQ compression to be receipt-gated. A medical record does not need to be a tensor. The gate works on hashes:

```
raw artifact (any format, any storage)
  → SHA-256 content hash
  → SHA-256 metadata hash
  → receipt hashes from off-chain validation
  → on-chain ReceiptGatedAsset state
```

The codec becomes relevant when the artifact is a tensor, model weight, embedding, or structured numerical data that benefits from compression. For documents, records, and credentials, the artifact stays in its native format.

## Where the codec and the gate meet

For AI model artifacts, both layers apply:

```
model weights (FP16/BF16)
  → HXQ compression (4x from FP32, cosine >= 0.999)
  → content hash of compressed artifact
  → fidelity receipt (cosine score)
  → behavioral receipt (eval pass/fail)
  → risk attestation (deployment clearance)
  → ReceiptGatedAsset state = Active
  → runtime can load and use the artifact
```

For non-AI artifacts, only the gate layer applies:

```
lab result PDF
  → content hash
  → provider attestation receipt
  → patient consent receipt
  → audit receipt
  → ReceiptGatedAsset state = Active
  → system can reference the record
```

## State meanings by domain

The three states map naturally to every domain:

| State | AI | Legal | Medical | Supply chain | Credential |
|-------|-----|-------|---------|-------------|------------|
| Candidate | Compressed, awaiting validation | Drafted, awaiting review | Recorded, awaiting attestation | Manufactured, awaiting certification | Applied, awaiting verification |
| Active | Validated, deployable, transferable | Reviewed, notarized, citable | Attested, consented, usable | Certified, cleared, in commerce | Verified, licensed, transferable |
| Quarantined | Failed eval, unsafe, blocked | Disputed, under review | Consent revoked, access blocked | Recalled, safety hold | Suspended, under investigation |

## Why this matters for agents

Future AI systems that call tools and use private data need machine-readable answers to:

```
Is this data valid?
Who attested to it?
Is it current?
Was consent granted?
Was it revoked?
Can the agent use it?
```

The gate gives a simple answer:

```
Candidate: not ready, do not rely on it
Active: usable
Quarantined: blocked
```

An agent does not need to understand every legal or medical rule. It checks the registry, verifies the state, and acts or refuses accordingly.

## Full pipeline

When all layers connect:

```
raw artifact
  → canonical structured format
  → optional tensor/embedding/SSM representation
  → optional HXQ compression
  → receipt bundle (off-chain validation proofs)
  → ReceiptGatedAsset state (on-chain)
  → API/model access control
```

The artifact moves through representation, validation, and governance before any system can act on it.

## Current proof

The `ReceiptGatedAsset` state machine is proven across 6 artifact categories with 74/74 localnet tests:

- AI tensor lifecycle demo (9 steps including rejection proofs)
- Legal document fixture (8 tests)
- Medical record fixture (8 tests)
- Scientific compute fixture (8 tests)
- Supply chain passport fixture (8 tests)
- Credential attestation fixture (8 tests)

Each domain walks the full lifecycle: register, receipts, promotion, transfer, quarantine, and rejection enforcement.

Receipts and offline verification are available in `receipts/` and via `scripts/verify_receipt.ts`.

## Fixtures

Domain fixtures live in `examples/`:

```
examples/ai_tensor_asset/fixture.json
examples/legal_document_custody/fixture.json
examples/medical_record_consent/fixture.json
examples/scientific_compute_receipt/fixture.json
examples/supply_chain_passport/fixture.json
examples/credential_attestation/fixture.json
```

Each fixture defines `content_identity`, `original_identity`, three receipt strings, and domain-specific `state_mapping` and `threshold` descriptions. The test harness SHA-256 hashes these strings and submits the hashes on-chain. The program never sees the raw data.
