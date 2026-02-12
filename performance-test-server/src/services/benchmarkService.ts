/**
 * Benchmark Service Implementation
 *
 * Minimal service for performance testing - fast responses to measure interceptor overhead.
 */

import { create } from "@bufbuild/protobuf";
import type { ConnectRouter } from "@connectrpc/connect";
import { GreeterService } from "#gen/greeter_pb.js";
import { type SayGoodbyeRequest, SayGoodbyeResponseSchema, type SayHelloRequest, SayHelloResponseSchema } from "#gen/greeter_pb.js";

/**
 * Register Benchmark service routes (minimal overhead implementation)
 *
 * @param router - ConnectRouter instance
 */
export function benchmarkServiceRoutes(router: ConnectRouter): void {
    router.service(GreeterService, {
        /**
         * Minimal SayHello implementation (no console logs, minimal processing)
         *
         * @param request - SayHello request
         * @returns Greeting response
         */
        async sayHello(request: SayHelloRequest) {
            // No logging, no async operations - pure minimal response
            const name = request.name || "Benchmark";

            return create(SayHelloResponseSchema, {
                message: `Hello, ${name}!`,
            });
        },

        /**
         * Minimal SayGoodbye implementation
         *
         * @param request - SayGoodbye request
         * @returns Goodbye response
         */
        async sayGoodbye(request: SayGoodbyeRequest) {
            const name = request.name || "Benchmark";

            return create(SayGoodbyeResponseSchema, {
                message: `Goodbye, ${name}!`,
            });
        },
    });
}
