#!/usr/bin/env bash
# Runner script for VHS walkthrough tape.
# Executes all scenes sequentially with pauses for GIF recording.
# Run: bash demo/demo-walkthrough-runner.sh (after sourcing demo-scenes.sh)
set -euo pipefail

source demo/demo-scenes.sh
export PS1='$ '

# Scene 1: Title
scene_title
sleep 3

# Scene 2: Project Structure
clear
header 'Project Structure'
tree -I 'node_modules|gen|screenshots|demo' --dirsfirst -L 2
sleep 4

# Scene 3: Proto - Event Messages
clear
header 'Proto - Event Messages (OrderCreated, OrderCancelled, InventoryReserved)'
show proto/orders/v1/orders.proto 1:25
sleep 5

# Scene 4: Proto - Services and Event Handlers
clear
header 'Proto - Services and Event Handlers with Custom Topics'
show proto/orders/v1/orders.proto 56:
sleep 5

# Scene 5: EventBus Configuration
clear
header 'EventBus Configuration - KafkaAdapter + Redpanda'
show src/orderEventBus.ts
echo ''
show src/inventoryEventBus.ts
sleep 5

# Scene 6: Order Service Entry Point
clear
header 'Order Service - createServer with EventBus'
show src/order-service.ts
sleep 5

# Scene 7: RPC Handlers
clear
header 'RPC Handlers - CreateOrder publishes events, CancelOrder with custom topic'
show src/services/orderService.ts 17:
sleep 5

# Scene 8: Event Handlers - Saga Choreography
clear
header 'Event Handlers - Saga Choreography (Inventory Service)'
show src/services/inventoryEvents.ts
sleep 5

# Scene 9: Docker Compose
clear
header 'Docker Compose - Redpanda + Console + 2 Services'
show docker-compose.yml 1:45
sleep 4

# Scene 10: Quick Start
scene_quickstart
sleep 4
