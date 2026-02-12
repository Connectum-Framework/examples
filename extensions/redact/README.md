# Redact Extension Example

Demonstrates how to implement sensitive data redaction for RPC responses using custom proto extensions.

## Overview

This extension automatically redacts fields marked with `(connectum.options.sensitive) = true` from RPC responses, preventing sensitive data from leaking into logs and traces.

## Usage

```typescript
import { createServer } from '@connectum/core';
import { createRedactInterceptor } from './redact.ts';

const server = createServer({
    services: [routes],
    interceptors: [
        createRedactInterceptor({ skipStreaming: true }),
    ],
});

await server.start();
```

## Proto Definition

```protobuf
import "connectum/options.proto";

message CodeVerifyRequest {
    string code = 1 [(connectum.options.sensitive) = true];
}
```

## Dependencies

- `@bufbuild/protobuf` — Proto message handling
- `@connectrpc/connect` — ConnectRPC interceptor type
