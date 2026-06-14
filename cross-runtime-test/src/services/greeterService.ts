/**
 * Greeter Service Implementation
 *
 * A simple greeting service demonstrating @connectum/core usage.
 */

import { create } from "@bufbuild/protobuf";
import { defineService } from "@connectum/core";
import { GreeterService } from "#gen/greeter/v1/greeter_pb.ts";
import { type SayGoodbyeRequest, SayGoodbyeResponseSchema, type SayHelloRequest, SayHelloResponseSchema } from "#gen/greeter/v1/greeter_pb.ts";

/**
 * Greeter service definition
 */
export const greeterServiceRoutes = defineService(GreeterService, {
    /**
     * Say hello to a person
     *
     * @param request - SayHello request with name
     * @returns Greeting message
     */
    async sayHello(request: SayHelloRequest) {
        const name = request.name || "World";

        return create(SayHelloResponseSchema, {
            message: `Hello, ${name}!`,
        });
    },

    /**
     * Say goodbye to a person
     *
     * @param request - SayGoodbye request with name
     * @returns Goodbye message
     */
    async sayGoodbye(request: SayGoodbyeRequest) {
        const name = request.name || "World";

        return create(SayGoodbyeResponseSchema, {
            message: `Goodbye, ${name}! See you soon!`,
        });
    },
});
