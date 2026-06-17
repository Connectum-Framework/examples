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
import { defineService } from "@connectum/core";
import { GreeterService, SayGoodbyeResponseSchema, SayHelloResponseSchema } from "#gen/greeter/v1/greeter_pb.ts";

export const greeterService = defineService(GreeterService, {
    sayHello: (req) => create(SayHelloResponseSchema, { message: `Hello, ${req.name || "world"}!` }),
    sayGoodbye: (req) => create(SayGoodbyeResponseSchema, { message: `Goodbye, ${req.name || "world"}!` }),
});
