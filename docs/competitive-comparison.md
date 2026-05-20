# HXQ-Solana Competitive Comparison Table

**Category:** Protocol-enforced provenance for off-chain numerical artifacts
**Last updated:** 2026-05-19
**Status:** IN PROGRESS — collecting receipts

## Comparison Dimensions

1. **Quality Gate** — Does it enforce a numerical fidelity threshold?
2. **Transfer Gating** — Does it block transfers when quality fails?
3. **Domain Scope** — Single domain or multi-domain?
4. **On-Chain Model** — What lives on-chain?
5. **Lifecycle** — State machine for registered items?
6. **Cost** — Per-artifact registration cost

## Comparison Table

| System | Category | Quality Gate | Transfer Gating | Domain Scope | On-Chain Model | Lifecycle | Source |
|--------|----------|:------------:|:---------------:|--------------|----------------|-----------|--------|
| **HXQ-Solana** | Receipt-gated provenance | YES — codec-specific cosine threshold (0.995-0.998) | YES — Token-2022 Transfer Hook blocks transfer if status != Active OR cosine < gate | 6 domains (AI, Legal, Medical, Scientific, SupplyChain, Credential) | 302-byte PDA (hashes, codec fields, status, receipts) | Candidate → Active → Quarantined | [Source](https://github.com/echo313unfolding/hxq-solana) |
| **OpenTimestamps** | Hash-and-timestamp | NO — proves temporal existence, not quality | NO | Domain-agnostic (any hash) | Bitcoin OP_RETURN (~80 bytes, aggregated via calendar servers) | None — timestamp is final | [opentimestamps.org](https://opentimestamps.org/) |
| **IPFS** | Content-addressed storage | NO — CID verifies content identity via hash, not quality/fidelity | NO | Domain-agnostic (any file) | None — IPFS is off-chain; CIDs stored on-chain by other systems | None — immutable content, no state transitions | [docs.ipfs.tech](https://docs.ipfs.tech/concepts/content-addressing/) |
| **NFT Metadata (EIP-721 / Metaplex)** | Token-linked metadata | NO — tokenURI points to off-chain JSON, no quality verification | NO — transfer is unconditional | Domain-agnostic (any metadata JSON) | Token ownership + tokenURI pointer | None — "broken link problem" (off-chain metadata can disappear) | [RareSkills](https://rareskills.io/post/metaplex-token-metadata), [arXiv:2209.14517](https://arxiv.org/pdf/2209.14517) |
| **EZKL** | ZK proof of ML inference | DIFFERENT — proves computation correctness ("this model produced this output"), not artifact fidelity | NO | AI/ML only (ONNX models) | Stateless verifier contract on EVM; 65x faster than RISC Zero | None — one-shot proof/verify, no asset lifecycle | [ICME Guide](https://blog.icme.io/the-definitive-guide-to-zkml-2025/) |
| **Modulus Labs** | ZK proof of ML inference | DIFFERENT — proves specific model produced specific output | NO | AI/ML only | Verifier contract on Ethereum (~$20/verification historical, improving) | None — one-shot proof/verify | [Modulus intro](https://medium.com/@CountableMagic/introducing-modulus-bring-ai-on-chain-d75dcb82c5e3), [ICME Guide](https://blog.icme.io/the-definitive-guide-to-zkml-2025/) |
| **Giza** | ZK proof of ML inference (Cairo/STARK) | DIFFERENT — proves inference via zk-STARKs on Starknet | NO | AI/ML only | STARK verifier on Starknet, EigenLayer restaking for security | None — one-shot proof/verify | [Giza Medium](https://medium.com/@emmanueljuliet2019/how-giza-uses-cairo-for-verifiable-ml-c9e938d33b0d) |
| **VeChain** | Supply chain traceability | NO — tracks provenance events (location, time, raw material), "quality check" mentioned as manufacturing step but NOT enforced on-chain as numerical threshold | NO — VET/VTHO transfers not gated by artifact quality; blockchain records events but doesn't block transfers | Supply chain (luxury goods, food, automotive, logistics) + some cross-industry (carbon, agriculture) | VeChainThor blockchain (PoA, 101 Authority Masternodes, dual-token VET/VTHO), VeChain ID (VID) links physical items to digital avatars | Tracks product lifecycle events (manufacturing → logistics → retail → after-service) but no Candidate/Active/Quarantined quality-gated state machine | [VeChain Whitepaper v1.0 (2018)](https://cdn.vechain.com/vechainthor_development_plan_and_whitepaper_en_v1.0.pdf) |
| **IBM Food Trust** | Supply chain traceability | NO — data quality monitoring (flag issues), not threshold enforcement | NO — permissioned visibility, doesn't block transactions on quality | Food supply chain only | Hyperledger Fabric (permissioned, private) | Tracks supply chain events, no quality-gated lifecycle | [IBM](https://www.ibm.com/blockchain/solutions/food-trust) |
| **W3C Verifiable Credentials** | Credential issuance/verification | NO — proves credential authenticity via cryptographic signatures, not numerical fidelity | NO — credentials are presented, not transferred as tokens | Extensible but credential-focused | Off-chain with cryptographic proofs; "verifiable data registries" are implementation-agnostic | Issuance → Verification → Revocation (no quality gate) | [W3C Rec v2.0 (2025-05-15)](https://www.w3.org/TR/vc-data-model-2.0/) |
| **MedRec** | Medical record access management | NO — manages "authentication, confidentiality, accountability and data sharing" (abstract), stores cryptographic hash for data integrity but NO numerical quality threshold | NO — controls who can read records via smart contract permissions; "accepting or rejecting" is about access consent, not quality gating | Medical records only (EMR interoperability) | Ethereum smart contracts: Registrar Contract (identity→address), Patient-Provider Relationship (PPR, data pointers + permissions), Summary Contract (breadcrumb trail of PPRs). Medical data stays off-chain in provider databases. | PPR status variable tracks relationship state (newly established / pending / acknowledged), NOT artifact quality state | [Azaria et al. 2016, IEEE OBD pp.25-30, DOI:10.1109/OBD.2016.11](https://ieeexplore.ieee.org/document/7573685/) |
| **Synapse.org** | Scientific data collaboration | NO — provenance graphs track analysis workflow, not numerical fidelity | NO — data sharing is permission-based, not quality-gated | Scientific/biomedical research | Off-chain (cloud platform, not blockchain) | Analysis provenance DAG, not quality lifecycle | [Synapse](https://www.synapse.org/), [Wikipedia](https://en.wikipedia.org/wiki/Synapse.org) |

## Key Differentiators

### What HXQ-Solana does that NO competitor does:

1. **Codec-aware quality gate** — numerical fidelity threshold (cosine similarity) checked per-codec, per-artifact-type
2. **Protocol-level transfer enforcement** — Token-2022 Transfer Hook makes quality check mandatory, not optional
3. **Multi-domain single primitive** — same 302-byte PDA and Candidate→Active→Quarantined lifecycle for AI tensors, legal documents, medical records, scientific data, supply chain items, and credentials
4. **Quality + transfer in one system** — competitors either track provenance without quality (VeChain, IPFS, OpenTimestamps) or verify computation without gating transfer (EZKL, Modulus, Giza)

### The gap in the landscape:

```
                    Quality Verification
                    │
                    │  EZKL/Modulus/Giza
                    │  (prove computation,
                    │   don't gate transfer)
                    │
                    │              ┌──────────────┐
                    │              │  HXQ-Solana   │
                    │              │  (verify AND  │
                    │              │   gate)       │
                    │              └──────────────┘
                    │
────────────────────┼────────────────────────── Transfer Enforcement
                    │
   OpenTimestamps   │  NFT/Metaplex
   IPFS             │  (transfer tokens,
   (hash only,      │   no quality check)
    no transfer)    │
                    │
```

## Receipt Status

| Competitor | Primary Source Found | Tier | Verified |
|------------|---------------------|------|----------|
| W3C VC | W3C Recommendation v2.0 (2025-05-15) | **tier-0** | YES — no quality gate, no transfer gating, off-chain |
| OpenTimestamps | opentimestamps.org (official site) | tier-1 | YES — temporal proof only, no quality, no transfer |
| IPFS | docs.ipfs.tech (official docs) | tier-1 | YES — CID = identity hash, no quality gate |
| IBM Food Trust | ibm.com (product pages) | tier-1 | YES — Hyperledger Fabric, food-only, no quality gate |
| EZKL | ICME Definitive Guide to ZKML 2025 | tier-1 | YES — proves inference correctness, AI-only, no transfer gating |
| Modulus Labs | ICME guide + Medium + BusinessWire | tier-1/3 | YES — proves inference, ~$20/verify historical, AI-only |
| Giza | Medium + ICME guide | tier-3 | PARTIAL — Cairo/STARK on Starknet, AI-only, no transfer gating |
| NFT/Metaplex | arXiv:2209.14517 + RareSkills | tier-3 | PARTIAL — broken link problem documented, no quality check |
| Synapse.org | synapse.org + Wikipedia | tier-3 | PARTIAL — provenance DAG, off-chain, no quality gate |
| VeChain | VeChain Whitepaper v1.0 (2018), cdn.vechain.com PDF | **tier-0** | YES — tracks provenance events, zero mentions of quality gate/fidelity/cosine/quarantine in 114-page whitepaper |
| MedRec | IEEE Xplore + full paper PDF (6 pages read) | **tier-0** | YES — access management only, DOI:10.1109/OBD.2016.11, no quality threshold, no transfer gating |

### Source URLs (fetched this session)
- W3C VC: https://www.w3.org/TR/vc-data-model-2.0/ (fetched 2026-05-19)
- OpenTimestamps: https://opentimestamps.org/ (fetched 2026-05-19)
- IPFS: https://docs.ipfs.tech/concepts/content-addressing/ (fetched 2026-05-19)
- IBM Food Trust: https://www.ibm.com/blockchain/solutions/food-trust (fetched 2026-05-19)
- ICME ZKML Guide: https://blog.icme.io/the-definitive-guide-to-zkml-2025/ (fetched 2026-05-19, covers EZKL + Modulus + Giza)
- Modulus Labs: https://medium.com/@CountableMagic/introducing-modulus-bring-ai-on-chain-d75dcb82c5e3
- Synapse.org: https://en.wikipedia.org/wiki/Synapse.org
- VeChain: https://cdn.vechain.com/vechainthor_development_plan_and_whitepaper_en_v1.0.pdf (fetched 2026-05-19, 114 pages, pdftotext verified)
- MedRec: https://ieeexplore.ieee.org/document/7573685/ (DOI:10.1109/OBD.2016.11) + full PDF from https://people.cs.pitt.edu/~babay/courses/cs3551/papers/MedRec.pdf (fetched 2026-05-19, 6 pages read)
