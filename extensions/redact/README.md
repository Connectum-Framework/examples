# Redact Extension Example

Shows a sample interceptor that removes selected protobuf fields from RPC request
and response messages. This directory is source code, not a package or a complete
protobuf contract.

## Overview

The interceptor runs only for methods marked with the sample
`(connectum.options.use_sensitive) = true` option. For those methods, it removes
fields marked with `(connectum.options.sensitive) = true` from unary requests
before the next interceptor and handler, and from unary responses before returning
to the caller. Place it before any interceptor that records message bodies if
those records must contain the redacted request.

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

> Illustrative only. This example does not include a generated
> `connectum/options.proto`. `connectum.options.sensitive` and
> `connectum.options.use_sensitive` are temporary stubs in `extensions.ts`, with
> field numbers 50001 and 50002; generate real protobuf extensions before using
> this pattern in an application.

```protobuf
message CodeVerifyRequest {
    string code = 1 [(connectum.options.sensitive) = true];
}

message VerifyResponse {}

service CodeVerificationService {
    rpc Verify(CodeVerifyRequest) returns (VerifyResponse) {
        option (connectum.options.use_sensitive) = true;
    }
}
```

## Dependencies

- `@connectum/core` — Server foundation (`createServer`)
- `@bufbuild/protobuf` — Proto message handling
- `@connectrpc/connect` — ConnectRPC interceptor type
