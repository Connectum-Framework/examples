/**
 * GreeterService — defined with `defineService`.
 *
 * Handlers receive `(request, ctx)`. `ctx` is the Connectum context (the
 * ConnectRPC HandlerContext plus `ctx.call` / `ctx.stream` for cross-service
 * calls — unused here, this is a single service).
 *
 * @module services/greeterService
 */

import { create } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { defineService } from "@connectum/core";
import { GreeterService, SayGoodbyeResponseSchema, SayHelloResponseSchema } from "#gen/greeter/v1/greeter_pb.ts";

/**
 * Reject an empty name. The quickstart declares `min_len = 1` on `name` and
 * shows an empty name failing with InvalidArgument; this example does not pull
 * in protovalidate, so the same rule is enforced here by hand.
 */
function requireName(name: string): string {
    if (name.length === 0) {
        throw new ConnectError("name: must be at least 1 characters [string.min_len]", Code.InvalidArgument);
    }
    return name;
}

export const greeterService = defineService(GreeterService, {
    sayHello: (req) => create(SayHelloResponseSchema, { message: `Hello, ${requireName(req.name)}!` }),
    sayGoodbye: (req) => create(SayGoodbyeResponseSchema, { message: `Goodbye, ${requireName(req.name)}!` }),
});
