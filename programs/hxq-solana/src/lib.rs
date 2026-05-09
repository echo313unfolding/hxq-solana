use anchor_lang::prelude::*;

declare_id!("EnDRZxswjvqKQhnPuMY6m6AFK3sxCKRX2dokXxAYPYrP");

/// Receipt-Gated Asset Program
///
/// Off-chain artifacts, on-chain state. The heavy payloads (tensors, documents,
/// records, datasets) stay off-chain; the chain holds identity, hashes,
/// ownership, transfer rules, and receipts.
///
/// This program does NOT:
/// - Store artifact data on-chain
/// - Perform KYC verification
/// - Provide custody
/// - Execute settlement
/// - Generate ZK proofs
///
/// It DOES:
/// - Register content-addressed off-chain artifacts
/// - Gate promotion via fidelity + behavioral receipts
/// - Enforce transfer policy via receipt validation
/// - Log immutable decision receipts on-chain

#[program]
pub mod hxq_solana {
    use super::*;

    /// Register a new off-chain artifact.
    /// Status starts as Candidate — must be promoted before transfer.
    pub fn register_asset(
        ctx: Context<RegisterAsset>,
        content_hash: [u8; 32],
        original_hash: [u8; 32],
        artifact_type: u8,
        threshold: f32,
        metadata_hash: [u8; 32],
    ) -> Result<()> {
        let asset = &mut ctx.accounts.asset;
        asset.owner = ctx.accounts.owner.key();
        asset.content_hash = content_hash;
        asset.original_hash = original_hash;
        asset.artifact_type = artifact_type;
        asset.threshold = threshold;
        asset.metadata_hash = metadata_hash;
        asset.status = AssetStatus::Candidate as u8;
        asset.fidelity_receipt_hash = [0u8; 32];
        asset.behavioral_receipt_hash = [0u8; 32];
        asset.risk_attestation_hash = [0u8; 32];
        asset.transfer_count = 0;
        asset.created_at = Clock::get()?.unix_timestamp;
        asset.updated_at = Clock::get()?.unix_timestamp;
        asset.bump = ctx.bumps.asset;

        emit!(AssetRegistered {
            asset: asset.key(),
            owner: asset.owner,
            content_hash,
            artifact_type,
            threshold,
        });

        Ok(())
    }

    /// Submit fidelity receipt hash. Only the owner can submit.
    pub fn submit_fidelity_receipt(
        ctx: Context<UpdateAsset>,
        receipt_hash: [u8; 32],
    ) -> Result<()> {
        let asset = &mut ctx.accounts.asset;
        require!(
            asset.status == AssetStatus::Candidate as u8,
            ReceiptGateError::AssetNotCandidate
        );
        asset.fidelity_receipt_hash = receipt_hash;
        asset.updated_at = Clock::get()?.unix_timestamp;

        emit!(ReceiptSubmitted {
            asset: asset.key(),
            receipt_type: ReceiptType::Fidelity,
            receipt_hash,
        });

        Ok(())
    }

    /// Submit behavioral evaluation receipt hash. Only the owner can submit.
    pub fn submit_behavioral_receipt(
        ctx: Context<UpdateAsset>,
        receipt_hash: [u8; 32],
    ) -> Result<()> {
        let asset = &mut ctx.accounts.asset;
        require!(
            asset.status == AssetStatus::Candidate as u8,
            ReceiptGateError::AssetNotCandidate
        );
        asset.behavioral_receipt_hash = receipt_hash;
        asset.updated_at = Clock::get()?.unix_timestamp;

        emit!(ReceiptSubmitted {
            asset: asset.key(),
            receipt_type: ReceiptType::Behavioral,
            receipt_hash,
        });

        Ok(())
    }

    /// Submit risk attestation hash (from off-chain risk policy).
    pub fn submit_risk_attestation(
        ctx: Context<UpdateAsset>,
        attestation_hash: [u8; 32],
    ) -> Result<()> {
        let asset = &mut ctx.accounts.asset;
        asset.risk_attestation_hash = attestation_hash;
        asset.updated_at = Clock::get()?.unix_timestamp;

        emit!(ReceiptSubmitted {
            asset: asset.key(),
            receipt_type: ReceiptType::RiskAttestation,
            receipt_hash: attestation_hash,
        });

        Ok(())
    }

