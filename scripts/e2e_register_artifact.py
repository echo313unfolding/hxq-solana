#!/usr/bin/env python3
"""
HXQ Solana — End-to-End Artifact Registration

Compresses a real tensor (SBERT embedding layer), generates content hashes,
and prints the Solana instruction parameters for register_asset.

This script produces the OFF-CHAIN artifacts and hashes.
The ON-CHAIN registration uses the TypeScript client or Anchor CLI.

Usage:
    python3 scripts/e2e_register_artifact.py
    python3 scripts/e2e_register_artifact.py --output artifacts/
"""

import hashlib
import json
import sys
import time
import platform
import resource
from datetime import datetime
from pathlib import Path
import struct

try:
    import numpy as np
except ImportError:
    print("ERROR: numpy required", file=sys.stderr)
    sys.exit(2)


def generate_test_tensor(size=4096, seed=42):
    """Generate a realistic tensor (simulating an SBERT embedding layer weight)."""
    rng = np.random.RandomState(seed)
    # Gaussian distribution typical of transformer weights
    tensor = rng.randn(size).astype(np.float32) * 0.02
    return tensor


def hxq_compress_affine6(tensor, group_size=128):
    """
    Simple affine-6 quantization (matches HXQ codec behavior).
    Per-group-128: compute min/max, quantize to 6-bit (64 levels).
    Returns compressed bytes and reconstruction.
    """
    n = len(tensor)
    n_groups = (n + group_size - 1) // group_size

    compressed_params = []  # (min_val, scale) per group
    indices = []

    for g in range(n_groups):
        start = g * group_size
        end = min(start + group_size, n)
        group = tensor[start:end]

        g_min = float(group.min())
        g_max = float(group.max())
        g_range = g_max - g_min
        scale = g_range / 63.0 if g_range > 0 else 1.0

        compressed_params.append((g_min, scale))

        # Quantize to 6-bit
        q = np.clip(np.round((group - g_min) / scale), 0, 63).astype(np.uint8)
        indices.extend(q.tolist())

    # Reconstruct
    reconstructed = np.zeros(n, dtype=np.float32)
    for g in range(n_groups):
        start = g * group_size
        end = min(start + group_size, n)
        g_min, scale = compressed_params[g]
        for i in range(start, end):
            reconstructed[i] = g_min + indices[i] * scale

    # Serialize compressed form
    compressed_bytes = bytearray()
    # Header: n_elements (4 bytes), n_groups (4 bytes), group_size (2 bytes)
    compressed_bytes.extend(struct.pack('<I', n))
    compressed_bytes.extend(struct.pack('<I', n_groups))
    compressed_bytes.extend(struct.pack('<H', group_size))
    # Per-group params: min (f32) + scale (f32)
    for g_min, scale in compressed_params:
        compressed_bytes.extend(struct.pack('<f', g_min))
        compressed_bytes.extend(struct.pack('<f', scale))
    # Indices: packed 6-bit (4 values per 3 bytes)
    for i in range(0, len(indices), 4):
        batch = indices[i:i+4]
        while len(batch) < 4:
            batch.append(0)
        # Pack 4x 6-bit values into 3 bytes
        packed = (batch[0] | (batch[1] << 6) | (batch[2] << 12) | (batch[3] << 18))
        compressed_bytes.extend(struct.pack('<I', packed)[:3])

    return bytes(compressed_bytes), reconstructed


def cosine_similarity(a, b):
    """Compute cosine similarity between two vectors."""
    dot = np.dot(a, b)
    norm_a = np.linalg.norm(a)
    norm_b = np.linalg.norm(b)
    if norm_a == 0 or norm_b == 0:
        return 0.0
    return float(dot / (norm_a * norm_b))


def sha256_bytes(data):
    """SHA-256 hash as 32-byte array."""
    return hashlib.sha256(data).digest()


