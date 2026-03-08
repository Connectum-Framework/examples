# EventBus + Apache Kafka: 2 Microservices with Saga Pattern

A bidirectional event-driven communication example between microservices using Apache Kafka (KRaft mode, no ZooKeeper) with a clean saga pattern for distributed order processing.

## Architecture

```mermaid
graph TB
    subgraph Kafka["Apache Kafka (KRaft mode) :9092"]
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
    participant K as Kafka
    participant IS as Inventory Service

    User->>OS: CreateOrder RPC
    OS->>K: publish OrderCreated
    OS-->>User: {status: "pending"}
    K->>IS: deliver OrderCreated
    IS->>IS: reserve stock
    IS->>K: publish InventoryReserved (topic: inventory.reserved)
    K->>OS: deliver InventoryReserved
    OS->>OS: order status → "confirmed"

    User->>OS: CancelOrder RPC
    OS->>K: publish OrderCancelled (topic: orders.cancelled)
    OS-->>User: {status: "cancelled"}
    K->>IS: deliver OrderCancelled
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

# 3. Start Kafka (KRaft mode)
docker compose up -d kafka

# 4. Start microservices (in separate terminals)
KAFKA_BROKERS=localhost:9092 pnpm run start:order      # port 5001
KAFKA_BROKERS=localhost:9092 pnpm run start:inventory   # port 5002
```

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

## Project Structure

```
with-events-kafka/
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
├── docker-compose.yml                      # Kafka (KRaft) + 2 services
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

Each microservice creates its own EventBus instance with a separate consumer group:

```typescript
// orderEventBus.ts
const KAFKA_BROKERS = (process.env.KAFKA_BROKERS ?? "localhost:9092").split(",");

export const orderEventBus = createEventBus({
    adapter: KafkaAdapter({ brokers: KAFKA_BROKERS, clientId: "order-service" }),
    routes: [orderEventRoutes],
    group: "order-service",
    middleware: { retry: { maxRetries: 3, backoff: "exponential" } },
});
```

## Docker Compose

```yaml
services:
  kafka:                       # Apache Kafka in KRaft mode (no ZooKeeper)
    image: apache/kafka:latest
    ports: ["9092:9092"]
    environment:
      KAFKA_NODE_ID: "1"
      KAFKA_PROCESS_ROLES: "broker,controller"
      KAFKA_CONTROLLER_QUORUM_VOTERS: "1@kafka:9093"

  order-service:               # Order microservice
    ports: ["5001:5001"]
    environment:
      - KAFKA_BROKERS=kafka:29092

  inventory-service:           # Inventory microservice
    ports: ["5002:5002"]
    environment:
      - KAFKA_BROKERS=kafka:29092
```

## Technologies

- [Connectum](https://github.com/Connectum-Framework/connectum) — gRPC/ConnectRPC framework
- [Apache Kafka](https://kafka.apache.org/) — distributed event streaming platform (KRaft mode)
- [@connectum/events](https://github.com/Connectum-Framework/connectum) — EventBus with proto-first routing
- [@connectum/events-kafka](https://github.com/Connectum-Framework/connectum) — KafkaJS adapter (Kafka + Redpanda)