    /// Promote asset from Candidate to Active.
    /// Requires both fidelity and behavioral receipt hashes to be non-zero
    /// and threshold to meet the minimum gate (0.998).
    pub fn promote_asset(ctx: Context<UpdateAsset>) -> Result<()> {
        let asset = &mut ctx.accounts.asset;

        require!(
            asset.status == AssetStatus::Candidate as u8,
            ReceiptGateError::AssetNotCandidate
        );
        require!(
            asset.fidelity_receipt_hash != [0u8; 32],
            ReceiptGateError::MissingFidelityReceipt
        );
        require!(
            asset.behavioral_receipt_hash != [0u8; 32],
            ReceiptGateError::MissingBehavioralReceipt
        );
        require!(
            asset.threshold >= THRESHOLD_GATE,
            ReceiptGateError::ThresholdBelowGate
        );

        asset.status = AssetStatus::Active as u8;
        asset.updated_at = Clock::get()?.unix_timestamp;

        emit!(AssetPromoted {
            asset: asset.key(),
            threshold: asset.threshold,
        });

        Ok(())
    }

    /// Quarantine an asset (owner-only emergency action).
    pub fn quarantine_asset(ctx: Context<UpdateAsset>) -> Result<()> {
        let asset = &mut ctx.accounts.asset;
        require!(
            asset.status == AssetStatus::Active as u8,
            ReceiptGateError::AssetNotActive
        );

        asset.status = AssetStatus::Quarantined as u8;
        asset.updated_at = Clock::get()?.unix_timestamp;

        emit!(AssetQuarantined {
            asset: asset.key(),
        });

        Ok(())
    }

    /// Transfer asset ownership.
    /// Only works on Active (not Candidate or Quarantined) assets.
    /// Risk attestation must exist.
    pub fn transfer_asset(ctx: Context<TransferAsset>) -> Result<()> {
        let asset = &mut ctx.accounts.asset;

        require!(
            asset.status == AssetStatus::Active as u8,
            ReceiptGateError::AssetNotActive
        );
        require!(
            asset.risk_attestation_hash != [0u8; 32],
            ReceiptGateError::MissingRiskAttestation
        );

        let old_owner = asset.owner;
        asset.owner = ctx.accounts.new_owner.key();
        asset.transfer_count += 1;
        asset.updated_at = Clock::get()?.unix_timestamp;

        emit!(AssetTransferred {
            asset: asset.key(),
            from: old_owner,
            to: asset.owner,
            transfer_count: asset.transfer_count,
        });

        Ok(())
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════════════════

const THRESHOLD_GATE: f32 = 0.998;

// ═══════════════════════════════════════════════════════════════════════════════
// Account
// ═══════════════════════════════════════════════════════════════════════════════

#[account]
pub struct ReceiptGatedAsset {
    pub owner: Pubkey,                      // 32
    pub content_hash: [u8; 32],             // 32
    pub original_hash: [u8; 32],            // 32
    pub artifact_type: u8,                  // 1  (0=AiTensor, 1=LegalDocument, 2=MedicalRecord, 3=ScientificCompute, 255=Generic)
    pub threshold: f32,                     // 4  (generic fidelity gate, e.g. cosine for AI, 1.0 for "all receipts present")
    pub metadata_hash: [u8; 32],            // 32 (SHA-256 of domain-specific metadata — codec info, document metadata, etc.)
    pub status: u8,                         // 1  (Candidate/Active/Quarantined)
    pub fidelity_receipt_hash: [u8; 32],    // 32 (validation/fidelity/review receipt)
    pub behavioral_receipt_hash: [u8; 32],  // 32 (execution/behavioral/notarization receipt)
    pub risk_attestation_hash: [u8; 32],    // 32 (risk/compliance/audit attestation)
    pub transfer_count: u32,                // 4
    pub created_at: i64,                    // 8
    pub updated_at: i64,                    // 8
    pub bump: u8,                           // 1
}

impl ReceiptGatedAsset {
    // 8 (discriminator) + 32 + 32 + 32 + 1 + 4 + 32 + 1 + 32 + 32 + 32 + 4 + 8 + 8 + 1 = 259
    pub const LEN: usize = 8 + 32 + 32 + 32 + 1 + 4 + 32 + 1 + 32 + 32 + 32 + 4 + 8 + 8 + 1;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Artifact types
// ═══════════════════════════════════════════════════════════════════════════════

/// Domain-specific artifact types. The program treats all types identically;
/// this enum exists for off-chain indexing and display.
#[repr(u8)]
pub enum ArtifactType {
    AiTensor = 0,
    LegalDocument = 1,
    MedicalRecord = 2,
    ScientificCompute = 3,
    Generic = 255,
}

// ═══════════════════════════════════════════════════════════════════════════════
// Instruction contexts
// ═══════════════════════════════════════════════════════════════════════════════

#[derive(Accounts)]
#[instruction(content_hash: [u8; 32])]
pub struct RegisterAsset<'info> {
    #[account(
        init,
        payer = owner,
        space = ReceiptGatedAsset::LEN,
        seeds = [b"hxq-asset", content_hash.as_ref()],
        bump,
    )]
    pub asset: Account<'info, ReceiptGatedAsset>,
    #[account(mut)]
    pub owner: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateAsset<'info> {
    #[account(mut, has_one = owner @ ReceiptGateError::Unauthorized)]
    pub asset: Account<'info, ReceiptGatedAsset>,
    pub owner: Signer<'info>,
}

