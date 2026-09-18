#!/bin/sh
# Runs the write, read and mixed k6 scenarios one after another against a running
# stack and stores everything a run needs to be read later:
#
#   k6/results/<scenario>-<players>.json      k6 summary (--summary-export)
#   k6/results/<scenario>-<players>.txt       run parameters, then the k6 console output
#   k6/results/<scenario>-<players>-lag.txt   outbox backlog and lag sampled during the run
#
# Prerequisites: API and worker are up, and the season is seeded with at least
# PLAYERS players (npm run seed -- --players N).
#
# Usage:  PLAYERS=1000000 k6/run-all.sh
# Env (defaults in brackets):
#   PLAYERS      player id range p000000001…, must not exceed the seeded count [100000]
#   DURATION     length of each scenario, k6 format: 30s, 2m                  [30s]
#   WRITE_RATE   writes/s in write.js and mixed.js (mixed reads: 5x on top and rank) [1000]
#   READ_RATE    reads/s in read.js, split evenly between top and rank          [10000]
#   MAX_VUS      VU cap per scenario; empty = each script's own default         []
#   BASE_URL     API as seen from the k6 container; comma-separate several instances
#                                                     [http://host.docker.internal:3000]
#   METRICS_URL  worker metrics as seen from this host [http://localhost:9100/metrics]
#   K6_IMAGE     [grafana/k6:0.54.0]
set -eu

cd "$(dirname "$0")/.."

PLAYERS=${PLAYERS:-100000}
DURATION=${DURATION:-30s}
WRITE_RATE=${WRITE_RATE:-1000}
READ_RATE=${READ_RATE:-10000}
MAX_VUS=${MAX_VUS:-}
BASE_URL=${BASE_URL:-http://host.docker.internal:3000}
METRICS_URL=${METRICS_URL:-http://localhost:9100/metrics}
K6_IMAGE=${K6_IMAGE:-grafana/k6:0.54.0}

# Scenario length in seconds for the lag sampler (accepts 45s, 2m, 1m30s).
seconds() {
  echo "$1" | awk '{
    s = 0; n = ""
    for (i = 1; i <= length($0); i++) {
      c = substr($0, i, 1)
      if (c ~ /[0-9]/) n = n c
      else if (c == "h") { s += n * 3600; n = "" }
      else if (c == "m") { s += n * 60; n = "" }
      else if (c == "s") { s += n; n = "" }
    }
    print s + n
  }'
}
DURATION_S=$(seconds "$DURATION")
if [ "$DURATION_S" -le 0 ]; then
  echo "cannot parse DURATION=$DURATION" >&2
  exit 1
fi

mkdir -p k6/results

run() {
  scenario=$1
  rate_var=$2   # the variable name the scenario script reads
  rate=$3
  name="$scenario-$PLAYERS"
  txt="k6/results/$name.txt"

  {
    echo "# scenario:      $scenario (k6/$scenario.js)"
    echo "# started (UTC): $(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "# git commit:    $(git rev-parse --short HEAD 2>/dev/null || echo unknown)$(git diff --quiet 2>/dev/null || echo ' (dirty)')"
    echo "# PLAYERS=$PLAYERS DURATION=$DURATION $rate_var=$rate MAX_VUS=${MAX_VUS:-script default}"
    echo "# BASE_URL=$BASE_URL METRICS_URL=$METRICS_URL K6_IMAGE=$K6_IMAGE"
    echo "# host:          $(uname -srm)"
    echo "# docker VM:     $(docker info --format 'NCPU={{.NCPU}} MemTotal={{.MemTotal}} Server={{.ServerVersion}}' 2>/dev/null || echo unknown)"
    echo "#"
  } > "$txt"

  METRICS_URL=$METRICS_URL DURATION=$DURATION_S INTERVAL=4 \
    k6/sample-lag.sh > "k6/results/$name-lag.txt" &
  lag_pid=$!

  # k6 exits non-zero when a threshold fails; keep going so every scenario is recorded.
  status=0
  docker run --rm -i --add-host=host.docker.internal:host-gateway -v ./k6:/scripts \
    -e BASE_URL="$BASE_URL" -e PLAYERS="$PLAYERS" -e DURATION="$DURATION" \
    -e "$rate_var=$rate" ${MAX_VUS:+-e MAX_VUS="$MAX_VUS"} \
    "$K6_IMAGE" run --summary-export="/scripts/results/$name.json" "/scripts/$scenario.js" \
    >> "$txt" 2>&1 || status=$?

  wait "$lag_pid" || true
  echo "$scenario: k6 exit code $status -> $txt"
}

run write RATE "$WRITE_RATE"
run read RATE "$READ_RATE"
run mixed WRITE_RATE "$WRITE_RATE"
