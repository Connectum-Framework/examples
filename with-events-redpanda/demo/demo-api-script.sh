#!/usr/bin/env bash
# Connectum EventBus + Redpanda: Live Saga Demo
#
# Prerequisites: Order Service (:5001) and Inventory Service (:5002) must be running.
# Run: bash demo/demo-api-script.sh
set -euo pipefail

ORDER_URL="${ORDER_URL:-http://localhost:5001}"
INVENTORY_URL="${INVENTORY_URL:-http://localhost:5002}"

# ── Colors ───────────────────────────────────────────────

CYAN='\033[1;36m'
YELLOW='\033[1;33m'
GREEN='\033[1;32m'
RED='\033[1;31m'
DIM='\033[2m'
MAGENTA='\033[1;35m'
WHITE='\033[1;37m'
RESET='\033[0m'

banner()  { echo -e "\n${CYAN}═══ $1 ═══${RESET}\n"; }
step()    { echo -e "${YELLOW}▸ $1${RESET}"; }
ok()      { echo -e "${GREEN}✓ $1${RESET}"; }
explain() { echo -e "${DIM}  $1${RESET}"; }
flow()    { echo -e "  ${MAGENTA}$1${RESET}"; }

# ── Title ────────────────────────────────────────────────

clear
printf '\n\n'
echo -e "  ${MAGENTA}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
echo ""
echo -e "  ${WHITE}Connectum EventBus + Redpanda: Live Saga Demo${RESET}"
echo ""
echo -e "  ${DIM}Saga choreography pattern with 2 microservices:${RESET}"
echo -e "  ${DIM}Order Service (port 5001) + Inventory Service (port 5002)${RESET}"
echo ""
echo -e "  ${CYAN}Flow: CreateOrder -> OrderCreated event -> InventoryReserved${RESET}"
echo -e "  ${CYAN}      CancelOrder -> OrderCancelled event -> InventoryReleased${RESET}"
echo ""
echo -e "  ${MAGENTA}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
sleep 7

# ── Health Check ─────────────────────────────────────────

clear
banner "Step 1/6: Health Check"
explain "Verify both microservices are running and connected to Redpanda."
echo ""

step "Order Service (port 5001)"
curl -sf "${ORDER_URL}/healthz" > /dev/null && ok "Order Service healthy" || { echo -e "${RED}✗ Order Service not available${RESET}"; exit 1; }

step "Inventory Service (port 5002)"
curl -sf "${INVENTORY_URL}/healthz" > /dev/null && ok "Inventory Service healthy" || { echo -e "${RED}✗ Inventory Service not available${RESET}"; exit 1; }

sleep 5

# ── Create Order: Alice ──────────────────────────────────

clear
banner "Step 2/6: Create Orders"
explain "Calling OrderService.CreateOrder via ConnectRPC (JSON)."
explain "Each order publishes an OrderCreated event to Redpanda."
explain "Inventory Service listens and auto-reserves inventory."
echo ""

step "CreateOrder: Alice - 5x Widget"
echo -e "${DIM}  POST /orders.v1.OrderService/CreateOrder${RESET}"
ALICE_RESPONSE=$(curl -sf -X POST "${ORDER_URL}/orders.v1.OrderService/CreateOrder" \
  -H "Content-Type: application/json" \
  -d '{"product":"Widget","quantity":5,"customer":"Alice"}')
echo "$ALICE_RESPONSE" | jq .
ALICE_ORDER_ID=$(echo "$ALICE_RESPONSE" | jq -r '.orderId')
ok "Alice order created: ${ALICE_ORDER_ID}"
echo ""
flow "Event: OrderCreated -> Redpanda topic 'orders.v1.OrderCreated'"

sleep 6

step "CreateOrder: Bob - 3x Gadget"
echo -e "${DIM}  POST /orders.v1.OrderService/CreateOrder${RESET}"
BOB_RESPONSE=$(curl -sf -X POST "${ORDER_URL}/orders.v1.OrderService/CreateOrder" \
  -H "Content-Type: application/json" \
  -d '{"product":"Gadget","quantity":3,"customer":"Bob"}')
echo "$BOB_RESPONSE" | jq .
BOB_ORDER_ID=$(echo "$BOB_RESPONSE" | jq -r '.orderId')
ok "Bob order created: ${BOB_ORDER_ID}"
echo ""
flow "Event: OrderCreated -> Redpanda topic 'orders.v1.OrderCreated'"

sleep 5

# ── Wait for Saga ────────────────────────────────────────

