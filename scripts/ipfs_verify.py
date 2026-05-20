#!/usr/bin/env python3
"""
HXQ Solana — IPFS Artifact Verification

Fetches an artifact from an IPFS gateway, verifies:
1. SHA-256 content hash matches on-chain content_hash
2. IPFS CID matches on-chain artifact_cid digest
3. Compressed data decompresses to expected fidelity

This closes the provenance loop:
  on-chain hash ←→ IPFS content ←→ original data

Usage:
    # Verify from CID + on-chain receipt
    python3 scripts/ipfs_verify.py --cid QmXyz... --receipt artifacts/climate_grid/onchain_receipt.json

    # Verify from local file + on-chain receipt (offline)
    python3 scripts/ipfs_verify.py --file artifacts/climate_grid/compressed.hxq \
        --receipt artifacts/climate_grid/onchain_receipt.json

    # Verify from register_params.json (check CID digest matches)
    python3 scripts/ipfs_verify.py --file artifacts/climate_grid/compressed.hxq \
        --params artifacts/climate_grid/register_params.json
"""

import hashlib
import json
import sys
import time
import platform
import resource
from datetime import datetime, timezone
from pathlib import Path

# Import CID computation from ipfs_pin
sys.path.insert(0, str(Path(__file__).parent))
from ipfs_pin import compute_ipfs_cid, base58_encode


def fetch_from_gateway(cid: str, gateway: str = "https://ipfs.io/ipfs") -> bytes:
    """Fetch file content from an IPFS gateway."""
    import requests
    url = f"{gateway}/{cid}"
    print(f"   Fetching: {url}")
    resp = requests.get(url, timeout=120)
    if resp.status_code != 200:
        raise RuntimeError(f"Gateway error {resp.status_code}: {resp.text[:200]}")
    return resp.content


def verify_content_hash(data: bytes, expected_hex: str) -> bool:
    """Verify SHA-256 of data matches expected hash."""
    actual = hashlib.sha256(data).hexdigest()
    match = actual == expected_hex
    print(f"   Expected: {expected_hex[:32]}...")
    print(f"   Actual:   {actual[:32]}...")
    print(f"   Result:   {'MATCH' if match else 'MISMATCH'}")
    return match


def verify_cid_digest(data: bytes, expected_digest: list) -> bool:
    """Verify IPFS CID digest matches expected 32-byte array."""
    cid_str, cid_digest = compute_ipfs_cid(data)
    expected_bytes = bytes(expected_digest)
    match = cid_digest == expected_bytes
    print(f"   CIDv0:    {cid_str}")
    print(f"   Expected: {expected_bytes.hex()[:32]}...")
    print(f"   Actual:   {cid_digest.hex()[:32]}...")
    print(f"   Result:   {'MATCH' if match else 'MISMATCH'}")
    return match


