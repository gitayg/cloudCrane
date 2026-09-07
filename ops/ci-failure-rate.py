#!/usr/bin/env python3
"""Control-band detection for ci_workflow_failure_rate.

Deterministic p-chart over GitHub Actions runs. No model, no judgement.
Prints one JSON object on stdout. Exits non-zero only when the metric could
not be measured at all; a breach and a quiet day are both successful runs.
"""

import json
import math
import subprocess
import sys
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path

BANDS = Path(__file__).resolve().parent / "bands.yaml"
NOW = datetime.now(timezone.utc)
FETCH_LIMIT = 1000


def emit(payload, code):
    payload["metric"] = "ci_workflow_failure_rate"
    payload["measured_at"] = NOW.isoformat()
    sys.stdout.write(json.dumps(payload, sort_keys=True) + "\n")
    sys.exit(code)


def measure_failed(reason, detail=None):
    emit({"state": "MEASURE_FAILED", "reason": reason, "detail": detail, "value": None}, 1)


def cold_start(reason, **extra):
    payload = {"state": "COLD_START", "reason": reason, "value": None}
    payload.update(extra)
    emit(payload, 0)


try:
    import yaml
except ImportError:
    measure_failed("pyyaml_not_installed", "python3 -m pip install pyyaml")

if not BANDS.exists():
    measure_failed("bands_yaml_missing", str(BANDS))

cfg = yaml.safe_load(BANDS.read_text())
src = cfg["source"]
par = cfg["params"]
repo = src["repo"]
fail_set = set(src["failure_conclusions"])
count_set = set(src["counted_conclusions"])

window_end = (NOW - timedelta(days=1)).date()
window_start = window_end - timedelta(days=par["window_days"] - 1)

cmd = [
    "gh", "run", "list", "--repo", repo, "--limit", str(FETCH_LIMIT),
    "--json", "databaseId,conclusion,status,createdAt,workflowName,headBranch",
]
proc = subprocess.run(cmd, capture_output=True, text=True)
if proc.returncode != 0:
    measure_failed("gh_run_list_failed", proc.stderr.strip()[:500])

try:
    runs = json.loads(proc.stdout)
except json.JSONDecodeError:
    measure_failed("gh_output_not_json", proc.stdout.strip()[:500])

if not isinstance(runs, list):
    measure_failed("gh_output_not_a_list", proc.stdout.strip()[:500])

source_info = {
    "command": " ".join(cmd),
    "runs_fetched": len(runs),
    "window_start": window_start.isoformat(),
    "window_end": window_end.isoformat(),
}

if not runs:
    cold_start("no_workflow_runs", source=source_info)

buckets = defaultdict(lambda: {"runs": 0, "failures": 0})
oldest = None
for run in runs:
    created = datetime.fromisoformat(run["createdAt"].replace("Z", "+00:00"))
    day = created.date()
    oldest = day if oldest is None else min(oldest, day)
    if run["status"] != "completed" or run["conclusion"] not in count_set:
        continue
    if not (window_start <= day <= window_end):
        continue
    buckets[day]["runs"] += 1
    if run["conclusion"] in fail_set:
        buckets[day]["failures"] += 1

source_info["window_truncated"] = len(runs) >= FETCH_LIMIT and oldest > window_start

points = []
for day in sorted(buckets):
    b = buckets[day]
    if b["runs"] < par["min_point_runs"]:
        continue
    points.append({
        "date": day.isoformat(),
        "runs": b["runs"],
        "failures": b["failures"],
        "rate": b["failures"] / b["runs"],
    })

if not points:
    cold_start("no_completed_runs_in_window", source=source_info)

series = points[-par["series_points"]:]
baseline = points[:-len(series)]
baseline_runs = sum(p["runs"] for p in baseline)
baseline_failures = sum(p["failures"] for p in baseline)
baseline_info = {
    "days": len(baseline),
    "runs": baseline_runs,
    "failures": baseline_failures,
    "required_days": par["min_baseline_days"],
    "required_runs": par["min_baseline_runs"],
}

if len(baseline) < par["min_baseline_days"]:
    cold_start("insufficient_baseline_days", baseline=baseline_info, source=source_info)
if baseline_runs < par["min_baseline_runs"]:
    cold_start("insufficient_baseline_runs", baseline=baseline_info, source=source_info)

if baseline_failures == 0:
    centre = par["zero_failure_floor"] / baseline_runs
    baseline_info["centre_floored"] = True
else:
    centre = baseline_failures / baseline_runs
    baseline_info["centre_floored"] = False
baseline_info["rate"] = baseline_failures / baseline_runs

for p in series:
    sigma = math.sqrt(centre * (1 - centre) / p["runs"])
    p["sigma"] = sigma
    p["sigma_units"] = (p["rate"] - centre) / sigma

latest = series[-1]
su = [p["sigma_units"] for p in series]

if su[-1] > 3:
    state, rule = "BREACH_3SIGMA", "WE1"
elif su[-1] > 2 and sum(1 for u in su[-3:] if u > 2) >= 2:
    state, rule = "BREACH_2SIGMA", "WE2"
elif su[-1] > 1 and sum(1 for u in su[-5:] if u > 1) >= 4:
    state, rule = "BREACH_1SIGMA", "WE3"
elif len(series) >= 8 and all(p["rate"] > centre for p in series[-8:]):
    state, rule = "BREACH_1SIGMA", "WE4"
else:
    state, rule = "WITHIN_BAND", None

emit({
    "state": state,
    "rule": rule,
    "value": latest["rate"],
    "point": latest,
    "centre": centre,
    "limits": {
        "1sigma": centre + latest["sigma"],
        "2sigma": centre + 2 * latest["sigma"],
        "3sigma": centre + 3 * latest["sigma"],
    },
    "baseline": baseline_info,
    "series": series,
    "source": source_info,
}, 0)
