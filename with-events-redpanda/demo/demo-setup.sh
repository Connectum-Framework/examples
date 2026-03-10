#!/usr/bin/env bash
# Setup infrastructure for demo-api.tape recording.
#
# Starts Redpanda, waits for health, then starts both microservices.
# Run: bash demo/demo-setup.sh
set -euo pipefail

GREEN='\033[1;32m'
YELLOW='\033[1;33m'
RED='\033[1;31m'
RESET='\033[0m'

step()   { echo -e "${YELLOW}▸ $1${RESET}"; }
ok()     { echo -e "${GREEN}✓ $1${RESET}"; }
fail()   { echo -e "${RED}✗ $1${RESET}"; exit 1; }

# ── Cleanup trap ──────────────────────────────────────────

cleanup() {
    echo -e "\n${YELLOW}Cleaning up...${RESET}"
    [ -n "${ORDER_PID:-}" ] && kill "$ORDER_PID" 2>/dev/null || true
    [ -n "${INVENTORY_PID:-}" ] && kill "$INVENTORY_PID" 2>/dev/null || true
    wait 2>/dev/null || true
}
trap cleanup INT TERM

# ── Prerequisites ─────────────────────────────────────────

if [ ! -d "node_modules" ]; then
    fail "Run 'pnpm install' first"
fi
if [ ! -d "gen" ]; then
    fail "Run 'pnpm run build:proto' first"
fi

# ── Start Redpanda ────────────────────────────────────────

step "Starting Redpanda + Console..."
docker compose up -d redpanda console

step "Waiting for Redpanda health check..."
RETRIES=30
until docker compose exec redpanda rpk cluster health 2>/dev/null | grep -qE 'Healthy:.+true'; do
  RETRIES=$((RETRIES - 1))
  if [ "$RETRIES" -le 0 ]; then
    fail "Redpanda did not become healthy in time"
  fi
  sleep 2
done
ok "Redpanda healthy"

# ── Start Microservices ───────────────────────────────────

step "Starting Order Service (port 5001)..."
REDPANDA_BROKERS=localhost:9092 node src/order-service.ts > demo/order-service.log 2>&1 &
ORDER_PID=$!

step "Starting Inventory Service (port 5002)..."
REDPANDA_BROKERS=localhost:9092 node src/inventory-service.ts > demo/inventory-service.log 2>&1 &
INVENTORY_PID=$!

# Wait for services to be ready
step "Waiting for services health check..."
RETRIES=20
until curl -sf http://localhost:5001/healthz > /dev/null 2>&1; do
  RETRIES=$((RETRIES - 1))
  if [ "$RETRIES" -le 0 ]; then
    fail "Order Service did not start"
  fi
  sleep 1
done
ok "Order Service ready"

RETRIES=20
until curl -sf http://localhost:5002/healthz > /dev/null 2>&1; do
  RETRIES=$((RETRIES - 1))
  if [ "$RETRIES" -le 0 ]; then
    fail "Inventory Service did not start"
  fi
  sleep 1
done
ok "Inventory Service ready"

# ── Summary ───────────────────────────────────────────────

echo ""
echo -e "${GREEN}═══ Infrastructure Ready ═══${RESET}"
echo ""
echo "  Order Service PID:     ${ORDER_PID}"
echo "  Inventory Service PID: ${INVENTORY_PID}"
echo "  Redpanda Console:      http://localhost:8080"
echo ""
echo "To record the demo:"
echo "  vhs demo/demo-api.tape"
echo ""
echo "  Logs: demo/order-service.log, demo/inventory-service.log"
echo ""
echo "To cleanup:"
echo "  kill ${ORDER_PID} ${INVENTORY_PID}; docker compose down"
