"""python -m modellab.validate [--dataset DIR] [--registry DIR]: the validation stage (never reads the final segment)."""
import argparse, json
from . import fit

if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--dataset", default="data/research/dataset-v1")
    ap.add_argument("--registry", default="research/registry")
    a = ap.parse_args()
    print(json.dumps(fit.run_validation(a.dataset, a.registry), indent=1, default=str))
