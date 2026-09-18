#!/bin/sh
# Samples outbox delivery lag from the worker metrics while a k6 scenario runs,
# one line per sample:
#   outbox_backlog 53 outbox_lag_seconds 0.049604
# k6/run-all.sh starts it alongside every scenario.
#
# Usage (standalone, start together with k6):
#   k6/sample-lag.sh > k6/results/mixed-1000000-lag.txt
# Env: METRICS_URL (default http://localhost:9100/metrics), INTERVAL seconds (4),
#      DURATION seconds (30).
set -eu
METRICS_URL=${METRICS_URL:-http://localhost:9100/metrics}
INTERVAL=${INTERVAL:-4}
DURATION=${DURATION:-30}

end=$(( $(date +%s) + DURATION ))
while [ "$(date +%s)" -lt "$end" ]; do
  curl -s "$METRICS_URL" | grep -E '^outbox_(backlog|lag_seconds) ' | tr '\n' ' '
  echo
  sleep "$INTERVAL"
done
