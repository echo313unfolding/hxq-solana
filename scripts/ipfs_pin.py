#!/usr/bin/env python3
"""
HXQ Solana — IPFS Pin & CID Compute

Computes the deterministic IPFS CIDv0 for a compressed .hxq artifact,
optionally pins it to Pinata, and updates register_params.json with
the real artifact_cid (32-byte SHA-256 digest from the IPFS multihash).

The on-chain artifact_cid field stores the raw SHA-256 digest.
Full CID is reconstructed: CIDv0 = base58btc(0x12 || 0x20 || digest).

Usage:
    # Compute CID only (no pinning)
    python3 scripts/ipfs_pin.py artifacts/climate_grid/compressed.hxq

    # Compute + pin to Pinata
    PINATA_JWT=<your-jwt> python3 scripts/ipfs_pin.py artifacts/climate_grid/compressed.hxq

    # Compute + pin + update register_params.json
    PINATA_JWT=<jwt> python3 scripts/ipfs_pin.py artifacts/climate_grid/compressed.hxq \
        --update-params artifacts/climate_grid/register_params.json

    # Pin a directory of artifacts
    PINATA_JWT=<jwt> python3 scripts/ipfs_pin.py artifacts/climate_grid/ --pin-dir
"""

import hashlib
import json
import os
import struct
import sys
import time
import platform
import resource
from datetime import datetime, timezone
from pathlib import Path

# IPFS chunk size (256 KiB) — files under this are single-chunk
IPFS_CHUNK_SIZE = 262144

# Base58 alphabet (Bitcoin/IPFS)
B58_ALPHABET = b"123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"


def base58_encode(data: bytes) -> str:
    """Encode bytes to base58btc (Bitcoin alphabet)."""
    n = int.from_bytes(data, "big")
    result = []
    while n > 0:
        n, r = divmod(n, 58)
        result.append(B58_ALPHABET[r:r+1])
    # Preserve leading zero bytes
    for byte in data:
        if byte == 0:
            result.append(B58_ALPHABET[0:1])
        else:
            break
    return b"".join(reversed(result)).decode("ascii")


def encode_varint(value: int) -> bytes:
    """Encode an unsigned integer as a protobuf varint."""
    result = []
    while value > 0x7F:
        result.append((value & 0x7F) | 0x80)
        value >>= 7
    result.append(value & 0x7F)
    return bytes(result)


def encode_protobuf_field(field_number: int, wire_type: int, value) -> bytes:
    """Encode a single protobuf field."""
    tag = encode_varint((field_number << 3) | wire_type)
    if wire_type == 0:  # varint
        return tag + encode_varint(value)
    elif wire_type == 2:  # length-delimited
        data = value if isinstance(value, bytes) else value.encode()
        return tag + encode_varint(len(data)) + data
    raise ValueError(f"Unsupported wire_type: {wire_type}")


def build_unixfs_file(data: bytes) -> bytes:
    """
    Build a UnixFS File protobuf message.

    message Data {
        enum DataType { Raw = 0; Directory = 1; File = 2; ... }
        required DataType Type = 1;
        optional bytes Data = 2;
        optional uint64 filesize = 3;
    }
    """
    msg = b""
    msg += encode_protobuf_field(1, 0, 2)        # Type = File (2)
    msg += encode_protobuf_field(2, 2, data)      # Data = raw bytes
    msg += encode_protobuf_field(3, 0, len(data)) # filesize
    return msg


def build_dagpb_node(data: bytes, links: list = None) -> bytes:
    """
    Build a dag-pb PBNode protobuf message.

    message PBNode {
        repeated PBLink Links = 2;
        optional bytes Data = 1;
    }

    message PBLink {
        optional bytes Hash = 1;
        optional string Name = 2;
        optional uint64 Tsize = 3;
    }
    """
    msg = b""
    if links:
        for link_hash, link_name, link_tsize in links:
            link_msg = b""
            link_msg += encode_protobuf_field(1, 2, link_hash)   # Hash (multihash)
            if link_name is not None:
                link_msg += encode_protobuf_field(2, 2, link_name.encode() if isinstance(link_name, str) else link_name)
            link_msg += encode_protobuf_field(3, 0, link_tsize)  # Tsize
            msg += encode_protobuf_field(2, 2, link_msg)         # PBLink as field 2
    msg += encode_protobuf_field(1, 2, data)  # Data field
    return msg