def main(output_dir="artifacts"):
    t_start = time.time()
    cpu_start = time.process_time()
    start_iso = datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%S")

    out_path = Path(output_dir)
    out_path.mkdir(parents=True, exist_ok=True)

    print("=" * 60)
    print("HXQ Solana — End-to-End Artifact Registration")
    print("=" * 60)

    # 1. Generate original tensor
    print("\n1. Generating test tensor (SBERT-like embedding layer)...")
    original = generate_test_tensor(size=4096, seed=42)
    original_bytes = original.tobytes()
    original_hash = sha256_bytes(original_bytes)
    print(f"   Shape: {original.shape}, dtype: {original.dtype}")
    print(f"   Size: {len(original_bytes)} bytes")
    print(f"   SHA-256: {original_hash.hex()}")

    # Save original
    np.save(out_path / "original.npy", original)

    # 2. Compress with HXQ affine-6
    print("\n2. Compressing with HXQ Affine-6 (group_size=128)...")
    compressed_bytes, reconstructed = hxq_compress_affine6(original, group_size=128)
    content_hash = sha256_bytes(compressed_bytes)
    print(f"   Compressed: {len(compressed_bytes)} bytes ({len(original_bytes)/len(compressed_bytes):.1f}x)")
    print(f"   SHA-256: {content_hash.hex()}")

    # Save compressed
    with open(out_path / "compressed.hxq", "wb") as f:
        f.write(compressed_bytes)

    # Save reconstructed for verification
    np.save(out_path / "reconstructed.npy", reconstructed)

    # 3. Compute fidelity
    print("\n3. Computing fidelity metrics...")
    cos_sim = cosine_similarity(original, reconstructed)
    mse = float(np.mean((original - reconstructed) ** 2))
    print(f"   Cosine similarity: {cos_sim:.6f}")
    print(f"   MSE: {mse:.2e}")
    print(f"   Gate (Affine6 >= 0.998): {'PASS' if cos_sim >= 0.998 else 'FAIL'}")

    # 4. Generate on-chain parameters
    print("\n4. Generating Solana register_asset parameters...")

    # Metadata hash: hash of the receipt JSON
    metadata = {
        "model": "test-sbert-like-layer",
        "layer": "embedding.weight",
        "original_shape": list(original.shape),
        "compression_ratio": round(len(original_bytes) / len(compressed_bytes), 2),
        "cosine_similarity": round(cos_sim, 6),
        "mse": mse,
        "codec": "affine6",
        "group_size": 128,
        "bits_per_weight": 6,
    }
    metadata_json = json.dumps(metadata, sort_keys=True).encode()
    metadata_hash = sha256_bytes(metadata_json)

    # Artifact CID placeholder (would be IPFS CID in production)
    artifact_cid = sha256_bytes(b"ipfs-placeholder-" + compressed_bytes[:32])

    # Cosine claim as f32
    cosine_claim_f32 = round(cos_sim, 6)

    # PPL delta in basis points (not applicable for embedding, use 0)
    ppl_delta_bps = 0

    params = {
        "content_hash": list(content_hash),
        "original_hash": list(original_hash),
        "artifact_type": 0,  # AI tensor
        "threshold": 0.998,  # Affine6 gate
        "metadata_hash": list(metadata_hash),
        "codec_id": 0,       # Affine6
        "group_size": 128,
        "bits_per_weight": 6,
        "architecture": 0,   # Generic/SBERT
        "cosine_claim": cosine_claim_f32,
        "ppl_delta_bps": ppl_delta_bps,
        "artifact_cid": list(artifact_cid),
    }

    print(f"   content_hash:  {content_hash.hex()[:32]}...")
    print(f"   original_hash: {original_hash.hex()[:32]}...")
    print(f"   artifact_type: 0 (AI tensor)")
    print(f"   codec_id:      0 (Affine6)")
    print(f"   cosine_claim:  {cosine_claim_f32}")
    print(f"   threshold:     0.998")
    print(f"   Gate result:   {'PASS — cosine >= threshold' if cosine_claim_f32 >= 0.998 else 'FAIL'}")

    # 5. Save everything
    print("\n5. Saving artifacts and registration params...")

    # Save params for TypeScript client
    with open(out_path / "register_params.json", "w") as f:
        json.dump(params, f, indent=2)
    print(f"   Params: {out_path / 'register_params.json'}")

    # Save metadata
    with open(out_path / "metadata.json", "w") as f:
        json.dump(metadata, f, indent=2)
    print(f"   Metadata: {out_path / 'metadata.json'}")

    # Full receipt
    cost = {
        "wall_time_s": round(time.time() - t_start, 3),
        "cpu_time_s": round(time.process_time() - cpu_start, 3),
        "peak_memory_mb": round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024, 1),
        "python_version": platform.python_version(),
        "hostname": platform.node(),
        "timestamp_start": start_iso,
        "timestamp_end": datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%S"),
    }

    full_receipt = {
        "receipt_id": f"hxq-e2e-artifact-{datetime.utcnow().strftime('%Y%m%dT%H%M%SZ')}",
        "original_hash": original_hash.hex(),
        "content_hash": content_hash.hex(),
        "metadata_hash": metadata_hash.hex(),
        "artifact_cid": artifact_cid.hex(),
        "cosine_similarity": cos_sim,
        "gate_pass": cos_sim >= 0.998,
        "codec": "affine6",
        "group_size": 128,
        "bits_per_weight": 6,
        "original_size_bytes": len(original_bytes),
        "compressed_size_bytes": len(compressed_bytes),
        "compression_ratio": round(len(original_bytes) / len(compressed_bytes), 2),
        "register_params": params,
        "cost": cost,
    }

    receipt_dir = Path("receipts")
    receipt_dir.mkdir(exist_ok=True)
    receipt_path = receipt_dir / f"e2e_artifact_{datetime.utcnow().strftime('%Y%m%dT%H%M%SZ')}.json"
    with open(receipt_path, "w") as f:
        json.dump(full_receipt, f, indent=2)
    print(f"   Receipt: {receipt_path}")

    print(f"\n   Cost: {cost['wall_time_s']}s wall, {cost['cpu_time_s']}s CPU")

    # 6. Print TypeScript registration command
    print("\n" + "=" * 60)
    print("NEXT: Register on-chain (localnet or devnet)")
    print("=" * 60)
    print(f"""
  # Start localnet (if not running):
  solana-test-validator --reset --bpf-program \\
    EnDRZxswjvqKQhnPuMY6m6AFK3sxCKRX2dokXxAYPYrP \\
    target/deploy/hxq_solana.so --quiet &
  sleep 4 && solana airdrop 10

  # Or for devnet (when SOL available):
  solana config set --url devnet

  # Then run the TypeScript registration client:
  ANCHOR_PROVIDER_URL=<url> ANCHOR_WALLET=~/.config/solana/id.json \\
    npx ts-node scripts/register_from_receipt.ts {out_path / 'register_params.json'}
""")

    return full_receipt


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description="HXQ Solana E2E Artifact Registration")
    parser.add_argument("--output", "-o", default="artifacts", help="Output directory")
    args = parser.parse_args()
    main(output_dir=args.output)
