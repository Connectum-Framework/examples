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

> **Note:** This is the intended shape. Connectum does not yet ship a generated
> `connectum/options.proto`, so this snippet example uses temporary option stubs
> in [`extensions.ts`](extensions.ts) (field numbers `50001`/`50002`). They will
> be replaced with generated code once the proto options are published.

## Dependencies

- `@bufbuild/protobuf` — Proto message handling
- `@connectrpc/connect` — ConnectRPC interceptor type
