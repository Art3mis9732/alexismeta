"""python -m modellab.score_final [--dataset DIR] [--registry DIR]: the ONE-TIME final scoring (research-prereg-v1). Not run by the loop."""
import argparse, json
from . import final

if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--dataset", default="data/research/dataset-v1")
    ap.add_argument("--registry", default="research/registry")
    a = ap.parse_args()
    r = final.score_final(a.dataset, a.registry)
    print(json.dumps({k: r.get(k) for k in ("verdict", "trades", "mean_R", "ci", "criteria", "random_matched", "by_coin", "halves", "mean_R_costs_plus_25pct")}, indent=1, default=str))