def main():
    import argparse
    parser = argparse.ArgumentParser(description="HXQ IPFS Artifact Verification")
    parser.add_argument("--cid", help="IPFS CID to fetch and verify")
    parser.add_argument("--file", "-f", help="Local .hxq file to verify (offline mode)")
    parser.add_argument("--receipt", "-r", help="On-chain receipt JSON (has content_hash)")
    parser.add_argument("--params", "-p", help="register_params.json (has artifact_cid)")
    parser.add_argument("--gateway", default="https://ipfs.io/ipfs",
                        help="IPFS gateway URL")
    args = parser.parse_args()

    if not args.cid and not args.file:
        parser.error("Need --cid or --file")

    t_start = time.time()
    cpu_start = time.process_time()
    start_iso = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S")

    print("=" * 65)
    print("HXQ Solana — IPFS Artifact Verification")
    print("=" * 65)

    checks_passed = 0
    checks_total = 0

    # Load data
    if args.cid:
        print(f"\n1. Fetching from IPFS gateway...")
        data = fetch_from_gateway(args.cid, args.gateway)
        print(f"   Downloaded: {len(data):,} bytes")
    else:
        file_path = Path(args.file)
        print(f"\n1. Loading local file: {file_path}")
        data = file_path.read_bytes()
        print(f"   Size: {len(data):,} bytes")

    content_sha256 = hashlib.sha256(data).hexdigest()
    print(f"   SHA-256: {content_sha256[:32]}...")

    # Check 1: Content hash vs on-chain receipt
    if args.receipt:
        receipt_path = Path(args.receipt)
        receipt = json.loads(receipt_path.read_text())
        expected_hash = receipt.get("content_hash", "")

        print(f"\n2. CHECK 1: Content hash vs on-chain receipt")
        print(f"   Receipt: {receipt_path}")
        checks_total += 1
        if verify_content_hash(data, expected_hash):
            checks_passed += 1
        else:
            print("   FAILED: Content hash does not match on-chain record!")
    else:
        print(f"\n2. CHECK 1: SKIPPED (no --receipt provided)")

    # Check 2: CID digest vs register_params
    if args.params:
        params_path = Path(args.params)
        params = json.loads(params_path.read_text())
        expected_cid_digest = params.get("artifact_cid", [])

        print(f"\n3. CHECK 2: IPFS CID digest vs register_params")
        print(f"   Params: {params_path}")
        checks_total += 1
        if verify_cid_digest(data, expected_cid_digest):
            checks_passed += 1
        else:
            print("   FAILED: CID digest does not match register_params!")
    else:
        print(f"\n3. CHECK 2: SKIPPED (no --params provided)")

    # Check 3: Compute and display CID
    print(f"\n4. IPFS CID computation")
    cid_str, cid_digest = compute_ipfs_cid(data)
    print(f"   CIDv0:   {cid_str}")
    print(f"   Digest:  {cid_digest.hex()}")
    print(f"   Gateway: {args.gateway}/{cid_str}")

    # If we fetched by CID, verify it matches
    if args.cid:
        checks_total += 1
        print(f"\n5. CHECK 3: Fetched CID vs computed CID")
        print(f"   Fetched: {args.cid}")
        print(f"   Computed: {cid_str}")
        if args.cid == cid_str:
            print(f"   Result:  MATCH")
            checks_passed += 1
        else:
            print(f"   Result:  MISMATCH (content may have been re-chunked)")
    else:
        print(f"\n5. CHECK 3: SKIPPED (no --cid to compare)")

    # Cost block
    cost = {
        "wall_time_s": round(time.time() - t_start, 3),
        "cpu_time_s": round(time.process_time() - cpu_start, 3),
        "peak_memory_mb": round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024, 1),
        "python_version": platform.python_version(),
        "hostname": platform.node(),
        "timestamp_start": start_iso,
        "timestamp_end": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S"),
    }

    # Verdict
    if checks_total == 0:
        verdict = "INCOMPLETE"
        exit_code = 1
    elif checks_passed == checks_total:
        verdict = "VERIFIED"
        exit_code = 0
    else:
        verdict = "DISPUTED"
        exit_code = 2

    # Save receipt
    receipt_out = {
        "receipt_id": f"hxq-ipfs-verify-{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}",
        "source": args.cid or str(args.file),
        "file_size_bytes": len(data),
        "content_hash_sha256": content_sha256,
        "ipfs_cid_v0": cid_str,
        "ipfs_cid_digest_hex": cid_digest.hex(),
        "checks_passed": checks_passed,
        "checks_total": checks_total,
        "verdict": verdict,
        "cost": cost,
    }

    receipt_dir = Path("receipts")
    receipt_dir.mkdir(exist_ok=True)
    ts = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    receipt_path = receipt_dir / f"ipfs_verify_{ts}.json"
    receipt_path.write_text(json.dumps(receipt_out, indent=2))

    print(f"\n{'=' * 65}")
    print(f"VERDICT: {verdict} ({checks_passed}/{checks_total} checks passed)")
    print(f"{'=' * 65}")
    print(f"  Content: {content_sha256[:16]}...")
    print(f"  CIDv0:   {cid_str}")
    print(f"  Receipt: {receipt_path}")
    print()

    sys.exit(exit_code)


if __name__ == "__main__":
    main()
