use anchor_lang::prelude::*;
use anchor_lang::system_program;
use anchor_spl::token_interface::{Mint, TokenAccount};
use spl_tlv_account_resolution::{
    account::ExtraAccountMeta,
    state::ExtraAccountMetaList,
};
use spl_transfer_hook_interface::instruction::TransferHookInstruction;

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
    /// For AI tensor assets (artifact_type=0), codec fields are required.
    pub fn register_asset(
        ctx: Context<RegisterAsset>,
        content_hash: [u8; 32],
        original_hash: [u8; 32],
        artifact_type: u8,
        threshold: f32,
        metadata_hash: [u8; 32],
        codec_id: u8,
        group_size: u16,
        bits_per_weight: u8,
        architecture: u8,
        cosine_claim: f32,
        ppl_delta_bps: i16,
        artifact_cid: [u8; 32],
        guardian: Pubkey,
    ) -> Result<()> {
        let asset = &mut ctx.accounts.asset;
        asset.owner = ctx.accounts.owner.key();
        asset.content_hash = content_hash;
        asset.original_hash = original_hash;
        asset.artifact_type = artifact_type;
        asset.threshold = threshold;
        asset.metadata_hash = metadata_hash;
        asset.codec_id = codec_id;
        asset.group_size = group_size;
        asset.bits_per_weight = bits_per_weight;
        asset.architecture = architecture;
        asset.cosine_claim = cosine_claim;
        asset.ppl_delta_bps = ppl_delta_bps;
        asset.artifact_cid = artifact_cid;
        asset.status = AssetStatus::Candidate as u8;
        asset.fidelity_receipt_hash = [0u8; 32];
        asset.behavioral_receipt_hash = [0u8; 32];
        asset.risk_attestation_hash = [0u8; 32];
        asset.transfer_count = 0;
        asset.created_at = Clock::get()?.unix_timestamp;
        asset.updated_at = Clock::get()?.unix_timestamp;
        asset.bump = ctx.bumps.asset;
        asset.guardian = guardian;
        asset.pending_guardian = Pubkey::default();
        asset.rotation_eligible_at = 0;

        emit!(AssetRegistered {
            asset: asset.key(),
            owner: asset.owner,
            content_hash,
            artifact_type,
            codec_id,
            architecture,
            cosine_claim,
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
    /// and cosine_claim to meet the per-codec threshold gate.
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

        // Per-codec threshold gate: AI tensor assets use cosine_claim against
        // codec-specific gate; other domains use the legacy threshold field.
        let gate = if asset.artifact_type == ArtifactType::AiTensor as u8 {
            let claim = asset.cosine_claim;
            let required = codec_threshold(asset.codec_id);
            require!(
                claim >= required,
                ReceiptGateError::ThresholdBelowGate
            );
            claim
        } else {
            require!(
                asset.threshold >= THRESHOLD_GATE,
                ReceiptGateError::ThresholdBelowGate
            );
            asset.threshold
        };

        asset.status = AssetStatus::Active as u8;
        asset.updated_at = Clock::get()?.unix_timestamp;

        emit!(AssetPromoted {
            asset: asset.key(),
            threshold: gate,
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

    /// GuardianCell dispute — independent verifier quarantines an asset.
    ///
    /// The guardian is a designated third party (set at registration) who can
    /// independently verify the artifact and trigger quarantine without the
    /// owner's permission. This makes the quality enforcement adversarial:
    /// anyone with the original weights can challenge the claim through
    /// the designated guardian.
    ///
    /// The guardian submits a dispute_receipt_hash proving their independent
    /// verification found fidelity below the codec gate.
    pub fn dispute_asset(
        ctx: Context<DisputeAsset>,
        dispute_receipt_hash: [u8; 32],
    ) -> Result<()> {
        let asset = &mut ctx.accounts.asset;

        require!(
            asset.guardian != Pubkey::default(),
            ReceiptGateError::NoGuardianSet
        );
        require!(
            asset.status == AssetStatus::Active as u8,
            ReceiptGateError::AssetNotActive
        );
        require!(
            dispute_receipt_hash != [0u8; 32],
            ReceiptGateError::MissingDisputeReceipt
        );

        asset.status = AssetStatus::Quarantined as u8;
        asset.risk_attestation_hash = dispute_receipt_hash;
        asset.updated_at = Clock::get()?.unix_timestamp;

        emit!(AssetDisputed {
            asset: asset.key(),
            guardian: ctx.accounts.guardian.key(),
            dispute_receipt_hash,
        });

        Ok(())
    }

    /// Initiate guardian rotation (owner-only, timelock-gated).
    ///
    /// Sets a pending guardian and a future timestamp. The current guardian
    /// retains full dispute authority until finalization. This gives the
    /// current guardian a 7-day window to fire any pending dispute or
    /// cancel the rotation before being replaced.
    pub fn initiate_guardian_rotation(
        ctx: Context<UpdateAsset>,
        new_guardian: Pubkey,
    ) -> Result<()> {
        let asset = &mut ctx.accounts.asset;

        require!(
            asset.guardian != Pubkey::default(),
            ReceiptGateError::NoGuardianSet
        );
        require!(
            new_guardian != Pubkey::default(),
            ReceiptGateError::InvalidNewGuardian
        );
        require!(
            asset.pending_guardian == Pubkey::default(),
            ReceiptGateError::RotationAlreadyPending
        );

        let now = Clock::get()?.unix_timestamp;
        asset.pending_guardian = new_guardian;
        asset.rotation_eligible_at = now + ROTATION_DELAY_SECONDS;
        asset.updated_at = now;

        emit!(GuardianRotationInitiated {
            asset: asset.key(),
            current_guardian: asset.guardian,
            new_guardian,
            eligible_at: asset.rotation_eligible_at,
        });

        Ok(())
    }

    /// Finalize guardian rotation (owner-only, after timelock expires).
    ///
    /// Replaces the current guardian with the pending guardian. Only callable
    /// after rotation_eligible_at has passed.
    pub fn finalize_guardian_rotation(ctx: Context<UpdateAsset>) -> Result<()> {
        let asset = &mut ctx.accounts.asset;

        require!(
            asset.pending_guardian != Pubkey::default(),
            ReceiptGateError::NoRotationPending
        );

        let now = Clock::get()?.unix_timestamp;
        require!(
            now >= asset.rotation_eligible_at,
            ReceiptGateError::RotationNotEligible
        );

        let old_guardian = asset.guardian;
        asset.guardian = asset.pending_guardian;
        asset.pending_guardian = Pubkey::default();
        asset.rotation_eligible_at = 0;
        asset.updated_at = now;

        emit!(GuardianRotated {
            asset: asset.key(),
            old_guardian,
            new_guardian: asset.guardian,
        });

        Ok(())
    }

    /// Cancel a pending guardian rotation (current guardian only).
    ///
    /// The current guardian can block a rotation they disagree with.
    /// This is the adversarial check: if the owner tries to swap out
    /// a guardian who is about to dispute, the guardian cancels the
    /// rotation and fires the dispute instead.
    pub fn cancel_guardian_rotation(ctx: Context<DisputeAsset>) -> Result<()> {
        let asset = &mut ctx.accounts.asset;

        require!(
            asset.pending_guardian != Pubkey::default(),
            ReceiptGateError::NoRotationPending
        );

        let cancelled_guardian = asset.pending_guardian;
        asset.pending_guardian = Pubkey::default();
        asset.rotation_eligible_at = 0;
        asset.updated_at = Clock::get()?.unix_timestamp;

        emit!(GuardianRotationCancelled {
            asset: asset.key(),
            guardian: ctx.accounts.guardian.key(),
            cancelled_new_guardian: cancelled_guardian,
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

    // ═══════════════════════════════════════════════════════════════════════
    // Token-2022 Transfer Hook
    // ═══════════════════════════════════════════════════════════════════════

    /// Initialize the extra account meta list for a Token-2022 mint.
    /// Links the mint to a ReceiptGatedAsset so the transfer hook can
    /// enforce quality gates on every token transfer.
    pub fn initialize_extra_account_meta_list(
        ctx: Context<InitializeExtraAccountMetaList>,
    ) -> Result<()> {
        // The extra account the hook needs: the ReceiptGatedAsset PDA (read-only)
        let account_metas = vec![
            ExtraAccountMeta::new_with_pubkey(
                &ctx.accounts.asset.key(),
                false, // is_signer
                false, // is_writable
            )
            .map_err(|_| ReceiptGateError::InvalidExtraAccountMeta)?,
        ];

        // Calculate space needed for the TLV list
        let account_size = ExtraAccountMetaList::size_of(account_metas.len())
            .map_err(|_| ReceiptGateError::InvalidExtraAccountMeta)?;
        let lamports = Rent::get()?.minimum_balance(account_size);

        let mint_key = ctx.accounts.mint.key();
        let signer_seeds: &[&[u8]] = &[
            b"extra-account-metas",
            mint_key.as_ref(),
            &[ctx.bumps.extra_account_meta_list],
        ];

        // Create the PDA account
        system_program::create_account(
            CpiContext::new_with_signer(
                ctx.accounts.system_program.to_account_info(),
                system_program::CreateAccount {
                    from: ctx.accounts.payer.to_account_info(),
                    to: ctx.accounts.extra_account_meta_list.to_account_info(),
                },
                &[signer_seeds],
            ),
            lamports,
            account_size as u64,
            ctx.program_id,
        )?;

        // Write the extra account meta list
        ExtraAccountMetaList::init::<spl_transfer_hook_interface::instruction::ExecuteInstruction>(
            &mut ctx.accounts.extra_account_meta_list.try_borrow_mut_data()?,
            &account_metas,
        )
        .map_err(|_| ReceiptGateError::InvalidExtraAccountMeta)?;

        emit!(TransferHookInitialized {
            mint: ctx.accounts.mint.key(),
            asset: ctx.accounts.asset.key(),
        });

        Ok(())
    }

    /// Transfer hook — called by Token-2022 on every transfer of a gated token.
    /// Blocks the transfer if the linked asset fails quality checks.
    ///
    /// Gates:
    /// 1. Asset status must be Active (not Candidate or Quarantined)
    /// 2. AI tensors: cosine_claim must meet per-codec threshold
    /// 3. Other types: threshold must meet default gate (0.998)
    pub fn transfer_hook(ctx: Context<TransferHookAccounts>, _amount: u64) -> Result<()> {
        let asset = &ctx.accounts.asset;

        // Gate 1: Asset must be Active
        require!(
            asset.status == AssetStatus::Active as u8,
            TransferHookError::AssetNotActive
        );

        // Gate 2: Fidelity must meet codec threshold
        if asset.artifact_type == ArtifactType::AiTensor as u8 {
            let required = codec_threshold(asset.codec_id);
            require!(
                asset.cosine_claim >= required,
                TransferHookError::FidelityBelowGate
            );
        } else {
            require!(
                asset.threshold >= THRESHOLD_GATE,
                TransferHookError::FidelityBelowGate
            );
        }

        emit!(TransferHookEnforced {
            mint: ctx.accounts.mint.key(),
            asset: ctx.accounts.asset.key(),
            status: asset.status,
            cosine_claim: asset.cosine_claim,
        });

        Ok(())
    }

    /// Fallback: routes SPL Transfer Hook Execute instructions to our handler.
    /// Token-2022 sends Execute with the SPL discriminator (not Anchor's),
    /// so it doesn't match any Anchor instruction and lands here.
    pub fn fallback<'info>(
        program_id: &Pubkey,
        accounts: &'info [AccountInfo<'info>],
        data: &[u8],
    ) -> Result<()> {
        let instruction = TransferHookInstruction::unpack(data)
            .map_err(|_| ProgramError::InvalidInstructionData)?;

        match instruction {
            TransferHookInstruction::Execute { amount } => {
                let amount_bytes = amount.to_le_bytes();
                __private::__global::transfer_hook(program_id, accounts, &amount_bytes)
            }
            _ => Err(ProgramError::InvalidInstructionData.into()),
        }
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════════════════

/// Default threshold gate for non-AI artifact types.
const THRESHOLD_GATE: f32 = 0.998;

/// Guardian rotation delay: 7 days in seconds.
/// Owner initiates rotation; current guardian has this window to dispute or cancel.
const ROTATION_DELAY_SECONDS: i64 = 7 * 24 * 60 * 60; // 604_800

/// Per-codec fidelity gate. AI tensor assets use cosine_claim against these.
/// Different codecs have different quality ceilings — the gate reflects that.
fn codec_threshold(codec_id: u8) -> f32 {
    match codec_id {
        0 => 0.998,  // Affine6 — HXQ tight gate, proven quality
        1 => 0.998,  // AffineG128 — HXQ, same gate
        2 => 0.997,  // Q5Hierarchical — HXQ, slightly looser
        3 => 0.995,  // Affine4 — HXQ, known quality gap at ~4.5 bpw
        4 => 0.995,  // GPTQ — int4, calibration-required, ~4 bpw
        5 => 0.995,  // AWQ — int4, calibration-required, ~4 bpw
        6 => 0.993,  // bitsandbytes — nf4/int8, wider quality variance
        _ => 0.998,  // Unknown codec — strict default
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Account
// ═══════════════════════════════════════════════════════════════════════════════

#[account]
pub struct ReceiptGatedAsset {
    pub owner: Pubkey,                      // 32
    pub content_hash: [u8; 32],             // 32
    pub original_hash: [u8; 32],            // 32
    pub artifact_type: u8,                  // 1  (0=AiTensor, 1=Legal, 2=Medical, 3=Scientific, 4=SupplyChain, 5=Credential, 255=Generic)
    pub threshold: f32,                     // 4  (generic fidelity gate for non-AI types)
    pub metadata_hash: [u8; 32],            // 32 (SHA-256 of domain-specific metadata)
    // --- Codec-aware fields (populated for AiTensor, zeroed for other types) ---
    pub codec_id: u8,                       // 1  (0=Affine6, 1=AffineG128, 2=Q5Hierarchical, 3=Affine4, 4=GPTQ, 5=AWQ, 6=BnB, 255=Unknown)
    pub group_size: u16,                    // 2  (32, 64, 128, 256)
    pub bits_per_weight: u8,                // 1  (4, 5, 6, 8)
    pub architecture: u8,                   // 1  (0=Transformer, 1=SSM, 2=Hybrid, 3=MoE, 4=Vision)
    pub cosine_claim: f32,                  // 4  (claimed fidelity score — independently verifiable)
    pub ppl_delta_bps: i16,                 // 2  (PPL delta in basis points: +53 = +0.53%)
    pub artifact_cid: [u8; 32],             // 32 (content-addressable locator for off-chain artifact)
    // --- State fields ---
    pub status: u8,                         // 1  (Candidate/Active/Quarantined)
    pub fidelity_receipt_hash: [u8; 32],    // 32
    pub behavioral_receipt_hash: [u8; 32],  // 32
    pub risk_attestation_hash: [u8; 32],    // 32
    pub transfer_count: u32,                // 4
    pub created_at: i64,                    // 8
    pub updated_at: i64,                    // 8
    pub bump: u8,                           // 1
    pub guardian: Pubkey,                   // 32 (GuardianCell — independent verifier who can dispute)
    // --- Guardian rotation (timelock) ---
    pub pending_guardian: Pubkey,           // 32 (proposed replacement, zero = no rotation pending)
    pub rotation_eligible_at: i64,         // 8  (unix timestamp when finalize_guardian_rotation becomes callable)
}

impl ReceiptGatedAsset {
    // 334 (previous) + 32 (pending_guardian) + 8 (rotation_eligible_at) = 374
    pub const LEN: usize = 8 + 32 + 32 + 32 + 1 + 4 + 32 + 1 + 2 + 1 + 1 + 4 + 2 + 32 + 1 + 32 + 32 + 32 + 4 + 8 + 8 + 1 + 32 + 32 + 8;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Artifact types
// ═══════════════════════════════════════════════════════════════════════════════

/// Domain-specific artifact types. AI tensor type gets per-codec threshold gate;
/// other types use the generic threshold field.
#[repr(u8)]
pub enum ArtifactType {
    AiTensor = 0,
    LegalDocument = 1,
    MedicalRecord = 2,
    ScientificCompute = 3,
    SupplyChain = 4,
    Credential = 5,
    Generic = 255,
}

/// Codec variants. Determines per-codec threshold gate for AI tensor assets.
/// Slots 0-3: HXQ native codecs. Slots 4-6: third-party codecs.
/// 251 slots remain open for future codecs.
#[repr(u8)]
pub enum CodecId {
    Affine6 = 0,         // HXQ 6.25 bpw, tight gate 0.998
    AffineG128 = 1,      // HXQ 8.25 bpw, tight gate 0.998
    Q5Hierarchical = 2,  // HXQ 5.5 bpw, gate 0.997
    Affine4 = 3,         // HXQ ~4.5 bpw, gate 0.995
    Gptq = 4,            // GPTQ int4, ~4 bpw, gate 0.995 (calibration-required)
    Awq = 5,             // AWQ int4, ~4 bpw, gate 0.995 (calibration-required)
    BitsAndBytes = 6,    // bitsandbytes nf4/int8, gate 0.993
    Unknown = 255,
}

/// Model architecture — the chain knows what it's compressing.
#[repr(u8)]
pub enum Architecture {
    Transformer = 0,
    Ssm = 1,
    Hybrid = 2,    // e.g. Zamba2 (transformer + mamba)
    Moe = 3,
    Vision = 4,
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

/// GuardianCell dispute context — guardian signs, NOT the owner.
#[derive(Accounts)]
pub struct DisputeAsset<'info> {
    #[account(mut, has_one = guardian @ ReceiptGateError::DisputeNotAuthorized)]
    pub asset: Account<'info, ReceiptGatedAsset>,
    pub guardian: Signer<'info>,
}

// ═══════════════════════════════════════════════════════════════════════════════
// Transfer Hook account contexts
// ═══════════════════════════════════════════════════════════════════════════════

#[derive(Accounts)]
pub struct InitializeExtraAccountMetaList<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    /// CHECK: ExtraAccountMetaList PDA — validated by seeds.
    #[account(
        mut,
        seeds = [b"extra-account-metas", mint.key().as_ref()],
        bump,
    )]
    pub extra_account_meta_list: UncheckedAccount<'info>,

    /// The Token-2022 mint with TransferHook extension pointing to this program.
    pub mint: InterfaceAccount<'info, Mint>,

    /// The ReceiptGatedAsset to link to this mint for transfer enforcement.
    pub asset: Account<'info, ReceiptGatedAsset>,

    pub system_program: Program<'info, System>,
}

/// Accounts for the transfer hook execution.
/// Order matches Token-2022's CPI: source, mint, dest, authority, extra_metas, [extras...]
#[derive(Accounts)]
pub struct TransferHookAccounts<'info> {
    /// CHECK: Source token account — validated by Token-2022.
    pub source_token: InterfaceAccount<'info, TokenAccount>,

    /// The Token-2022 mint.
    pub mint: InterfaceAccount<'info, Mint>,

    /// CHECK: Destination token account — validated by Token-2022.
    pub destination_token: InterfaceAccount<'info, TokenAccount>,

    /// CHECK: Transfer authority — validated by Token-2022.
    pub authority: UncheckedAccount<'info>,

    /// CHECK: ExtraAccountMetaList PDA — validated by seeds.
    #[account(
        seeds = [b"extra-account-metas", mint.key().as_ref()],
        bump,
    )]
    pub extra_account_meta_list: UncheckedAccount<'info>,

    /// The linked ReceiptGatedAsset — this is the extra account defined in the meta list.
    pub asset: Account<'info, ReceiptGatedAsset>,
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
    pub codec_id: u8,
    pub architecture: u8,
    pub cosine_claim: f32,
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
pub struct AssetDisputed {
    pub asset: Pubkey,
    pub guardian: Pubkey,
    pub dispute_receipt_hash: [u8; 32],
}

#[event]
pub struct GuardianRotationInitiated {
    pub asset: Pubkey,
    pub current_guardian: Pubkey,
    pub new_guardian: Pubkey,
    pub eligible_at: i64,
}

#[event]
pub struct GuardianRotated {
    pub asset: Pubkey,
    pub old_guardian: Pubkey,
    pub new_guardian: Pubkey,
}

#[event]
pub struct GuardianRotationCancelled {
    pub asset: Pubkey,
    pub guardian: Pubkey,
    pub cancelled_new_guardian: Pubkey,
}

#[event]
pub struct AssetTransferred {
    pub asset: Pubkey,
    pub from: Pubkey,
    pub to: Pubkey,
    pub transfer_count: u32,
}

#[event]
pub struct TransferHookInitialized {
    pub mint: Pubkey,
    pub asset: Pubkey,
}

#[event]
pub struct TransferHookEnforced {
    pub mint: Pubkey,
    pub asset: Pubkey,
    pub status: u8,
    pub cosine_claim: f32,
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
    #[msg("Invalid extra account meta configuration")]
    InvalidExtraAccountMeta,
    #[msg("No guardian set for this asset")]
    NoGuardianSet,
    #[msg("Dispute receipt hash must be non-zero")]
    MissingDisputeReceipt,
    #[msg("Only the designated guardian can dispute this asset")]
    DisputeNotAuthorized,
    #[msg("New guardian must be a non-zero pubkey")]
    InvalidNewGuardian,
    #[msg("A guardian rotation is already pending")]
    RotationAlreadyPending,
    #[msg("No guardian rotation is pending")]
    NoRotationPending,
    #[msg("Rotation timelock has not elapsed yet")]
    RotationNotEligible,
}

#[error_code]
pub enum TransferHookError {
    #[msg("Transfer blocked: asset is not Active")]
    AssetNotActive,
    #[msg("Transfer blocked: fidelity below codec gate")]
    FidelityBelowGate,
}
