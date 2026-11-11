"""Load the TOML config and give a stable hash of the parts that define a 'variant'."""
from __future__ import annotations

import copy
import hashlib
import json
import tomllib
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_CONFIG = ROOT / "config" / "default.toml"


def load_config(path: str | Path | None = None) -> dict:
    p = Path(path) if path else DEFAULT_CONFIG
    with open(p, "rb") as f:
        return tomllib.load(f)


def variant_hash(cfg: dict) -> str:
    """Hash of everything that changes backtest results. Used to count variants
    and to make sure the holdout is run only with the frozen configuration."""
    keys = ["strategy", "costs", "margin", "contract", "risk", "exchange"]
    sub = {k: cfg.get(k) for k in keys}
    blob = json.dumps(sub, sort_keys=True).encode()
    return hashlib.sha256(blob).hexdigest()[:16]


def with_overrides(cfg: dict, **sections) -> dict:
    """Return a deep copy with section-level overrides, e.g.
    with_overrides(cfg, costs={"cost_multiplier": 2.0})."""
    out = copy.deepcopy(cfg)
    for sec, vals in sections.items():
        out.setdefault(sec, {}).update(vals)
    return out
