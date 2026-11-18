"""Dataset loading with integrity checks. The matrix hash recomputed here must equal the manifest written by research/dataset.js before any fit."""
from __future__ import annotations
import gzip, hashlib, io, json, os
import pandas as pd


def load(dataset_dir: str, verify: bool = True):
    with open(os.path.join(dataset_dir, "manifest.json")) as f:
        manifest = json.load(f)
    with open(os.path.join(dataset_dir, "split.json")) as f:
        split = json.load(f)
    raw = gzip.open(os.path.join(dataset_dir, "rows.csv.gz"), "rb").read().decode()
    header, _, body = raw.partition("\n")
    if verify:
        h = hashlib.sha256()
        for line in body.splitlines():
            if line:
                h.update((line + "\n").encode())
        if h.hexdigest() != manifest["matrix_sha256"]:
            raise ValueError("dataset hash does not match its manifest: refusing to use it")
    df = pd.read_csv(io.StringIO(header + "\n" + body))
    return df, manifest, split
