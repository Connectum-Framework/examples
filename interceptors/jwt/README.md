# JWT Token Interceptor Example

Demonstrates how to automatically add JWT tokens to the Authorization header for RPC requests.

## Overview

This client-side interceptor adds a Bearer token to every outgoing request's Authorization header.

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
