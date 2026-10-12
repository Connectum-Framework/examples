# JWT Token Interceptor Example

Shows a client interceptor that adds a supplied JWT to outgoing RPC requests.

## Overview

By default, the interceptor sets `Authorization: Bearer <token>` only when the
request does not already have an `Authorization` header. It does not obtain,
refresh or validate tokens; provide a token from your application's identity
provider.

## Usage

```typescript
import { createConnectTransport } from '@connectrpc/connect-node';
import { createAddTokenInterceptor } from './addToken.ts';

const transport = createConnectTransport({
    baseUrl: 'http://localhost:5000',
    interceptors: [
        createAddTokenInterceptor({
            token: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...',
            skipIfExists: true,
        }),
    ],
});
```

## Dependencies

- `@connectrpc/connect` — ConnectRPC interceptor type
- `@connectrpc/connect-node` — Node.js transport (`createConnectTransport`) used in the Usage example
