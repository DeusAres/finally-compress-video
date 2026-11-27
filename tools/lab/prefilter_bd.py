#!/usr/bin/env python3
"""BD-rate (Bjøntegaard, interpolazione cubica di log-rate su VMAF) di ogni variante vs base.
Uso: prefilter_bd.py <csv>...   (csv di prefilter_bd.sh; stampa per clip e media). Colonna: vmaf o vmaf_neg via env METRIC=vmaf_neg."""
import sys, csv, os, numpy as np
M = os.environ.get("METRIC", "vmaf")
def bd(ref, tst):
    (r1, q1), (r2, q2) = ref, tst
    lo, hi = max(min(q1), min(q2)), min(max(q1), max(q2))
    if hi <= lo: return float('nan')
    p1 = np.polyfit(q1, np.log(r1), 3); p2 = np.polyfit(q2, np.log(r2), 3)
    i1, i2 = np.polyint(p1), np.polyint(p2)
    a = (np.polyval(i2, hi) - np.polyval(i2, lo)) - (np.polyval(i1, hi) - np.polyval(i1, lo))
    return (np.exp(a / (hi - lo)) - 1) * 100
res = {}
for f in sys.argv[1:]:
    V = {}
    for r in csv.DictReader(open(f)): V.setdefault(r["var"], []).append((float(r["kbps"]), float(r[M])))
    b = V["base"]; b = (np.array([x for x, _ in b]), np.array([y for _, y in b]))
    for k, p in V.items():
        if k == "base": continue
        res.setdefault(k, []).append(bd(b, (np.array([x for x, _ in p]), np.array([y for _, y in p]))))
    print(os.path.basename(f), {k: round(v[-1], 1) for k, v in res.items()}, "ΔVMAF@base:", {k: [round(y - by, 2) for (_, y), (_, by) in zip(p, V["base"])] for k, p in V.items() if k != "base"})
print(f"media ({M}):", {k: round(float(np.mean(v)), 1) for k, v in res.items()})
