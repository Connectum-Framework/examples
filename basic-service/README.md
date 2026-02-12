# Basic Service Example

Минимальный рабочий пример использования `@connectum/core` для создания ConnectRPC сервиса.

## Что демонстрирует этот пример

- ✅ Простой gRPC/ConnectRPC сервис (Greeter)
- ✅ Использование @connectum/core
- ✅ Automatic healthcheck protocol
- ✅ Server reflection protocol
- ✅ Interceptors (error handler, logger, tracing)
- ✅ Graceful shutdown
- ✅ Native TypeScript execution (Node.js 25.2.0+)

## Структура проекта

```
basic-service/
├── proto/
│   └── greeter.proto          # Proto definition
├── gen/                       # Generated TypeScript code (git-ignored)
│   ├── greeter_pb.ts
│   └── greeter_connect.ts
├── src/
│   ├── services/
│   │   └── greeterService.ts  # Service implementation
│   └── index.ts               # Main entry point
├── buf.yaml                   # Buf configuration
├── buf.gen.yaml               # Proto generation config
├── package.json
├── tsconfig.json
└── README.md
```

## Prerequisites

- **Node.js** >= 25.2.0 (для native TypeScript support)
- **pnpm** >= 10.0.0
- **buf** CLI (для proto generation)

```bash
# Установка buf (если еще не установлен)
# macOS
brew install bufbuild/buf/buf

# Linux
curl -sSL "https://github.com/bufbuild/buf/releases/download/v1.47.0/buf-$(uname -s)-$(uname -m)" -o buf
chmod +x buf
sudo mv buf /usr/local/bin/
```

## Установка

Из корня monorepo:

```bash
# Установить все dependencies
pnpm install

# Сгенерировать proto code
cd packages/examples/basic-service
pnpm run build:proto
```

## Запуск

### Development mode (с auto-reload)

```bash
pnpm dev
```

### Production mode

```bash
pnpm start
```

Вы увидите:

```
🚀 Starting Basic Service Example...

✅ Server running on 0.0.0.0:5000

📡 Available services:
  - greeter.v1.GreeterService
  - grpc.health.v1.Health
  - grpc.reflection.v1.ServerReflection

🧪 Test with grpcurl:
  grpcurl -plaintext localhost:5000 list
  grpcurl -plaintext -d '{"name": "Alice"}' localhost:5000 greeter.v1.GreeterService/SayHello

🛑 Press Ctrl+C to shutdown gracefully
```

## Тестирование

### С grpcurl

#### 1. List all services (Server Reflection)

```bash
grpcurl -plaintext localhost:5000 list
```

Ожидаемый вывод:

```
greeter.v1.GreeterService
grpc.health.v1.Health
grpc.reflection.v1.ServerReflection
```

#### 2. Describe service

```bash
grpcurl -plaintext localhost:5000 describe greeter.v1.GreeterService
```

#### 3. Call SayHello method

```bash
grpcurl -plaintext -d '{"name": "Alice"}' \
  localhost:5000 \
  greeter.v1.GreeterService/SayHello
```

Ожидаемый вывод:

```json
{
  "message": "Hello, Alice!"
}
```

#### 4. Call SayGoodbye method

```bash
grpcurl -plaintext -d '{"name": "Bob"}' \
  localhost:5000 \
  greeter.v1.GreeterService/SayGoodbye
```

Ожидаемый вывод:

```json
{
  "message": "Goodbye, Bob! See you soon!"
}
```

#### 5. Health check

```bash
grpcurl -plaintext localhost:5000 grpc.health.v1.Health/Check
```

Ожидаемый вывод:

```json
{
  "status": "SERVING"
}
```

### С curl (HTTP/1.1)

Благодаря ConnectRPC, сервис также доступен через HTTP/1.1:

```bash
# SayHello
curl -X POST http://localhost:5000/greeter.v1.GreeterService/SayHello \
  -H "Content-Type: application/json" \
  -d '{"name": "Charlie"}'

# SayGoodbye
curl -X POST http://localhost:5000/greeter.v1.GreeterService/SayGoodbye \
  -H "Content-Type: application/json" \
  -d '{"name": "David"}'
```

## Понимание кода

### 1. Proto Definition (proto/greeter.proto)

```protobuf
syntax = "proto3";

package greeter.v1;

service GreeterService {
  rpc SayHello(SayHelloRequest) returns (SayHelloResponse) {}
  rpc SayGoodbye(SayGoodbyeRequest) returns (SayGoodbyeResponse) {}
}

message SayHelloRequest {
  string name = 1;
}

message SayHelloResponse {
  string message = 1;
}
```