def compute_single_chunk_cid(data: bytes) -> tuple:
    """
    Compute IPFS CIDv0 for a single-chunk file (<= 256 KiB).

    Returns (cid_string, sha256_digest_bytes).
    """
    unixfs = build_unixfs_file(data)
    dagpb = build_dagpb_node(unixfs)
    digest = hashlib.sha256(dagpb).digest()
    multihash = b"\x12\x20" + digest  # sha2-256, 32 bytes
    cid_v0 = base58_encode(multihash)
    return cid_v0, digest


def compute_chunked_cid(data: bytes, chunk_size: int = IPFS_CHUNK_SIZE) -> tuple:
    """
    Compute IPFS CIDv0 for a multi-chunk file (> 256 KiB).

    Splits into fixed-size chunks, builds a merkle DAG, returns root CID.
    Returns (cid_string, sha256_digest_bytes).
    """
    chunks = []
    for i in range(0, len(data), chunk_size):
        chunks.append(data[i:i+chunk_size])

    if len(chunks) == 1:
        return compute_single_chunk_cid(data)

    # Build leaf nodes
    links = []
    for chunk in chunks:
        leaf_unixfs = build_unixfs_file(chunk)
        leaf_dagpb = build_dagpb_node(leaf_unixfs)
        leaf_digest = hashlib.sha256(leaf_dagpb).digest()
        leaf_multihash = b"\x12\x20" + leaf_digest
        links.append((leaf_multihash, None, len(leaf_dagpb)))

    # Build root node with UnixFS wrapper (no inline data, just blocksizes)
    # Root UnixFS: Type=File, filesize=total, blocksizes=[chunk_lens]
    root_unixfs = b""
    root_unixfs += encode_protobuf_field(1, 0, 2)              # Type = File
    root_unixfs += encode_protobuf_field(3, 0, len(data))      # filesize = total
    for chunk in chunks:
        root_unixfs += encode_protobuf_field(4, 0, len(chunk)) # blocksizes

    root_dagpb = build_dagpb_node(root_unixfs, links)
    root_digest = hashlib.sha256(root_dagpb).digest()
    root_multihash = b"\x12\x20" + root_digest
    root_cid = base58_encode(root_multihash)
    return root_cid, root_digest


def compute_ipfs_cid(data: bytes) -> tuple:
    """
    Compute IPFS CIDv0 for arbitrary-size file data.

    Returns (cid_string, sha256_digest_32bytes).
    """
    if len(data) <= IPFS_CHUNK_SIZE:
        return compute_single_chunk_cid(data)
    else:
        return compute_chunked_cid(data)


def pin_to_pinata(file_path: str, jwt: str, name: str = None) -> dict:
    """
    Pin a file to Pinata via their REST API.

    Returns the API response dict with IpfsHash, PinSize, Timestamp.
    """
    import requests

    url = "https://api.pinata.cloud/pinning/pinFileToIPFS"
    headers = {"Authorization": f"Bearer {jwt}"}

    metadata = {}
    if name:
        metadata["name"] = name

    with open(file_path, "rb") as f:
        files = {"file": (Path(file_path).name, f)}
        data = {}
        if metadata:
            data["pinataMetadata"] = json.dumps(metadata)

        resp = requests.post(url, headers=headers, files=files, data=data, timeout=60)

    if resp.status_code != 200:
        raise RuntimeError(f"Pinata API error {resp.status_code}: {resp.text}")

    return resp.json()


