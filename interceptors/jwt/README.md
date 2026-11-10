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

`addToken.ts` is an ES module. In the nearest `package.json` set
`"type": "module"`; in `tsconfig.json` set `"module": "nodenext"`. To import
the file by its `.ts` path, as the usage example above does, also set
`"allowImportingTsExtensions": true` and `"noEmit": true` (TypeScript accepts
`.ts` import paths only together with `noEmit` or `emitDeclarationOnly`). The examples
in this repository use these settings together with
`"verbatimModuleSyntax": true`. `"module": "esnext"` with
`"moduleResolution": "bundler"` also type-checks the file, with or without the
`type` field.

Without `"type": "module"`, a project that sets `"verbatimModuleSyntax": true`
rejects the file with TS1287: a top-level `export` of a value cannot be used in
a CommonJS module under that option. Without `verbatimModuleSyntax` the type
check passes.

## Dependencies

- `@connectrpc/connect` — ConnectRPC interceptor type
- `@connectrpc/connect-node` — Node.js transport (`createConnectTransport`) used in the Usage example
