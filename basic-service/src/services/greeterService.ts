/**
 * Greeter Service Implementation
 *
 * A simple greeting service demonstrating @connectum/core usage.
 */

import { create } from "@bufbuild/protobuf";
import type { ConnectRouter } from "@connectrpc/connect";
import { GreeterService } from "#gen/greeter_pb.js";
import { type SayGoodbyeRequest, SayGoodbyeResponseSchema, type SayHelloRequest, SayHelloResponseSchema } from "#gen/greeter_pb.js";

/**
 * Register Greeter service routes
 *
 * @param router - ConnectRouter instance
 */
export function greeterServiceRoutes(router: ConnectRouter): void {
    router.service(GreeterService, {
        /**
         * Say hello to a person
         *
         * @param request - SayHello request with name
         * @returns Greeting message
         */
        async sayHello(request: SayHelloRequest) {
            const name = request.name || "World";

            console.log(`👋 Saying hello to: ${name}`);

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

            console.log(`👋 Saying goodbye to: ${name}`);

            return create(SayGoodbyeResponseSchema, {
                message: `Goodbye, ${name}! See you soon!`,
            });
        },
    });
}
