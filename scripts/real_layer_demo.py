#!/usr/bin/env python3
"""
HXQ Solana — Real Model Layer Demo

Extracts a REAL embedding layer from all-MiniLM-L6-v2 (SBERT),
compresses it with HXQ affine-6, computes fidelity metrics,
and generates register_params.json for on-chain registration.

This is NOT a test tensor — this is production SBERT weights.
"""

import hashlib
import json
import sys
import time
import platform
import resource
import struct
from datetime import datetime
from pathlib import Path

import numpy as np
import torch


def hxq_compress_affine6(tensor, group_size=128):
    """HXQ affine-6 quantization. Per-group-128: min/max → 6-bit (64 levels)."""
    n = len(tensor)
    n_groups = (n + group_size - 1) // group_size

    compressed_params = []
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

    # Serialize
    compressed_bytes = bytearray()
    compressed_bytes.extend(struct.pack('<I', n))
    compressed_bytes.extend(struct.pack('<I', n_groups))
    compressed_bytes.extend(struct.pack('<H', group_size))
    for g_min, scale in compressed_params:
        compressed_bytes.extend(struct.pack('<f', g_min))
        compressed_bytes.extend(struct.pack('<f', scale))
    for i in range(0, len(indices), 4):
        batch = indices[i:i+4]
        while len(batch) < 4:
            batch.append(0)
        packed = (batch[0] | (batch[1] << 6) | (batch[2] << 12) | (batch[3] << 18))
        compressed_bytes.extend(struct.pack('<I', packed)[:3])

    return bytes(compressed_bytes), reconstructed


def cosine_similarity(a, b):
    dot = np.dot(a, b)
    norm_a = np.linalg.norm(a)
    norm_b = np.linalg.norm(b)
    if norm_a == 0 or norm_b == 0:
        return 0.0
    return float(dot / (norm_a * norm_b))


def sha256_bytes(data):
    return hashlib.sha256(data).digest()


