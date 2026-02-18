# runn E2E Tests

Docker-based E2E тест-сьют для всех пакетов Connectum на базе [runn](https://github.com/k1LoW/runn) (YAML runbooks).

## Покрытие

| Runbook | Пакет | Сценарии |
|---------|-------|----------|
| 01-healthcheck-grpc | @connectum/healthcheck | gRPC Check (overall, per-service) |
| 02-healthcheck-http | @connectum/healthcheck | HTTP /healthz, /readyz, /health, ?service= |
| 03-reflection | @connectum/reflection | Service discovery через gRPC reflection |
| 04-auth-public | @connectum/auth | Public endpoint без/с токеном |
| 05-auth-authenticated | @connectum/auth | JWT: valid, invalid, expired, missing |
| 06-auth-admin | @connectum/auth | Admin role: admin/user/no token |
| 07-interceptors-error | @connectum/interceptors | Error codes: INTERNAL, INVALID_ARGUMENT, NOT_FOUND, PERMISSION_DENIED |
| 08-interceptors-timeout | @connectum/interceptors | Fast OK, slow DEADLINE_EXCEEDED |
| 09-core-lifecycle | @connectum/core | Multi-service, gRPC + HTTP Connect protocol |

**Implicit:** @connectum/otel — трейсы отправляются в OTLP collector (сервер стартует с OTel).

**Не тестируется:** @connectum/cli (CLI-утилита), @connectum/testing (пустой пакет).

## Запуск

```bash
# Установка зависимостей и генерация proto
pnpm install
pnpm build:proto

# Полный E2E тест через Docker
pnpm test
# или напрямую:
docker compose up --build --exit-code-from tests --abort-on-container-exit

# С Jaeger UI (http://localhost:16686) для ручной проверки трейсов
pnpm test:observe
```

## Структура

```
runbooks/           # runn YAML runbooks (9 файлов, ~30 сценариев)
src/
  index.ts          # Тест-сервер: все пакеты Connectum включены
  services/
    greeterService.ts   # GreeterService (3 уровня авторизации)
    testService.ts      # TestService (SlowMethod, ErrorMethod, GetTestTokens)
proto/              # Protobuf definitions
gen/                # Сгенерированный код (buf generate)
```

## Тест-сервер

Сервер включает все пакеты:
- **core**: createServer, multi-service
- **healthcheck**: gRPC + HTTP health endpoints
- **reflection**: gRPC Server Reflection
- **auth**: JWT authentication + declarative authorization
- **interceptors**: Error handler, Timeout (3s), без circuit breaker/retry/bulkhead
- **otel**: OpenTelemetry трейсы → OTLP collector
