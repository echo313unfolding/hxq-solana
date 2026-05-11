#!/usr/bin/env python3
"""Generate a pair of test artifacts for verify_claim.py testing.

Creates:
  - test_original.npy: random float32 tensor (simulates FP16 weights)
  - test_compressed.npy: affine-quantized version (simulates HXQ output)
  - test_claim.json: on-chain claim data matching these artifacts

The compressed tensor uses real per-group affine quantization (scale*index+offset)
so the cosine similarity is genuine, not synthetic.
"""

import hashlib
import json
import numpy as np
from pathlib import Path


def affine_quantize_group(group: np.ndarray, n_levels: int = 64) -> np.ndarray:
    """Per-group affine quantization: scale * index + offset."""
    vmin, vmax = group.min(), group.max()
    if vmax == vmin:
        return np.full_like(group, vmin)
    scale = (vmax - vmin) / (n_levels - 1)
    offset = vmin
    indices = np.round((group - offset) / scale).clip(0, n_levels - 1)
    return (indices * scale + offset).astype(np.float32)


def affine_quantize(tensor: np.ndarray, group_size: int = 128,
                     n_levels: int = 64) -> np.ndarray:
    """Full tensor affine quantization with per-group scale+offset."""
    flat = tensor.flatten()
    n = len(flat)
    # Pad to multiple of group_size
    pad = (group_size - n % group_size) % group_size
    if pad:
        flat = np.concatenate([flat, np.zeros(pad, dtype=np.float32)])

    result = np.empty_like(flat)
    for i in range(0, len(flat), group_size):
        result[i:i+group_size] = affine_quantize_group(
            flat[i:i+group_size], n_levels)

    return result[:n].reshape(tensor.shape)


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def main():
    out_dir = Path(__file__).parent.parent / "test_artifacts"
    out_dir.mkdir(exist_ok=True)

    rng = np.random.default_rng(42)

    # Simulate a real model weight tensor (2048 x 768 = ~6MB)
    shape = (2048, 768)
    original = rng.standard_normal(shape).astype(np.float32) * 0.02
    print(f"Original: shape={shape}, dtype=float32, numel={original.size}")

    # Compress with affine quantization (6-bit = 64 levels, group_size=128)
    compressed = affine_quantize(original, group_size=128, n_levels=64)

    # Compute cosine
    a = original.flatten().astype(np.float64)
    b = compressed.flatten().astype(np.float64)
    cosine = float(np.dot(a, b) / (np.linalg.norm(a) * np.linalg.norm(b)))
    print(f"Cosine similarity: {cosine:.6f}")

    # Save
    orig_path = out_dir / "test_original.npy"
    comp_path = out_dir / "test_compressed.npy"
    np.save(orig_path, original)
    np.save(comp_path, compressed)

    # Compute hashes
    content_hash = sha256_file(comp_path)
    original_hash = sha256_file(orig_path)

    # Write claim JSON
    claim = {
        "content_hash": content_hash,
        "original_hash": original_hash,
        "cosine_claim": round(cosine, 6),
        "codec_id": 0,
        "codec_name": "affine_6",
        "group_size": 128,
        "bits_per_weight": 6,
        "architecture": 0,
        "architecture_name": "transformer",
        "ppl_delta_bps": 53,
    }

    claim_path = out_dir / "test_claim.json"
    with open(claim_path, "w") as f:
        json.dump(claim, f, indent=2)

    print(f"\nArtifacts written to {out_dir}/:")
    print(f"  test_original.npy   ({orig_path.stat().st_size / 1024:.0f} KB)")
    print(f"  test_compressed.npy ({comp_path.stat().st_size / 1024:.0f} KB)")
    print(f"  test_claim.json")
    print(f"\n  content_hash:  {content_hash[:32]}...")
    print(f"  original_hash: {original_hash[:32]}...")
    print(f"  cosine_claim:  {cosine:.6f}")

    # Also write a tampered version (flip some values)
    tampered = compressed.copy()
    tampered[:100, :100] = 999.0  # Obvious tampering
    tampered_path = out_dir / "test_tampered.npy"
    np.save(tampered_path, tampered)
    print(f"\n  test_tampered.npy (for DISPUTED test)")


if __name__ == "__main__":
    main()
