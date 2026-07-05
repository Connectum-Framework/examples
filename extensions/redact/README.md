# Redact Extension Example

Demonstrates how to implement sensitive data redaction for RPC requests and responses using custom proto extensions.

## Overview

This extension automatically redacts fields marked with `(connectum.options.sensitive) = true` from both the request input and the response output of unary RPC methods, preventing sensitive data from leaking into logs and traces.

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

> Illustrative only. This example does not ship a generated `connectum/options.proto`; the
> `connectum.options.sensitive` / `connectum.options.use_sensitive` options are hand-rolled
> stubs defined in `extensions.ts` (extension field numbers 50001/50002). The block below shows
> the proto shape these stubs emulate — replace it with a real generated option once one exists.

```protobuf
message CodeVerifyRequest {
    string code = 1 [(connectum.options.sensitive) = true];
}
```

## Dependencies

- `@connectum/core` — Server foundation (`createServer`)
- `@bufbuild/protobuf` — Proto message handling
- `@connectrpc/connect` — ConnectRPC interceptor type
