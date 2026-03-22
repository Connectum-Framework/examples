# Custom Metrics Dashboard

PromQL queries for building a Coroot dashboard with business metrics from `@connectum/otel` `getMeter()`.

## Setup

1. Open Coroot UI at http://localhost:8080
2. Navigate to **Dashboards** in the left sidebar
3. Create a new dashboard (e.g. "demo")
4. Add panels using the PromQL queries below

## Order Service Metrics

### Orders Created by Product (rate/min)

```promql
sum by (product_id) (rate(orders_created_total[5m])) * 60
```

### Total Items Ordered (rate/min)

```promql
sum(rate(orders_items_total[5m])) * 60
```

### Active Orders

```promql
sum(orders_active)
```

### Order Size — p50

```promql
histogram_quantile(0.5, sum by (le) (rate(orders_value_items_bucket[5m])))
```

### Order Size — p95

```promql
histogram_quantile(0.95, sum by (le) (rate(orders_value_items_bucket[5m])))
```

### Order Size — p99

```promql
histogram_quantile(0.99, sum by (le) (rate(orders_value_items_bucket[5m])))
```

## Inventory Service Metrics

### Stock Checks by Product (rate/min)

```promql
sum by (product_id) (rate(inventory_stock_checks_total[5m])) * 60
```

### Stock Available by Product (rate/min)

```promql
sum by (product_id) (rate(inventory_stock_checks_available_total[5m])) * 60
```

### Stock Unavailable by Product (rate/min)

```promql
sum by (product_id) (rate(inventory_stock_checks_unavailable_total[5m])) * 60
```

### Stock Availability Rate by Product (%)

```promql
sum by (product_id) (rate(inventory_stock_checks_available_total[5m])) / sum by (product_id) (rate(inventory_stock_checks_total[5m])) * 100
```

### Current Stock Level by Product

```promql
inventory_stock_level
```

## Metric Sources

| Metric | Type | Service | Source |
|--------|------|---------|--------|
| `orders_created_total` | Counter | order-service | `meter.createCounter("orders.created")` |
| `orders_items_total` | Counter | order-service | `meter.createCounter("orders.items.total")` |
| `orders_active` | UpDownCounter | order-service | `meter.createUpDownCounter("orders.active")` |
| `orders_value_items` | Histogram | order-service | `meter.createHistogram("orders.value")` |
| `inventory_stock_checks_total` | Counter | inventory-service | `meter.createCounter("inventory.stock_checks")` |
| `inventory_stock_checks_available_total` | Counter | inventory-service | `meter.createCounter("inventory.stock_checks.available")` |
| `inventory_stock_checks_unavailable_total` | Counter | inventory-service | `meter.createCounter("inventory.stock_checks.unavailable")` |
| `inventory_stock_level` | ObservableGauge | inventory-service | `meter.createObservableGauge("inventory.stock_level")` |

## Notes

- OTel metric names use dots (e.g. `orders.created`), Prometheus converts to underscores (`orders_created_total`)
- Counters get `_total` suffix automatically
- Histograms get `_bucket`, `_count`, `_sum` suffixes
- Metrics reach Prometheus via OTel Collector `prometheusremotewrite` exporter
- Labels like `product_id` come from OTel attributes (dots converted to underscores)
