# EventBus + RabbitMQ: 2 Microservices with Saga Pattern

A bidirectional event-driven communication example between microservices using RabbitMQ (AMQP 0-9-1) as the message broker, with a Management UI for monitoring exchanges, queues, and messages.

## Architecture

```mermaid
graph TB
    subgraph RabbitMQ["RabbitMQ (AMQP, exchange: orders) :5672 + Management :15672"]
        T1["orders.v1.OrderCreated"]
        T2["orders.cancelled"]
        T3["inventory.reserved"]
    end

    subgraph OS["Order Service :5001"]
        OS_RPC["RPCs: CreateOrder, CancelOrder, GetOrders"]
        OS_EVT["Event: OnInventoryReserved"]
    end

    subgraph IS["Inventory Service :5002"]
        IS_RPC["RPC: GetInventory"]
        IS_EVT["Events: OnOrderCreated, OnOrderCancelled"]
    end

    User -->|CreateOrder / CancelOrder| OS_RPC
    User -->|GetInventory| IS_RPC

    OS_RPC -->|publish| T1
    OS_RPC -->|publish| T2
    T1 -->|subscribe: inventory-service group| IS_EVT
    T2 -->|subscribe: inventory-service group| IS_EVT
    IS_EVT -->|publish| T3
    T3 -->|subscribe: order-service group| OS_EVT
```

### Saga Flow

```mermaid
sequenceDiagram
    actor User
    participant OS as Order Service
    participant RMQ as RabbitMQ
    participant IS as Inventory Service

    User->>OS: CreateOrder RPC
    OS->>RMQ: publish OrderCreated
    OS-->>User: {status: "pending"}
    RMQ->>IS: deliver OrderCreated
    IS->>IS: reserve stock
    IS->>RMQ: publish InventoryReserved (topic: inventory.reserved)
    RMQ->>OS: deliver InventoryReserved
    OS->>OS: order status → "confirmed"

    User->>OS: CancelOrder RPC
    OS->>RMQ: publish OrderCancelled (topic: orders.cancelled)
    OS-->>User: {status: "cancelled"}
    RMQ->>IS: deliver OrderCancelled
    IS->>IS: release stock → "released"
```

## Quick Start

### Prerequisites

- Node.js >= 25.2.0
- Docker + Docker Compose
- pnpm >= 10

### Running

```bash
# 1. Install dependencies
pnpm install

# 2. Generate protobuf code
pnpm run build:proto

# 3. Start RabbitMQ
docker compose up -d rabbitmq

# 4. Start microservices (in separate terminals)
AMQP_URL=amqp://localhost:5672 pnpm run start:order      # port 5001
AMQP_URL=amqp://localhost:5672 pnpm run start:inventory   # port 5002
```

RabbitMQ Management UI is available at **http://localhost:15672** (guest/guest)

### Testing

```bash
# Create an order
curl -X POST http://localhost:5001/orders.v1.OrderService/CreateOrder \
  -H "Content-Type: application/json" \
  -d '{"product":"Widget","quantity":5,"customer":"Alice"}'

# Check status (after 2-3 seconds — "confirmed")
curl -X POST http://localhost:5001/orders.v1.OrderService/GetOrders \
  -H "Content-Type: application/json" -d '{}'

# Check reservations
curl -X POST http://localhost:5002/orders.v1.InventoryService/GetInventory \
  -H "Content-Type: application/json" -d '{}'

# Cancel an order
curl -X POST http://localhost:5001/orders.v1.OrderService/CancelOrder \
  -H "Content-Type: application/json" \
  -d '{"orderId":"<ORDER_ID>","reason":"Changed my mind"}'
```

### Stopping

```bash
docker compose down
```

---

## Step-by-Step Walkthrough

### Step 1. RabbitMQ Management UI — Overview

After running `docker compose up -d`, open http://localhost:15672 and log in with guest/guest. The Overview tab shows node status, message rates, and connection counts.

![RabbitMQ Overview](screenshots/screenshot-overview.png)

### Step 2. Creating Orders

Send two orders:

```bash
curl -X POST http://localhost:5001/orders.v1.OrderService/CreateOrder \
  -H "Content-Type: application/json" \
  -d '{"product":"Widget","quantity":5,"customer":"Alice"}'
# → {"orderId":"b27ea322-...","status":"pending"}

curl -X POST http://localhost:5001/orders.v1.OrderService/CreateOrder \
  -H "Content-Type: application/json" \
  -d '{"product":"Gadget","quantity":3,"customer":"Bob"}'
# → {"orderId":"a959035d-...","status":"pending"}
```

### Step 3. Exchanges — Topic Exchange

In the RabbitMQ Management UI under the Exchanges tab, the `orders` topic exchange is visible. All event messages are routed through this exchange using routing keys matching topic names.

![Exchanges](screenshots/screenshot-exchanges.png)

### Step 4. Queues — Order and Inventory

The Queues tab shows durable queues created by the adapter, one per consumer group (each queue is bound to all of that group's topic routing keys). Each queue is named `${exchange}.${group}` (here the exchange is `orders`):

| Queue | Bound Routing Keys | Consumer Group |
|-------|--------------------|----------------|
| `orders.order-service` | `inventory.reserved` | order-service |
| `orders.inventory-service` | `orders.v1.OrderCreated`, `orders.cancelled` | inventory-service |

![Queues](screenshots/screenshot-queues.png)

### Step 5. Queue Bindings — Routing Keys

Expanding a queue shows its bindings to the `orders` exchange with specific routing keys matching event topic names.

![Queue Bindings](screenshots/screenshot-queue-bindings.png)

### Step 6. Messages in Queue

The "Get messages" feature on a queue shows the protobuf binary payloads that have been delivered.

![Messages](screenshots/screenshot-messages.png)

### Step 7. Message Detail — Headers and Payload

Expanding a message shows:
- **Properties**: delivery_mode=2 (persistent), content_type, headers
- **Payload**: protobuf binary (orderId, product, quantity, customer)

![Message Detail](screenshots/screenshot-message-detail.png)

### Step 8. Message Headers — Metadata

Each message includes service headers added by `AmqpAdapter`:

| Header | Value | Description |
|--------|-------|-------------|
| `x-event-id` | UUID | Unique event identifier |
| `x-published-at` | ISO 8601 | Publish timestamp |

![Message Headers](screenshots/screenshot-message-headers.png)

### Step 9. Verifying the Saga — Orders Confirmed

Within 2-3 seconds after creating an order, the saga completes:

```bash
curl -s -X POST http://localhost:5001/orders.v1.OrderService/GetOrders \
  -H "Content-Type: application/json" -d '{}' | jq
```

```json
{
  "orders": [
    { "orderId": "b27ea322-...", "product": "Widget", "quantity": 5, "customer": "Alice", "status": "confirmed" },
    { "orderId": "a959035d-...", "product": "Gadget", "quantity": 3, "customer": "Bob", "status": "confirmed" }
  ]
}
```

### Step 10. Consumers Tab

The Consumers tab on a queue shows active consumers with their consumer tags, prefetch counts, and acknowledgement modes.

![Consumers](screenshots/screenshot-consumers.png)

---

## Project Structure

```
with-events-amqp/
├── proto/
│   ├── connectum/events/v1/options.proto   # Custom topic option
│   └── orders/v1/orders.proto              # Shared proto definition
├── src/
│   ├── order-service.ts                    # Entrypoint: Order Service (:5001)
│   ├── inventory-service.ts                # Entrypoint: Inventory Service (:5002)
│   ├── orderEventBus.ts                    # EventBus config for Order Service
│   ├── inventoryEventBus.ts                # EventBus config for Inventory Service
│   └── services/
│       ├── orderService.ts                 # CreateOrder, CancelOrder, GetOrders RPCs
│       ├── orderEvents.ts                  # OnInventoryReserved handler
│       ├── inventoryService.ts             # GetInventory RPC
│       └── inventoryEvents.ts              # OnOrderCreated, OnOrderCancelled handlers
├── tests/e2e/events.test.ts                # E2E tests
├── screenshots/                            # RabbitMQ Management UI screenshots
├── docker-compose.yml                      # RabbitMQ + 2 services
├── Dockerfile                              # Multi-stage build
└── package.json
```

## Custom Topics (Proto Options)

Connectum EventBus allows defining custom topic names via the proto option `(connectum.events.v1.event).topic`:

```protobuf
import "connectum/events/v1/options.proto";

service InventoryEventHandlers {
  // Default topic: orders.v1.OrderCreated (from message typeName)
  rpc OnOrderCreated(OrderCreated) returns (google.protobuf.Empty);

  // Custom topic: orders.cancelled
  rpc OnOrderCancelled(OrderCancelled) returns (google.protobuf.Empty) {
    option (connectum.events.v1.event).topic = "orders.cancelled";
  }
}
```

When publishing to a custom topic, specify `topic` in the options:

```typescript
await eventBus.publish(OrderCancelledSchema, data, { topic: "orders.cancelled" });
```

## EventBus Configuration

Each microservice creates its own EventBus instance with a separate consumer group backed by the same RabbitMQ topic exchange `"orders"`:

```typescript
// orderEventBus.ts
export const orderEventBus = createEventBus({
    adapter: AmqpAdapter({ url: AMQP_URL, exchange: "orders" }),
    routes: [orderEventRoutes],
    group: "order-service",
    middleware: { retry: { maxRetries: 3, backoff: "exponential" } },
});
```

`AmqpAdapter` connects to RabbitMQ and uses a topic exchange with durable queues per group, ensuring at-least-once delivery with manual acknowledgement.

## External AMQP Contract

This example uses the default Connectum conventions (topic exchange, `${exchange}.${group}` queues, protobuf payloads). When you need to integrate with an **externally defined AMQP contract** -- a partner's direct exchange, named durable queues with DLQ arguments, JSON bodies -- `AmqpAdapter` supports explicit topology, queue overrides, and serialization control:

```typescript
const adapter = AmqpAdapter({
    url: AMQP_URL,
    exchange: "partner.direct",
    exchangeType: "direct",
    // contentType label for the wire; the application publishes
    // pre-serialized JSON bytes through the adapter directly
    serialization: { contentType: "application/json" },
    // Declare the partner topology on connect (re-applied after recovery);
    // topologyMode: "check" verifies existence only, "skip" leaves it to the app
    topology: {
        exchanges: [{ name: "partner.dlx", type: "direct" }],
        queues: [
            { name: "partner.dead.v1", durable: true },
            {
                name: "partner.inbound.v1",
                durable: true,
                arguments: {
                    "x-dead-letter-exchange": "partner.dlx",
                    "x-dead-letter-routing-key": "inbound.dead",
                },
            },
        ],
        bindings: [
            { queue: "partner.dead.v1", source: "partner.dlx", routingKey: "inbound.dead" },
            { queue: "partner.inbound.v1", source: "partner.direct", routingKey: "inbound" },
        ],
    },
    // Consumer group "partner" attaches to the contract queue
    // instead of the default "partner.direct.partner"
    queueOverrides: {
        partner: { queue: "partner.inbound.v1" },
    },
    // Per-message confirms: each publish resolves on its own broker ack;
    // mandatory rejects unroutable publishes with AmqpUnroutableError
    publisherOptions: { persistent: true, mandatory: true },
});
```

Note: with `mandatory: true` (default `correlationHeader: true`) the adapter stamps a private `x-connectum-publish-id` header on mandatory publishes -- visible to external consumers. Set `publisherOptions.correlationHeader: false` for a clean wire (mandatory publishes are then serialized one at a time). See the [@connectum/events-amqp documentation](https://connectum.dev/en/packages/events-amqp) for topology modes, recovery options, and the full error taxonomy.

## Docker Compose

```yaml
services:
  rabbitmq:                    # AMQP broker + Management UI
    image: rabbitmq:4-management-alpine
    ports: ["5672:5672", "15672:15672"]

  order-service:               # Order microservice
    ports: ["5001:5001"]
    environment:
      - AMQP_URL=amqp://guest:guest@rabbitmq:5672

  inventory-service:           # Inventory microservice
    ports: ["5002:5002"]
    environment:
      - AMQP_URL=amqp://guest:guest@rabbitmq:5672
```

## Technologies

- [Connectum](https://github.com/Connectum-Framework/connectum) — gRPC/ConnectRPC framework
- [RabbitMQ](https://www.rabbitmq.com/) — AMQP 0-9-1 message broker with Management UI
- [@connectum/events](https://github.com/Connectum-Framework/connectum) — EventBus with proto-first routing
- [@connectum/events-amqp](https://github.com/Connectum-Framework/connectum) — AMQP/RabbitMQ adapter