echo ""
echo -e "${MAGENTA}  ┌─────────────────────────────────────────────────┐${RESET}"
echo -e "${MAGENTA}  │  Saga in progress...                            │${RESET}"
echo -e "${MAGENTA}  │                                                 │${RESET}"
echo -e "${MAGENTA}  │  OrderCreated event  ->  Inventory Service      │${RESET}"
echo -e "${MAGENTA}  │  reserves stock      ->  InventoryReserved      │${RESET}"
echo -e "${MAGENTA}  │  Order Service       <-  confirms order         │${RESET}"
echo -e "${MAGENTA}  │                                                 │${RESET}"
echo -e "${MAGENTA}  └─────────────────────────────────────────────────┘${RESET}"
sleep 6

# ── Verify: Orders Confirmed ─────────────────────────────

clear
banner "Step 3/6: Verify Saga Result"
explain "After saga completes, orders should be 'confirmed'"
explain "and inventory should show 'reserved' for both."
echo ""

step "GetOrders - expect status: confirmed"
curl -sf -X POST "${ORDER_URL}/orders.v1.OrderService/GetOrders" \
  -H "Content-Type: application/json" -d '{}' | jq .

sleep 7

step "GetInventory - both reserved"
curl -sf -X POST "${INVENTORY_URL}/orders.v1.InventoryService/GetInventory" \
  -H "Content-Type: application/json" -d '{}' | jq .

sleep 7

# ── Cancel Alice's Order ─────────────────────────────────

clear
banner "Step 4/6: Cancel Order (Alice)"
explain "CancelOrder publishes OrderCancelled event to custom topic."
explain "Inventory Service listens and releases the reserved stock."
echo ""

step "CancelOrder: Alice (reason: Changed my mind)"
echo -e "${DIM}  POST /orders.v1.OrderService/CancelOrder${RESET}"
curl -sf -X POST "${ORDER_URL}/orders.v1.OrderService/CancelOrder" \
  -H "Content-Type: application/json" \
  -d "{\"orderId\":\"${ALICE_ORDER_ID}\",\"reason\":\"Changed my mind\"}" | jq .
echo ""
flow "Event: OrderCancelled -> Redpanda topic 'orders.cancelled'"

sleep 5

# ── Wait for Event Chain ─────────────────────────────────

echo ""
echo -e "${MAGENTA}  ┌─────────────────────────────────────────────────┐${RESET}"
echo -e "${MAGENTA}  │  Event chain in progress...                     │${RESET}"
echo -e "${MAGENTA}  │                                                 │${RESET}"
echo -e "${MAGENTA}  │  OrderCancelled event  ->  Inventory Service    │${RESET}"
echo -e "${MAGENTA}  │  releases Alice stock  ->  InventoryReleased    │${RESET}"
echo -e "${MAGENTA}  │                                                 │${RESET}"
echo -e "${MAGENTA}  └─────────────────────────────────────────────────┘${RESET}"
sleep 6

# ── Final State ──────────────────────────────────────────

clear
banner "Step 5/6: Verify Final State"
explain "Alice's order should be 'cancelled', inventory 'released'."
explain "Bob's order stays 'confirmed', inventory 'reserved'."
echo ""

step "GetOrders - Alice cancelled, Bob confirmed"
curl -sf -X POST "${ORDER_URL}/orders.v1.OrderService/GetOrders" \
  -H "Content-Type: application/json" -d '{}' | jq .

sleep 7

step "GetInventory - Alice released, Bob reserved"
curl -sf -X POST "${INVENTORY_URL}/orders.v1.InventoryService/GetInventory" \
  -H "Content-Type: application/json" -d '{}' | jq .

sleep 7

# ── Done ─────────────────────────────────────────────────

clear
banner "Step 6/6: Summary"
echo ""
echo -e "  ${GREEN}Saga Choreography Pattern:${RESET}"
echo ""
echo -e "  ${WHITE}1.${RESET} CreateOrder   ${DIM}->  OrderCreated event    ->  InventoryReserved${RESET}"
echo -e "  ${WHITE}2.${RESET} CancelOrder   ${DIM}->  OrderCancelled event  ->  InventoryReleased${RESET}"
echo ""
echo -e "  ${GREEN}Services communicate only through events via Redpanda.${RESET}"
echo -e "  ${GREEN}No direct RPC calls between services.${RESET}"
echo ""
echo -e "  ${CYAN}Powered by: @connectum/events + @connectum/events-kafka${RESET}"
echo ""
echo -e "  ${GREEN}═══════════════════════════════════════════════════${RESET}"
echo -e "  ${GREEN}  Demo complete${RESET}"
echo -e "  ${GREEN}═══════════════════════════════════════════════════${RESET}"
