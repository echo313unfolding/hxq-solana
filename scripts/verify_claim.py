#!/usr/bin/env python3
"""
verify_claim.py — Independent verifier for HXQ-Solana on-chain claims.

Takes an on-chain asset's data (from JSON export or live RPC) and off-chain
artifact paths. Recomputes SHA-256 hashes and cosine similarity independently.
Compares to on-chain claims. Outputs VERIFIED or DISPUTED.

This is the piece that makes on-chain commitment meaningful:
  - The chain stores: content_hash, original_hash, cosine_claim, codec params
  - This script: fetches artifacts, recomputes, compares
  - If they match: VERIFIED (commitment is honest)
  - If they diverge: DISPUTED (commitment is fraudulent, chain is proof)

Usage:
    # From exported on-chain account JSON + local artifact files:
    python3 scripts/verify_claim.py \\
        --account receipts/hxq_solana_lifecycle_demo_20260508.json \\
        --compressed /path/to/compressed.bin \\
        --original /path/to/original.bin

    # From on-chain account fields directly:
    python3 scripts/verify_claim.py \\
        --content-hash abc123... \\
        --original-hash def456... \\
        --cosine-claim 0.9993 \\
        --codec-id 0 \\
        --compressed /path/to/compressed.npy \\
        --original /path/to/original.npy
"""

import argparse
import hashlib
import json
import sys
import time
import platform
import resource
from pathlib import Path

import numpy as np


# ═══════════════════════════════════════════════════════════════════════════════
# Codec registry — mirrors the on-chain CodecId enum
# ═══════════════════════════════════════════════════════════════════════════════

CODEC_NAMES = {
    0: "affine_6",
    1: "affine_g128",
    2: "q5_hierarchical",
    3: "affine_4",
    255: "unknown",
}

CODEC_THRESHOLDS = {
    0: 0.998,
    1: 0.998,
    2: 0.997,
    3: 0.995,
}

ARCH_NAMES = {
    0: "transformer",
    1: "ssm",
    2: "hybrid",
    3: "moe",
    4: "vision",
}


# ═══════════════════════════════════════════════════════════════════════════════
# Core verification
# ═══════════════════════════════════════════════════════════════════════════════

def sha256_file(path: Path) -> str:
    """Compute SHA-256 hex digest of a file."""
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def cosine_similarity(a: np.ndarray, b: np.ndarray) -> float:
    """Compute cosine similarity between two flat arrays."""
    a_flat = a.flatten().astype(np.float64)
    b_flat = b.flatten().astype(np.float64)
    dot = np.dot(a_flat, b_flat)
    norm_a = np.linalg.norm(a_flat)
    norm_b = np.linalg.norm(b_flat)
    if norm_a == 0 or norm_b == 0:
        return 0.0
    return float(dot / (norm_a * norm_b))


def load_tensor(path: Path) -> np.ndarray:
    """Load a tensor from .npy, .bin (raw float32), or .safetensors."""
    suffix = path.suffix.lower()
    if suffix == ".npy":
        return np.load(path)
    elif suffix == ".bin":
        return np.fromfile(path, dtype=np.float32)
    elif suffix == ".safetensors":
        try:
            from safetensors.numpy import load_file
            tensors = load_file(str(path))
            # Return the first (or only) tensor
            key = next(iter(tensors))
            return tensors[key]
        except ImportError:
            print("ERROR: safetensors not installed. pip install safetensors")
            sys.exit(1)
    else:
        # Try as raw float32
        return np.fromfile(path, dtype=np.float32)


def dequantize_hxq(compressed_path: Path, codec_id: int,
                    group_size: int) -> np.ndarray:
    """Dequantize an HXQ-compressed artifact back to float32.

    For v0: loads the compressed tensor as-is if it's already float32
    (e.g., from a dequantized export). Future: call helix-codec C library.
    """
    suffix = compressed_path.suffix.lower()

    # If it's a .npy file, it might be pre-dequantized or raw indices
    if suffix == ".npy":
        data = np.load(compressed_path)
        if data.dtype == np.float32 or data.dtype == np.float64:
            return data  # Already dequantized
        # TODO: call helix-codec for actual dequantization from indices
        print(f"  WARNING: compressed tensor is {data.dtype}, not float32.")
        print(f"  For full verification, export a dequantized .npy or use helix-codec.")
        return data.astype(np.float32)

    # Try helix-codec Python bindings
    try:
        sys.path.insert(0, str(Path.home() / "helix-substrate"))
        from helix_substrate.codec import hxq_dequantize
        return hxq_dequantize(compressed_path, codec_id, group_size)
    except (ImportError, ModuleNotFoundError):
        pass

    # Fallback: load as raw float32
    return np.fromfile(compressed_path, dtype=np.float32)


# ═══════════════════════════════════════════════════════════════════════════════
# Main
# ═══════════════════════════════════════════════════════════════════════════════

