#!/bin/sh
# Samples outbox delivery lag from the worker metrics while a k6 scenario runs.
#
# RECONSTRUCTED: the original script used for k6/results/*-lag.txt was not kept.
# This one reproduces the recorded output format exactly, one line per sample:
#   outbox_backlog 53 outbox_lag_seconds 0.049604
# The recorded files have 7-8 lines per 30 s run, i.e. a sample every ~4 s.
#
# Usage (start right after k6, in another terminal):
#   k6/sample-lag.sh > k6/results/mixed-1m-lag.txt
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