def main():
    import argparse
    parser = argparse.ArgumentParser(description="HXQ IPFS Pin & CID Compute")
    parser.add_argument("path", help="Path to .hxq file (or directory with --pin-dir)")
    parser.add_argument("--update-params", "-u", help="Path to register_params.json to update")
    parser.add_argument("--pin-dir", action="store_true", help="Pin entire directory")
    parser.add_argument("--name", help="Pinata pin name (default: filename)")
    parser.add_argument("--gateway", default="https://gateway.pinata.cloud/ipfs",
                        help="IPFS gateway URL for verification")
    args = parser.parse_args()

    t_start = time.time()
    cpu_start = time.process_time()
    start_iso = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S")

    jwt = os.environ.get("PINATA_JWT")

    print("=" * 65)
    print("HXQ Solana — IPFS Pin & CID Compute")
    print("=" * 65)

    file_path = Path(args.path)
    if not file_path.exists():
        print(f"ERROR: {file_path} does not exist")
        sys.exit(1)

    # Read file
    data = file_path.read_bytes()
    content_hash = hashlib.sha256(data).hexdigest()
    print(f"\n1. File: {file_path}")
    print(f"   Size: {len(data):,} bytes ({len(data)/1024:.1f} KiB)")
    print(f"   SHA-256 (content): {content_hash[:32]}...")
    print(f"   Chunks needed: {'single' if len(data) <= IPFS_CHUNK_SIZE else f'{(len(data) + IPFS_CHUNK_SIZE - 1) // IPFS_CHUNK_SIZE}'}")

    # Compute CID
    print(f"\n2. Computing IPFS CIDv0...")
    cid_str, cid_digest = compute_ipfs_cid(data)
    print(f"   CIDv0: {cid_str}")
    print(f"   CID digest (32 bytes): {cid_digest.hex()[:32]}...")
    print(f"   Gateway: {args.gateway}/{cid_str}")

    # Pin to Pinata
    pinata_response = None
    if jwt:
        print(f"\n3. Pinning to Pinata...")
        pin_name = args.name or file_path.name
        try:
            pinata_response = pin_to_pinata(str(file_path), jwt, name=pin_name)
            pinata_cid = pinata_response.get("IpfsHash", "")
            pin_size = pinata_response.get("PinSize", 0)
            print(f"   Pinata CID: {pinata_cid}")
            print(f"   Pin size: {pin_size:,} bytes")
            print(f"   Timestamp: {pinata_response.get('Timestamp', '')}")

            # Verify CID match
            if pinata_cid == cid_str:
                print(f"   CID MATCH: local computation matches Pinata")
            else:
                print(f"   WARNING: CID mismatch!")
                print(f"     Local:  {cid_str}")
                print(f"     Pinata: {pinata_cid}")
                print(f"   (This can happen with chunking differences. Pinata CID is authoritative.)")
                cid_str = pinata_cid
                # Recompute digest from Pinata CID if needed
        except Exception as e:
            print(f"   ERROR: {e}")
            print(f"   Continuing with locally computed CID")
    else:
        print(f"\n3. Pinning: SKIPPED (set PINATA_JWT to enable)")
        print(f"   To pin: PINATA_JWT=<your-jwt> python3 {sys.argv[0]} {args.path}")

    # Update register_params.json
    if args.update_params:
        print(f"\n4. Updating {args.update_params}...")
        params_path = Path(args.update_params)
        if params_path.exists():
            params = json.loads(params_path.read_text())
            params["artifact_cid"] = list(cid_digest)
            params_path.write_text(json.dumps(params, indent=2))
            print(f"   artifact_cid updated to IPFS CID digest")
            print(f"   CIDv0: {cid_str}")
        else:
            print(f"   ERROR: {params_path} not found")
    else:
        print(f"\n4. Params update: SKIPPED (use --update-params <path> to enable)")

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

    # Save receipt
    receipt = {
        "receipt_id": f"hxq-ipfs-pin-{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}",
        "file": str(file_path),
        "file_size_bytes": len(data),
        "content_hash_sha256": content_hash,
        "ipfs_cid_v0": cid_str,
        "ipfs_cid_digest_hex": cid_digest.hex(),
        "ipfs_cid_digest": list(cid_digest),
        "gateway_url": f"{args.gateway}/{cid_str}",
        "pinned": pinata_response is not None,
        "pinata_response": pinata_response,
        "cost": cost,
    }

    receipt_dir = Path("receipts")
    receipt_dir.mkdir(exist_ok=True)
    ts = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    receipt_path = receipt_dir / f"ipfs_pin_{ts}.json"
    receipt_path.write_text(json.dumps(receipt, indent=2))
    print(f"\n5. Receipt: {receipt_path}")

    print(f"\n{'=' * 65}")
    print(f"IPFS CID COMPUTED" + (" + PINNED" if pinata_response else ""))
    print(f"{'=' * 65}")
    print(f"  File:        {file_path.name} ({len(data):,} bytes)")
    print(f"  CIDv0:       {cid_str}")
    print(f"  Digest:      {cid_digest.hex()[:16]}...")
    print(f"  Gateway:     {args.gateway}/{cid_str}")
    print(f"  Pinned:      {'YES (Pinata)' if pinata_response else 'NO (dry run)'}")
    if args.update_params:
        print(f"  Params:      {args.update_params} (updated)")
    print()

    return receipt


if __name__ == "__main__":
    main()