def main():
    parser = argparse.ArgumentParser(
        description="Independent verifier for HXQ-Solana on-chain claims")

    # On-chain claim (either from JSON or direct fields)
    parser.add_argument("--account", type=str,
                        help="Path to exported on-chain account JSON")
    parser.add_argument("--content-hash", type=str,
                        help="On-chain content_hash (hex)")
    parser.add_argument("--original-hash", type=str,
                        help="On-chain original_hash (hex)")
    parser.add_argument("--cosine-claim", type=float,
                        help="On-chain cosine_claim")
    parser.add_argument("--codec-id", type=int, default=0,
                        help="On-chain codec_id (0=af6, 1=g128, 2=q5h, 3=af4)")
    parser.add_argument("--group-size", type=int, default=128)
    parser.add_argument("--architecture", type=int, default=0)
    parser.add_argument("--ppl-delta-bps", type=int, default=0)

    # Off-chain artifacts
    parser.add_argument("--compressed", type=str,
                        help="Path to compressed artifact file")
    parser.add_argument("--original", type=str,
                        help="Path to original (uncompressed) artifact file")

    # Options
    parser.add_argument("--tolerance", type=float, default=0.001,
                        help="Cosine comparison tolerance (default 0.001)")
    parser.add_argument("--output", type=str, default=None,
                        help="Output receipt JSON path")

    args = parser.parse_args()

    t_start = time.time()
    cpu_start = time.process_time()
    start_iso = time.strftime('%Y-%m-%dT%H:%M:%S')

    # ─── Load on-chain claim ─────────────────────────────────────────────
    if args.account:
        with open(args.account) as f:
            account = json.load(f)
        content_hash = account.get("content_hash", "")
        original_hash = account.get("original_hash", "")
        cosine_claim = account.get("cosine_claim",
                                    account.get("threshold", 0.0))
        codec_id = account.get("codec_id", account.get("codec", 0))
        group_size = account.get("group_size", 128)
        architecture = account.get("architecture", 0)
        ppl_delta_bps = account.get("ppl_delta_bps",
                                     int(account.get("ppl_delta_pct", 0) * 100))
    else:
        content_hash = args.content_hash or ""
        original_hash = args.original_hash or ""
        cosine_claim = args.cosine_claim or 0.0
        codec_id = args.codec_id
        group_size = args.group_size
        architecture = args.architecture
        ppl_delta_bps = args.ppl_delta_bps

    codec_name = CODEC_NAMES.get(codec_id, f"unknown({codec_id})")
    arch_name = ARCH_NAMES.get(architecture, f"unknown({architecture})")
    codec_gate = CODEC_THRESHOLDS.get(codec_id, 0.998)

    print("=" * 64)
    print("HXQ-SOLANA INDEPENDENT CLAIM VERIFIER")
    print("=" * 64)
    print(f"  Codec:        {codec_name} (id={codec_id})")
    print(f"  Architecture: {arch_name} (id={architecture})")
    print(f"  Group size:   {group_size}")
    print(f"  Cosine claim: {cosine_claim}")
    print(f"  Codec gate:   {codec_gate}")
    print(f"  PPL delta:    {ppl_delta_bps} bps ({ppl_delta_bps/100:.2f}%)")

    results = {
        "claim": {
            "content_hash": content_hash,
            "original_hash": original_hash,
            "cosine_claim": cosine_claim,
            "codec_id": codec_id,
            "codec_name": codec_name,
            "architecture": architecture,
            "architecture_name": arch_name,
            "group_size": group_size,
            "ppl_delta_bps": ppl_delta_bps,
            "codec_gate": codec_gate,
        },
        "checks": {},
        "verdict": "INCOMPLETE",
    }

    all_pass = True

    # ─── Check 1: Hash verification ─────────────────────────────────────
    print(f"\n{'─'*64}")
    print("CHECK 1: SHA-256 hash verification")
    print(f"{'─'*64}")

    if args.compressed and Path(args.compressed).exists():
        measured_content = sha256_file(Path(args.compressed))
        hash_match = (measured_content == content_hash) if content_hash else None
        print(f"  On-chain content_hash: {content_hash[:32]}..." if content_hash else "  On-chain content_hash: (not provided)")
        print(f"  Measured content_hash: {measured_content[:32]}...")
        if hash_match is True:
            print(f"  Content hash: MATCH")
        elif hash_match is False:
            print(f"  Content hash: MISMATCH")
            all_pass = False
        else:
            print(f"  Content hash: SKIP (no on-chain hash to compare)")
        results["checks"]["content_hash_match"] = hash_match
    else:
        print("  Compressed artifact not provided — skipping hash check")
        results["checks"]["content_hash_match"] = None

    if args.original and Path(args.original).exists():
        measured_original = sha256_file(Path(args.original))
        orig_match = (measured_original == original_hash) if original_hash else None
        print(f"  On-chain original_hash: {original_hash[:32]}..." if original_hash else "  On-chain original_hash: (not provided)")
        print(f"  Measured original_hash: {measured_original[:32]}...")
        if orig_match is True:
            print(f"  Original hash: MATCH")
        elif orig_match is False:
            print(f"  Original hash: MISMATCH")
            all_pass = False
        else:
            print(f"  Original hash: SKIP (no on-chain hash to compare)")
        results["checks"]["original_hash_match"] = orig_match
    else:
        print("  Original artifact not provided — skipping hash check")
        results["checks"]["original_hash_match"] = None

    # ─── Check 2: Cosine fidelity verification ──────────────────────────
    print(f"\n{'─'*64}")
    print("CHECK 2: Cosine fidelity verification")
    print(f"{'─'*64}")

    if args.compressed and args.original and \
       Path(args.compressed).exists() and Path(args.original).exists():
        print(f"  Loading original: {args.original}")
        original_tensor = load_tensor(Path(args.original))
        print(f"    shape={original_tensor.shape}, dtype={original_tensor.dtype}, "
              f"numel={original_tensor.size}")

        print(f"  Loading/dequantizing compressed: {args.compressed}")
        decompressed_tensor = dequantize_hxq(
            Path(args.compressed), codec_id, group_size)
        print(f"    shape={decompressed_tensor.shape}, dtype={decompressed_tensor.dtype}, "
              f"numel={decompressed_tensor.size}")

        if original_tensor.size != decompressed_tensor.size:
            print(f"  ERROR: size mismatch ({original_tensor.size} vs "
                  f"{decompressed_tensor.size})")
            results["checks"]["cosine_verified"] = False
            results["checks"]["cosine_measured"] = None
            all_pass = False
        else:
            measured_cosine = cosine_similarity(original_tensor,
                                                 decompressed_tensor)
            delta = abs(measured_cosine - cosine_claim)
            cosine_match = delta <= args.tolerance

            print(f"  On-chain cosine_claim: {cosine_claim:.6f}")
            print(f"  Measured cosine:       {measured_cosine:.6f}")
            print(f"  Delta:                 {delta:.6f} "
                  f"(tolerance: {args.tolerance})")
            print(f"  Cosine: {'MATCH' if cosine_match else 'MISMATCH'}")

            # Also check against codec gate
            meets_gate = measured_cosine >= codec_gate
            print(f"  Meets codec gate ({codec_gate}): "
                  f"{'YES' if meets_gate else 'NO'}")

            results["checks"]["cosine_measured"] = round(measured_cosine, 6)
            results["checks"]["cosine_delta"] = round(delta, 6)
            results["checks"]["cosine_verified"] = cosine_match
            results["checks"]["meets_codec_gate"] = meets_gate

            if not cosine_match:
                all_pass = False
    else:
        print("  Both artifacts required for cosine check — skipping")
        results["checks"]["cosine_verified"] = None

    # ─── Check 3: Codec gate check ──────────────────────────────────────
    print(f"\n{'─'*64}")
    print("CHECK 3: Codec gate compliance")
    print(f"{'─'*64}")

    claim_meets_gate = cosine_claim >= codec_gate
    print(f"  Claimed cosine {cosine_claim} >= gate {codec_gate}: "
          f"{'PASS' if claim_meets_gate else 'FAIL'}")
    results["checks"]["claim_meets_gate"] = claim_meets_gate
    if not claim_meets_gate:
        all_pass = False

    # ─── Verdict ─────────────────────────────────────────────────────────
    # Determine what we could verify
    checks_run = [v for v in results["checks"].values() if v is not None]
    checks_passed = [v for v in checks_run if v is True]

    if not checks_run:
        verdict = "INCOMPLETE"
        verdict_detail = "No artifacts provided — cannot verify"
    elif all_pass:
        verdict = "VERIFIED"
        verdict_detail = (f"{len(checks_passed)}/{len(checks_run)} checks passed. "
                          f"On-chain commitment matches independent measurement.")
    else:
        verdict = "DISPUTED"
        failed = [k for k, v in results["checks"].items()
                  if v is False]
        verdict_detail = (f"FAILED checks: {', '.join(failed)}. "
                          f"On-chain commitment does NOT match independent measurement.")

    results["verdict"] = verdict
    results["verdict_detail"] = verdict_detail

    # Cost block
    results["cost"] = {
        "wall_time_s": round(time.time() - t_start, 3),
        "cpu_time_s": round(time.process_time() - cpu_start, 3),
        "peak_memory_mb": round(
            resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024, 1),
        "python_version": platform.python_version(),
        "hostname": platform.node(),
        "timestamp_start": start_iso,
        "timestamp_end": time.strftime('%Y-%m-%dT%H:%M:%S'),
    }

    print(f"\n{'='*64}")
    print(f"VERDICT: {verdict}")
    print(f"{'='*64}")
    print(f"  {verdict_detail}")

    # Write receipt
    if args.output:
        out_path = Path(args.output)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        with open(out_path, "w") as f:
            json.dump(results, f, indent=2)
        print(f"\n  Receipt: {out_path}")

    return 0 if verdict == "VERIFIED" else (2 if verdict == "DISPUTED" else 1)


if __name__ == "__main__":
    sys.exit(main())
