use anchor_lang::prelude::*;

declare_id!("EnDRZxswjvqKQhnPuMY6m6AFK3sxCKRX2dokXxAYPYrP");

/// HXQ On-Chain Asset Program
///
/// Off-chain tensors, on-chain state. The heavy tensor payloads stay local;
/// the chain holds identity, hashes, ownership, transfer rules, and receipts.
///
/// This program does NOT:
/// - Store tensor data on-chain
/// - Perform KYC verification
/// - Provide custody
/// - Execute settlement
/// - Generate ZK proofs
///
/// It DOES:
/// - Register content-addressed tensor assets
/// - Gate promotion via fidelity + behavioral receipts
/// - Enforce transfer policy via receipt validation
/// - Log immutable decision receipts on-chain

#[program]
pub mod hxq_solana {
    use super::*;

    /// Register a new HXQ tensor asset.
    /// Status starts as Candidate — must be promoted before transfer.
    pub fn register_asset(
        ctx: Context<RegisterAsset>,
        content_hash: [u8; 32],
        original_hash: [u8; 32],
        codec: u8,
        group_size: u16,
        bits_per_weight: u8,
        cosine_min: f32,
        ppl_delta_pct: f32,
    ) -> Result<()> {
        let asset = &mut ctx.accounts.asset;
        asset.owner = ctx.accounts.owner.key();
        asset.content_hash = content_hash;
        asset.original_hash = original_hash;
        asset.codec = codec;
        asset.group_size = group_size;
        asset.bits_per_weight = bits_per_weight;
        asset.cosine_min = cosine_min;
        asset.ppl_delta_pct = ppl_delta_pct;
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
            codec,
            cosine_min,
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
            HxqError::AssetNotCandidate
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
            HxqError::AssetNotCandidate
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

    /// Submit risk attestation hash (from off-chain Sentinel risk policy).
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
    /// Requires both fidelity and behavioral receipt hashes to be non-zero.
    /// On-chain equivalent of can_promote() in hxq_asset.py.
    pub fn promote_asset(ctx: Context<UpdateAsset>) -> Result<()> {
        let asset = &mut ctx.accounts.asset;

        require!(
            asset.status == AssetStatus::Candidate as u8,
            HxqError::AssetNotCandidate
        );
        require!(
            asset.fidelity_receipt_hash != [0u8; 32],
            HxqError::MissingFidelityReceipt
        );
        require!(
            asset.behavioral_receipt_hash != [0u8; 32],
            HxqError::MissingBehavioralReceipt
        );
        require!(
            asset.cosine_min >= COSINE_THRESHOLD,
            HxqError::FidelityBelowThreshold
        );

        asset.status = AssetStatus::Active as u8;
        asset.updated_at = Clock::get()?.unix_timestamp;

        emit!(AssetPromoted {
            asset: asset.key(),
            cosine_min: asset.cosine_min,
        });

        Ok(())
    }

    /// Quarantine an asset (owner-only emergency action).
    pub fn quarantine_asset(ctx: Context<UpdateAsset>) -> Result<()> {
        let asset = &mut ctx.accounts.asset;
        require!(
            asset.status == AssetStatus::Active as u8,
            HxqError::AssetNotActive
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
            HxqError::AssetNotActive
        );
        require!(
            asset.risk_attestation_hash != [0u8; 32],
            HxqError::MissingRiskAttestation
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

const COSINE_THRESHOLD: f32 = 0.998;

// ═══════════════════════════════════════════════════════════════════════════════
// Account
// ═══════════════════════════════════════════════════════════════════════════════

#[account]
pub struct HxqAssetAccount {
    pub owner: Pubkey,                      // 32
    pub content_hash: [u8; 32],             // 32
    pub original_hash: [u8; 32],            // 32
    pub codec: u8,                          // 1  (0=affine_6, 1=affine_g128)
    pub group_size: u16,                    // 2  (128)
    pub bits_per_weight: u8,                // 1  (6 or 8)
    pub cosine_min: f32,                    // 4
    pub ppl_delta_pct: f32,                 // 4
    pub status: u8,                         // 1  (Candidate/Active/Quarantined)
    pub fidelity_receipt_hash: [u8; 32],    // 32
    pub behavioral_receipt_hash: [u8; 32],  // 32
    pub risk_attestation_hash: [u8; 32],    // 32
    pub transfer_count: u32,                // 4
    pub created_at: i64,                    // 8
    pub updated_at: i64,                    // 8
    pub bump: u8,                           // 1
}

impl HxqAssetAccount {
    pub const LEN: usize = 8 + 32 + 32 + 32 + 1 + 2 + 1 + 4 + 4 + 1 + 32 + 32 + 32 + 4 + 8 + 8 + 1;
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
        space = HxqAssetAccount::LEN,
        seeds = [b"hxq-asset", content_hash.as_ref()],
        bump,
    )]
    pub asset: Account<'info, HxqAssetAccount>,
    #[account(mut)]
    pub owner: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateAsset<'info> {
    #[account(mut, has_one = owner @ HxqError::Unauthorized)]
    pub asset: Account<'info, HxqAssetAccount>,
    pub owner: Signer<'info>,
}

#[derive(Accounts)]
pub struct TransferAsset<'info> {
    #[account(mut, has_one = owner @ HxqError::Unauthorized)]
    pub asset: Account<'info, HxqAssetAccount>,
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
    pub codec: u8,
    pub cosine_min: f32,
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
    pub cosine_min: f32,
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
pub enum HxqError {
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
    #[msg("Cosine fidelity is below the 0.998 threshold")]
    FidelityBelowThreshold,
}
