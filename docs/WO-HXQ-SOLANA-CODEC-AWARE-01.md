# WO-HXQ-SOLANA-CODEC-AWARE-01: Make the Chain Codec-Aware

**Status:** SCOPED
**Date:** 2026-05-11
**Depends on:** hxq-solana base program (74/74 tests), HXQ codec (proven)

## Problem

The on-chain program is a generic receipt notary. It stores hashes and a single
`threshold: f32`. The codec parameters (affine_6, g128, bpw=6, cosine 0.9993)
live entirely in off-chain fixture JSON, hashed into opaque `metadata_hash`
and `content_identity` strings the program never parses.

Anyone can submit `threshold: 0.999` without computing it. The chain trusts
whatever is submitted. There is no independent verifiability.

## Goal

Make the chain codec-aware so that:
1. On-chain account carries typed codec fields (not hashed blobs)
2. Threshold gate is per-codec (not one-size-fits-all 0.998)
3. An independent verifier can fetch artifacts, recompute fidelity, and compare
   to the on-chain claim — the chain provides commitment + auditability
4. The unique HXQ angle (hybrid architecture compression) is surfaced on-chain

## What the chain CAN and CANNOT do

**CAN:** Commitment + auditability. Once you claim cosine=0.9993 for affine_6
on a Zamba2 layer, that claim is immutable. If someone independently measures
0.95, the on-chain receipt is proof of fraud.

**CANNOT:** Trustless verification. The chain doesn't run the decompressor.
Fidelity is computed off-chain and submitted as a number. Trust comes from
the reproducibility of the off-chain computation + the immutability of the
on-chain commitment.

## Changes

### Phase 1: Typed codec fields on-chain (Rust, ~2h)

Add to `ReceiptGatedAsset` account (AI tensor type only):

```rust
// New fields (only populated when artifact_type == AiTensor)
pub codec_id: u8,          // 1  (0=affine_6, 1=affine_g128, 2=q5_h, 255=unknown)
pub group_size: u16,       // 2  (32, 64, 128, 256)
pub bits_per_weight: u8,   // 1  (4, 5, 6, 8)
pub architecture: u8,      // 1  (0=transformer, 1=ssm, 2=hybrid, 3=moe, 4=vision)
pub cosine_claim: f32,     // 4  (the actual claimed fidelity score)
pub ppl_delta_bps: i16,    // 2  (PPL delta in basis points: +53 = +0.53%)
pub artifact_cid: [u8; 32], // 32 (IPFS/Arweave CID or content-addressable locator)
```

Total new bytes: 43. Account grows from 259 to 302 bytes.

`register_asset` gets new params. `artifact_type == 0 (AiTensor)` requires
all codec fields populated. Other types set them to zero/default.

### Phase 2: Per-codec threshold gate (~1h)

Replace the single `THRESHOLD_GATE: f32 = 0.998` with codec-aware gates:

```rust
fn codec_threshold(codec_id: u8) -> f32 {
    match codec_id {
        0 => 0.998,   // affine_6: tight gate, proven quality
        1 => 0.998,   // affine_g128: same gate
        2 => 0.997,   // q5_hierarchical: slightly looser
        3 => 0.995,   // affine_4: much looser (known quality gap)
        _ => 0.998,   // unknown: strict default
    }
}
```

`promote_asset` checks `asset.cosine_claim >= codec_threshold(asset.codec_id)`
instead of the single constant.

### Phase 3: Independent verifier script (~4h)

`scripts/verify_claim.ts` — the load-bearing addition:

```
Input:  on-chain asset PDA (or content_hash)
Steps:
  1. Fetch on-chain account → read codec_id, cosine_claim, artifact_cid,
     original_hash, content_hash
  2. Fetch off-chain artifacts via artifact_cid (IPFS gateway or local path)
  3. Compute SHA-256 of fetched artifacts → compare to on-chain hashes
  4. If artifact_type == AiTensor:
     a. Dequantize compressed artifact using helix-codec (C99 lib or Python)
     b. Compute cosine similarity vs original
     c. Compare measured cosine to on-chain cosine_claim
  5. Output: VERIFIED (measured matches claim within tolerance)
           or DISPUTED (measured diverges from claim)
```

This is the piece that makes the commitment meaningful. Without it, the chain
is just a hash dump. With it, anyone can independently check the claim.

For v0, the verifier works with local file paths (no IPFS yet). The artifact_cid
field stores a content-addressable hash that could become an IPFS CID later.

### Phase 4: Architecture field as first-class citizen (~30min)

The `architecture: u8` field lets the chain know it's dealing with a hybrid.
On-chain queries can filter: "show me all hybrid-architecture assets with
cosine > 0.998" — this is the niche differentiator.

Event enrichment:

```rust
#[event]
pub struct AssetRegistered {
    pub asset: Pubkey,
    pub owner: Pubkey,
    pub content_hash: [u8; 32],
    pub artifact_type: u8,
    pub codec_id: u8,
    pub architecture: u8,
    pub cosine_claim: f32,
    pub threshold: f32,
}
```

## Falsification gates

| Gate | Metric | Pass | Fail |
|------|--------|------|------|
| G1 | Existing 74 tests still pass after account resize | 74/74 | any regression |
| G2 | New codec-aware registration + promotion for all 3 codecs (af6, g128, q5) | 3/3 promote | any reject |
| G3 | Per-codec threshold rejects af4 at 0.998 but accepts at 0.995 | correct reject + accept | wrong gate |
| G4 | Verifier correctly flags a tampered artifact (cosine mismatch) | DISPUTED on bad artifact | false VERIFIED |
| G5 | Verifier correctly passes a legitimate HXQ-compressed tensor | VERIFIED on real tensor | false DISPUTED |
| G6 | Architecture field correctly distinguishes transformer/hybrid/SSM | 3 types registered, queryable | any confusion |

## The unique pitch after this ships

> HXQ compresses hybrid architectures that nobody else handles — transformers,
> SSMs, Mamba-attention hybrids, MoEs, vision encoders — with no calibration
> data. Every compression produces an on-chain commitment: original hash,
> compressed hash, codec parameters, architecture type, fidelity score.
> Anyone can fetch both artifacts, run the open-source decompressor, and
> independently verify the claim. If the claim is wrong, the on-chain receipt
> is immutable proof of fraud and the asset gets quarantined.

Niche: only multi-architecture codec with on-chain provenance.
General: same receipt-gated state machine works for any domain.

## Cost estimate

- Phase 1: 2h (Rust account struct + register instruction change + test updates)
- Phase 2: 1h (per-codec threshold function + tests)
- Phase 3: 4h (verifier script + integration with helix-codec)
- Phase 4: 30min (event enrichment + architecture enum)

Total: ~1 focused session.

## What this does NOT include

- IPFS/Arweave integration (artifact_cid is a placeholder hash for now)
- Mainnet deployment
- Token/SPL integration
- ZK proofs of correct compression
- Any financial claims about the asset

## Migration

Account size changes from 259 to 302 bytes. Since this is localnet-only with
no deployed state to preserve, the migration is: rebuild + redeploy. If this
were mainnet, you'd need a migration instruction or a v2 account type.
