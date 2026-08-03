#!/usr/bin/env bash
#
# Full wire-level scenario against a containerised quickstart service.
#
# Everything else in this repository exercises the services in-process: the e2e tests
# open a real socket, but client and server share one process, so nothing covers the
# container itself -- the HEALTHCHECK, the production dependency closure with
# devDependencies stripped, or SIGTERM handling as PID 1.
#
# The probes run from the host against the published port and assert response *bodies*
# against the documented contract, not merely that a call did not fail.
#
# Requires: docker, curl, and `buf` on PATH (for `buf curl`).
# Usage: scripts/container-e2e.sh <image> <label>
set -uo pipefail

IMAGE="$1"; LABEL="$2"
NAME="e2e-$LABEL-$$"
PORT="${E2E_PORT:-15000}"
PASS=0; FAIL=0

ok()  { printf '  \033[32mPASS\033[0m %s\n' "$1"; PASS=$((PASS+1)); }
bad() { printf '  \033[31mFAIL\033[0m %s -- %s\n' "$1" "$2"; FAIL=$((FAIL+1)); }

# check <condition-result> <name> <detail-on-failure>
check() { if [ "$1" = "0" ]; then ok "$2"; else bad "$2" "${3-}"; fi; }

# Dump the logs before removing the container, or a CI failure leaves nothing to
# diagnose -- the container is gone by the time any later step runs.
cleanup() {
  if [ "$FAIL" -gt 0 ] && docker inspect "$NAME" >/dev/null 2>&1; then
    echo "  --- last 50 log lines from $NAME"
    docker logs --tail 50 "$NAME" 2>&1 | sed 's/^/  | /'
  fi
  docker rm -f "$NAME" >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "=== $LABEL ($IMAGE) ==="

docker run -d --name "$NAME" -p "$PORT:5000" "$IMAGE" >/dev/null

# 1. the container reaches its own HEALTHCHECK
for _ in $(seq 1 30); do
  st=$(docker inspect -f '{{.State.Health.Status}}' "$NAME" 2>/dev/null)
  [ "$st" = "healthy" ] || [ "$st" = "unhealthy" ] && break
  sleep 2
done
[ "$st" = "healthy" ]; check $? "container healthcheck -> healthy" "status=$st"

# 2. HTTP /healthz over h2c reports SERVING
body=$(curl -fsS --http2-prior-knowledge "http://localhost:$PORT/healthz" 2>/dev/null)
echo "$body" | grep -q '"status":"SERVING"'; check $? "GET /healthz -> SERVING" "body=$body"

# 3. a non-existent path is rejected (proves the probe is not vacuous)
code=$(curl -s -o /dev/null -w '%{http_code}' --http2-prior-knowledge "http://localhost:$PORT/nope")
[ "$code" = "404" ]; check $? "unknown path -> 404" "code=$code"

# 4. gRPC reflection lists the three services
services=$(buf curl --protocol grpc --http2-prior-knowledge --list-methods \
  "http://localhost:$PORT" 2>/dev/null)
# The reflection service does not advertise itself, which is normal; assert the
# services a client would actually look up.
for svc in greeter.v1.GreeterService/SayHello greeter.v1.GreeterService/SayGoodbye grpc.health.v1.Health/Check; do
  echo "$services" | grep -q "$svc"; check $? "reflection lists $svc" "missing from the listing"
done

# 5. a real unary RPC returns the documented payload
reply=$(buf curl --protocol grpc --http2-prior-knowledge -d '{"name":"Ada"}' \
  "http://localhost:$PORT/greeter.v1.GreeterService/SayHello" 2>/dev/null)
echo "$reply" | grep -q 'Hello, Ada!'; check $? 'SayHello -> "Hello, Ada!"' "reply=$reply"

# 6. gRPC health check reports SERVING
health=$(buf curl --protocol grpc --http2-prior-knowledge -d '{}' \
  "http://localhost:$PORT/grpc.health.v1.Health/Check" 2>/dev/null)
echo "$health" | grep -q 'SERVING'; check $? "Health/Check -> SERVING" "reply=$health"

# 7. the second method answers too, so the whole service is wired, not just one route
# (this example declares no proto constraints, so there is no validation path to assert)
bye=$(buf curl --protocol grpc --http2-prior-knowledge -d '{"name":"Ada"}' \
  "http://localhost:$PORT/greeter.v1.GreeterService/SayGoodbye" 2>/dev/null)
echo "$bye" | grep -q 'Goodbye, Ada!'; check $? 'SayGoodbye -> "Goodbye, Ada!"' "reply=$bye"

# 8. SIGTERM as PID 1: graceful shutdown, clean exit code, inside the grace window
start=$(date +%s)
docker stop -t 30 "$NAME" >/dev/null 2>&1
stop_rc=$?
elapsed=$(( $(date +%s) - start ))
status=$(docker inspect -f '{{.State.Status}}' "$NAME" 2>/dev/null)

# `docker inspect` reports ExitCode 0 for a *running* container, so trusting it
# without checking the status would pass even if the container never stopped.
if [ "$stop_rc" != "0" ] || [ "$status" != "exited" ]; then
  bad "SIGTERM -> container exited" "docker stop rc=$stop_rc, status=$status after ${elapsed}s"
  bad "shutdown within the grace window" "container never exited"
else
  exit_code=$(docker inspect -f '{{.State.ExitCode}}' "$NAME" 2>/dev/null)
  [ "$exit_code" = "0" ]
  check $? "SIGTERM -> exit 0 (${elapsed}s)" "exit=$exit_code (137 = SIGKILL, shutdown hung)"
  [ "$elapsed" -lt 15 ]
  check $? "shutdown within the grace window (${elapsed}s)" "took ${elapsed}s"
fi

echo "  --- $LABEL: $PASS passed, $FAIL failed"
exit $((FAIL > 0))
