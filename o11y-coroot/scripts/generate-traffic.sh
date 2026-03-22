#!/usr/bin/env bash
# generate-traffic.sh — Generate RPC traffic to o11y-coroot microservices
#
# Sends ConnectRPC (application/json) requests to order-service and
# inventory-service to produce traces, metrics and logs visible in Coroot.
#
# Usage:
#   ./scripts/generate-traffic.sh              # default: 50 iterations
#   ./scripts/generate-traffic.sh 100          # custom iteration count
#   DELAY=0.2 ./scripts/generate-traffic.sh    # faster requests

set -euo pipefail

ORDER_HOST="${ORDER_HOST:-http://localhost:5000}"
INVENTORY_HOST="${INVENTORY_HOST:-http://localhost:5001}"
ITERATIONS="${1:-50}"
DELAY="${DELAY:-0.5}"

GREEN='\033[0;32m'
CYAN='\033[0;36m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo -e "${CYAN}╔══════════════════════════════════════════════════════════╗${NC}"
echo -e "${CYAN}║  O11y Traffic Generator — Coroot Observability Demo     ║${NC}"
echo -e "${CYAN}╠══════════════════════════════════════════════════════════╣${NC}"
echo -e "${CYAN}║  Order Service:     ${ORDER_HOST}${NC}"
echo -e "${CYAN}║  Inventory Service: ${INVENTORY_HOST}${NC}"
echo -e "${CYAN}║  Iterations:        ${ITERATIONS}${NC}"
echo -e "${CYAN}║  Delay:             ${DELAY}s${NC}"
echo -e "${CYAN}╚══════════════════════════════════════════════════════════╝${NC}"
echo

# ── Phase 1: Health checks ──────────────────────────────────────────────────
echo -e "${YELLOW}[Phase 1] Health checks${NC}"

echo -n "  order-service:     "
if curl -sf "${ORDER_HOST}/healthz" > /dev/null 2>&1; then
    echo -e "${GREEN}OK${NC}"
else
    echo "FAIL — is order-service running on ${ORDER_HOST}?"
    exit 1
fi

echo -n "  inventory-service: "
if curl -sf "${INVENTORY_HOST}/healthz" > /dev/null 2>&1; then
    echo -e "${GREEN}OK${NC}"
else
    echo "FAIL — is inventory-service running on ${INVENTORY_HOST}?"
    exit 1
fi
echo

# ── Phase 2: Smoke test — single request per service ────────────────────────
echo -e "${YELLOW}[Phase 2] Smoke test${NC}"

echo -n "  CreateOrder:  "
RESPONSE=$(curl -sf -X POST "${ORDER_HOST}/orders.v1.OrderService/CreateOrder" \
    -H "Content-Type: application/json" \
    -d '{"items": [{"productId": "widget-1", "quantity": 2}]}')
echo -e "${GREEN}${RESPONSE}${NC}"

echo -n "  GetInventory: "
RESPONSE=$(curl -sf -X POST "${INVENTORY_HOST}/orders.v1.InventoryService/GetInventory" \
    -H "Content-Type: application/json" \
    -d '{}')
echo -e "${GREEN}${RESPONSE}${NC}"

echo -n "  CheckStock:   "
RESPONSE=$(curl -sf -X POST "${INVENTORY_HOST}/orders.v1.InventoryService/CheckStock" \
    -H "Content-Type: application/json" \
    -d '{"productId": "widget-1", "quantity": 5}')
echo -e "${GREEN}${RESPONSE}${NC}"

echo -n "  GetOrders:    "
RESPONSE=$(curl -sf -X POST "${ORDER_HOST}/orders.v1.OrderService/GetOrders" \
    -H "Content-Type: application/json" \
    -d '{}')
echo -e "${GREEN}${RESPONSE}${NC}"
echo

# ── Phase 3: Bulk traffic ───────────────────────────────────────────────────
echo -e "${YELLOW}[Phase 3] Generating bulk traffic (${ITERATIONS} iterations)${NC}"

PRODUCTS=("widget-1" "widget-2" "gadget-1" "gadget-2" "gizmo-1")
ERRORS=0
SUCCESS=0

for i in $(seq 1 "${ITERATIONS}"); do
    PRODUCT="${PRODUCTS[$((RANDOM % ${#PRODUCTS[@]}))]}"
    QUANTITY=$(( (RANDOM % 10) + 1 ))

    # CreateOrder (internally calls inventory-service.CheckStock for distributed traces)
    if curl -sf -X POST "${ORDER_HOST}/orders.v1.OrderService/CreateOrder" \
        -H "Content-Type: application/json" \
        -d "{\"items\": [{\"productId\": \"${PRODUCT}\", \"quantity\": ${QUANTITY}}]}" \
        > /dev/null 2>&1; then
        SUCCESS=$((SUCCESS + 1))
    else
        ERRORS=$((ERRORS + 1))
    fi

    # Direct CheckStock (every 3rd request — additional standalone traces)
    if (( i % 3 == 0 )); then
        curl -sf -X POST "${INVENTORY_HOST}/orders.v1.InventoryService/CheckStock" \
            -H "Content-Type: application/json" \
            -d "{\"productId\": \"${PRODUCT}\", \"quantity\": ${QUANTITY}}" \
            > /dev/null 2>&1 || true
    fi

    # GetInventory (every 5th request)
    if (( i % 5 == 0 )); then
        curl -sf -X POST "${INVENTORY_HOST}/orders.v1.InventoryService/GetInventory" \
            -H "Content-Type: application/json" \
            -d '{}' > /dev/null 2>&1 || true
    fi

    # GetOrders (every 10th request)
    if (( i % 10 == 0 )); then
        curl -sf -X POST "${ORDER_HOST}/orders.v1.OrderService/GetOrders" \
            -H "Content-Type: application/json" \
            -d '{}' > /dev/null 2>&1 || true
    fi

    # Progress indicator
    if (( i % 10 == 0 )); then
        echo -e "  ${GREEN}[${i}/${ITERATIONS}]${NC} sent — success: ${SUCCESS}, errors: ${ERRORS}"
    fi

    sleep "${DELAY}"
done

echo
echo -e "${CYAN}╔══════════════════════════════════════════════════════════╗${NC}"
echo -e "${CYAN}║  Traffic generation complete                            ║${NC}"
echo -e "${CYAN}╠══════════════════════════════════════════════════════════╣${NC}"
echo -e "${CYAN}║  Total requests: ~$((SUCCESS + ERRORS + ITERATIONS / 3 + ITERATIONS / 5 + ITERATIONS / 10))${NC}"
echo -e "${CYAN}║  CreateOrder:    ${SUCCESS} success / ${ERRORS} errors     ${NC}"
echo -e "${CYAN}║  (each CreateOrder also calls CheckStock internally)    ║${NC}"
echo -e "${CYAN}║                                                        ║${NC}"
echo -e "${CYAN}║  Open Coroot UI: http://localhost:8080                  ║${NC}"
echo -e "${CYAN}║  Check: Service Map → Traces → Metrics → Logs          ║${NC}"
echo -e "${CYAN}╚══════════════════════════════════════════════════════════╝${NC}"