def main():
    t_start = time.time()
    cpu_start = time.process_time()
    start_iso = datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%S")

    out_path = Path("artifacts/sbert_real_layer")
    out_path.mkdir(parents=True, exist_ok=True)

    print("=" * 65)
    print("HXQ Solana — Real SBERT Layer Demo")
    print("=" * 65)

    # 1. Load real SBERT model
    print("\n1. Loading all-MiniLM-L6-v2...")
    from sentence_transformers import SentenceTransformer
    model = SentenceTransformer("all-MiniLM-L6-v2")

    # Extract the word embedding layer (the largest single tensor)
    state_dict = model[0].auto_model.state_dict()

    # Find embedding weight
    embed_key = "embeddings.word_embeddings.weight"
    embed_weight = state_dict[embed_key].cpu().numpy().astype(np.float32)
    print(f"   Layer: {embed_key}")
    print(f"   Shape: {embed_weight.shape} ({embed_weight.shape[0]} tokens x {embed_weight.shape[1]} dim)")
    print(f"   dtype: {embed_weight.dtype}")

    # Flatten for compression (HXQ operates on flat tensors)
    original = embed_weight.flatten()
    original_bytes = original.tobytes()
    original_hash = sha256_bytes(original_bytes)
    print(f"   Total elements: {len(original):,}")
    print(f"   Size: {len(original_bytes):,} bytes ({len(original_bytes)/1024/1024:.2f} MB)")
    print(f"   SHA-256: {original_hash.hex()[:32]}...")

    # Save original
    np.save(out_path / "original_embedding.npy", embed_weight)

    # Also extract a smaller layer for comparison
    attn_key = "embeddings.LayerNorm.weight"
    if attn_key in state_dict:
        ln_weight = state_dict[attn_key].cpu().numpy().astype(np.float32)
        print(f"\n   Also found: {attn_key} ({ln_weight.shape})")

    # 2. Compress with HXQ affine-6
    print(f"\n2. Compressing with HXQ Affine-6 (group_size=128)...")
    compressed_bytes, reconstructed = hxq_compress_affine6(original, group_size=128)
    content_hash = sha256_bytes(compressed_bytes)
    ratio = len(original_bytes) / len(compressed_bytes)
    print(f"   Original:    {len(original_bytes):,} bytes")
    print(f"   Compressed:  {len(compressed_bytes):,} bytes")
    print(f"   Ratio:       {ratio:.1f}x")
    print(f"   SHA-256:     {content_hash.hex()[:32]}...")

    # Save compressed
    with open(out_path / "embedding.hxq", "wb") as f:
        f.write(compressed_bytes)

    # Save reconstructed
    reconstructed_2d = reconstructed.reshape(embed_weight.shape)
    np.save(out_path / "reconstructed_embedding.npy", reconstructed_2d)

    # 3. Fidelity metrics
    print("\n3. Computing fidelity metrics...")
    cos_sim = cosine_similarity(original, reconstructed)
    mse = float(np.mean((original - reconstructed) ** 2))
    max_err = float(np.max(np.abs(original - reconstructed)))
    print(f"   Cosine similarity: {cos_sim:.6f}")
    print(f"   MSE:               {mse:.2e}")
    print(f"   Max absolute err:  {max_err:.6f}")
    print(f"   Gate (Affine6 >= 0.998): {'PASS' if cos_sim >= 0.998 else 'FAIL'}")

    # 4. Functional verification: embeddings still work
    print("\n4. Functional verification (sentence embeddings)...")
    test_sentences = [
        "The quick brown fox jumps over the lazy dog.",
        "Machine learning models can be compressed efficiently.",
        "Blockchain provides immutable provenance records.",
        "The weather is nice today.",
        "Neural network weight quantization preserves semantic meaning.",
    ]

    # Get original embeddings
    orig_embeddings = model.encode(test_sentences, normalize_embeddings=True)

    # Swap in compressed weights and get new embeddings
    compressed_weight_tensor = torch.from_numpy(reconstructed_2d)
    with torch.no_grad():
        orig_param = model[0].auto_model.embeddings.word_embeddings.weight.data.clone()
        model[0].auto_model.embeddings.word_embeddings.weight.data = compressed_weight_tensor

    comp_embeddings = model.encode(test_sentences, normalize_embeddings=True)

    # Restore original
    with torch.no_grad():
        model[0].auto_model.embeddings.word_embeddings.weight.data = orig_param

    # Compare sentence-level embeddings
    print("   Sentence-level cosine similarity (original vs compressed):")
    sentence_cosines = []
    for i, sent in enumerate(test_sentences):
        sc = float(np.dot(orig_embeddings[i], comp_embeddings[i]))
        sentence_cosines.append(sc)
        print(f"   [{i}] {sc:.6f}  \"{sent[:50]}\"")

    mean_sent_cos = np.mean(sentence_cosines)
    min_sent_cos = np.min(sentence_cosines)
    print(f"\n   Mean sentence cosine: {mean_sent_cos:.6f}")
    print(f"   Min sentence cosine:  {min_sent_cos:.6f}")
    print(f"   All >= 0.99:          {'PASS' if min_sent_cos >= 0.99 else 'FAIL'}")

    # 5. Generate register params
    print("\n5. Generating Solana register_asset parameters...")

    metadata = {
        "model": "all-MiniLM-L6-v2",
        "layer": embed_key,
        "shape": list(embed_weight.shape),
        "total_elements": int(len(original)),
        "compression_ratio": round(ratio, 2),
        "cosine_similarity": round(cos_sim, 6),
        "mse": mse,
        "mean_sentence_cosine": round(float(mean_sent_cos), 6),
        "min_sentence_cosine": round(float(min_sent_cos), 6),
        "codec": "affine6",
        "group_size": 128,
        "bits_per_weight": 6,
        "source": "huggingface:sentence-transformers/all-MiniLM-L6-v2",
    }
    metadata_json = json.dumps(metadata, sort_keys=True).encode()
    metadata_hash = sha256_bytes(metadata_json)

    artifact_cid = sha256_bytes(b"ipfs-real-sbert-" + compressed_bytes[:32])

    params = {
        "content_hash": list(content_hash),
        "original_hash": list(original_hash),
        "artifact_type": 0,
        "threshold": 0.998,
        "metadata_hash": list(metadata_hash),
        "codec_id": 0,
        "group_size": 128,
        "bits_per_weight": 6,
        "architecture": 0,
        "cosine_claim": round(cos_sim, 6),
        "ppl_delta_bps": 0,
        "artifact_cid": list(artifact_cid),
    }

    with open(out_path / "register_params.json", "w") as f:
        json.dump(params, f, indent=2)

    with open(out_path / "metadata.json", "w") as f:
        json.dump(metadata, f, indent=2)

    print(f"   content_hash:     {content_hash.hex()[:32]}...")
    print(f"   cosine_claim:     {cos_sim:.6f}")
    print(f"   codec_id:         0 (Affine6)")
    print(f"   Gate result:      {'PASS' if cos_sim >= 0.998 else 'FAIL'}")

    # 6. Save receipt
    print("\n6. Saving receipt...")

    cost = {
        "wall_time_s": round(time.time() - t_start, 3),
        "cpu_time_s": round(time.process_time() - cpu_start, 3),
        "peak_memory_mb": round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024, 1),
        "python_version": platform.python_version(),
        "hostname": platform.node(),
        "timestamp_start": start_iso,
        "timestamp_end": datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%S"),
    }

    receipt = {
        "receipt_id": f"hxq-real-sbert-layer-{datetime.utcnow().strftime('%Y%m%dT%H%M%SZ')}",
        "model": "all-MiniLM-L6-v2",
        "layer": embed_key,
        "shape": list(embed_weight.shape),
        "total_elements": int(len(original)),
        "original_hash": original_hash.hex(),
        "content_hash": content_hash.hex(),
        "metadata_hash": metadata_hash.hex(),
        "original_size_bytes": len(original_bytes),
        "compressed_size_bytes": len(compressed_bytes),
        "compression_ratio": round(ratio, 2),
        "cosine_similarity": round(cos_sim, 6),
        "mse": mse,
        "max_absolute_error": max_err,
        "gate_pass": cos_sim >= 0.998,
        "functional_verification": {
            "test_sentences": len(test_sentences),
            "mean_sentence_cosine": round(float(mean_sent_cos), 6),
            "min_sentence_cosine": round(float(min_sent_cos), 6),
            "all_above_099": bool(min_sent_cos >= 0.99),
        },
        "register_params": params,
        "cost": cost,
    }

    receipt_dir = Path("receipts")
    receipt_dir.mkdir(exist_ok=True)
    receipt_path = receipt_dir / f"real_sbert_layer_{datetime.utcnow().strftime('%Y%m%dT%H%M%SZ')}.json"
    with open(receipt_path, "w") as f:
        json.dump(receipt, f, indent=2)
    print(f"   Receipt: {receipt_path}")

    print(f"\n   Cost: {cost['wall_time_s']}s wall, {cost['cpu_time_s']}s CPU, {cost['peak_memory_mb']} MB peak")

    print("\n" + "=" * 65)
    print("ARTIFACTS READY")
    print("=" * 65)
    print(f"  Params:      {out_path / 'register_params.json'}")
    print(f"  Compressed:  {out_path / 'embedding.hxq'}")
    print(f"  Original:    {out_path / 'original_embedding.npy'}")
    print(f"  Receipt:     {receipt_path}")
    print(f"\n  Next: register on-chain + mint gated token + transfer demo")

    return receipt


if __name__ == "__main__":
    main()