#[derive(Accounts)]
pub struct TransferAsset<'info> {
    #[account(mut, has_one = owner @ ReceiptGateError::Unauthorized)]
    pub asset: Account<'info, ReceiptGatedAsset>,
    pub owner: Signer<'info>,
    /// CHECK: New owner — any valid pubkey.
    pub new_owner: UncheckedAccount<'info>,
}

// ═══════════════════════════════════════════════════════════════════════════════
// Enums
// ═══════════════════════════════════════════════════════════════════════════════

#[repr(u8)]
pub enum AssetStatus {
    Candidate = 0,
    Active = 1,
    Quarantined = 2,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy)]
pub enum ReceiptType {
    Fidelity,
    Behavioral,
    RiskAttestation,
}

// ═══════════════════════════════════════════════════════════════════════════════
// Events
// ═══════════════════════════════════════════════════════════════════════════════

#[event]
pub struct AssetRegistered {
    pub asset: Pubkey,
    pub owner: Pubkey,
    pub content_hash: [u8; 32],
    pub artifact_type: u8,
    pub threshold: f32,
}

#[event]
pub struct ReceiptSubmitted {
    pub asset: Pubkey,
    pub receipt_type: ReceiptType,
    pub receipt_hash: [u8; 32],
}

#[event]
pub struct AssetPromoted {
    pub asset: Pubkey,
    pub threshold: f32,
}

#[event]
pub struct AssetQuarantined {
    pub asset: Pubkey,
}

#[event]
pub struct AssetTransferred {
    pub asset: Pubkey,
    pub from: Pubkey,
    pub to: Pubkey,
    pub transfer_count: u32,
}

// ═══════════════════════════════════════════════════════════════════════════════
// Errors
// ═══════════════════════════════════════════════════════════════════════════════

#[error_code]
pub enum ReceiptGateError {
    #[msg("Only the asset owner can perform this action")]
    Unauthorized,
    #[msg("Asset is not in Candidate status")]
    AssetNotCandidate,
    #[msg("Asset is not in Active status")]
    AssetNotActive,
    #[msg("Fidelity receipt hash has not been submitted")]
    MissingFidelityReceipt,
    #[msg("Behavioral receipt hash has not been submitted")]
    MissingBehavioralReceipt,
    #[msg("Risk attestation hash has not been submitted")]
    MissingRiskAttestation,
    #[msg("Threshold is below the 0.998 gate")]
    ThresholdBelowGate,
}
