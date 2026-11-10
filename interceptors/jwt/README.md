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

### Module format

`addToken.ts` is an ES module: it uses `import type` and `export`, and the usage
example above imports it by its `.ts` path. Copy it into a project that
type-checks ES modules: `"type": "module"` in the nearest `package.json`,
`"module": "nodenext"` and `"allowImportingTsExtensions": true` in
`tsconfig.json`. The examples in this repository use those settings together
with `"verbatimModuleSyntax": true`. `"module": "esnext"` with
`"moduleResolution": "bundler"` also type-checks the file, with or without the
`type` field.

In a CommonJS package (`"module": "nodenext"`, no `"type": "module"`) with
`"verbatimModuleSyntax": true`, `tsc --noEmit` rejects the file with TS1287
(`A top-level 'export' modifier cannot be used on value declarations in a CommonJS module when 'verbatimModuleSyntax' is enabled`).
Without `verbatimModuleSyntax` the check passes.

## Dependencies

- `@connectrpc/connect` — ConnectRPC interceptor type
- `@connectrpc/connect-node` — Node.js transport (`createConnectTransport`) used in the Usage example