**Ключевые моменты:**
- Simple service definition с 2 методами
- Request/Response messages для каждого метода
- `package greeter.v1` - версионирование API

### 2. Service Implementation (src/services/greeterService.ts)

```typescript
import { create } from "@bufbuild/protobuf";
import type { ConnectRouter } from "@connectrpc/connect";
import { GreeterService } from "#gen/greeter_pb.ts";

export function greeterServiceRoutes(router: ConnectRouter): void {
  router.service(GreeterService, {
    async sayHello(request: SayHelloRequest) {
      return create(SayHelloResponseSchema, {
        message: `Hello, ${request.name}!`,
      });
    },
    // ...
  });
}
```

**Ключевые моменты:**
- Factory function принимает `ConnectRouter`
- `router.service()` регистрирует service implementation
- `create()` создает type-safe response messages
- Async handlers для асинхронной logic

### 3. Main Entry Point (src/index.ts)

```typescript
import { Runner, Healthcheck, ServingStatus } from "@connectum/core";
import type { RunnerOptions } from "@connectum/core";

const options: RunnerOptions = {
  services: [greeterServiceRoutes],
  server: { port: 5000, host: "0.0.0.0" },
  interceptors: {
    errorHandler: true,
    logger: { level: "debug" },
    tracing: true,
  },
  healthcheck: true,
  reflection: true,
};

const server = await Runner(options);
Healthcheck.update(ServingStatus.SERVING);
```

**Ключевые моменты:**
- `Runner()` - главная factory function
- Type-safe `RunnerOptions` configuration
- Automatic interceptor chain
- Healthcheck state management
- Graceful shutdown handlers

## Расширение примера

### Добавить новый метод

1. Обновить proto файл:

```protobuf
service GreeterService {
  rpc SayHello(SayHelloRequest) returns (SayHelloResponse) {}
  rpc SayGoodbye(SayGoodbyeRequest) returns (SayGoodbyeResponse) {}
  rpc SayThanks(SayThanksRequest) returns (SayThanksResponse) {}  // NEW
}

message SayThanksRequest {
  string name = 1;
}

message SayThanksResponse {
  string message = 1;
}
```

2. Regenerate proto code:

```bash
pnpm run build:proto
```

3. Implement handler:

```typescript
export function greeterServiceRoutes(router: ConnectRouter): void {
  router.service(GreeterService, {
    async sayHello(request) { /* ... */ },
    async sayGoodbye(request) { /* ... */ },

    async sayThanks(request: SayThanksRequest) {
      return create(SayThanksResponseSchema, {
        message: `Thank you, ${request.name}!`,
      });
    },
  });
}
```

### Добавить validation

1. Update buf.yaml:

```yaml
version: v2
modules:
  - path: proto
deps:
  - buf.build/bufbuild/protovalidate  # ADD
```

2. Add validation constraints:

```protobuf
import "buf/validate/validate.proto";

message SayHelloRequest {
  string name = 1 [
    (buf.validate.field).string.min_len = 1,
    (buf.validate.field).string.max_len = 100
  ];
}
```

3. Enable validation interceptor:

```typescript
const options: RunnerOptions = {
  // ...
  interceptors: {
    validation: true,  // ADD
    errorHandler: true,
    // ...
  },
};
```

### Добавить database


```bash
```

2. Use in service:

```typescript


export function greeterServiceRoutes(router: ConnectRouter): void {
  router.service(GreeterService, {
    async sayHello(request: SayHelloRequest) {
      // Save greeting to database
      db.run("INSERT INTO greetings (name, message) VALUES (?, ?)", [
        request.name,
        `Hello, ${request.name}!`,
      ]);

      return create(SayHelloResponseSchema, {
        message: `Hello, ${request.name}!`,
      });
    },
  });
}
```

## Следующие шаги

1. Изучите [Getting Started Guide](../../../docs/getting-started/quick-start.md)
2. Прочитайте [Architecture Overview](../../../docs/architecture/overview.md)
3. Посмотрите другие примеры:
   - `with-validation/` - пример с validation rules
   - `with-database/` - пример с SQLite integration
   - `production-ready/` - production configuration

## Troubleshooting

### Error: Cannot find module '../../gen/greeter_pb.ts'

**Solution**: Сгенерируйте proto code:

```bash
pnpm run build:proto
```

### Error: node: command not found или version < 25.2.0

**Solution**: Установите Node.js 25.2.0+:

```bash
# С nvm
nvm install 25.2.0
nvm use 25.2.0
```

### Server не запускается на порту 5000

**Solution**: Порт занят, измените в src/index.ts:

```typescript
const options: RunnerOptions = {
  server: { port: 5001 },  // Изменить порт
  // ...
};
```

## License

Apache 2.0
