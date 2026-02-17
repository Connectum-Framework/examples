/**
 * Greeter Service Implementation
 *
 * Demonstrates three authorization levels:
 * - SayHello: public (no auth required)
 * - SayGoodbye: authenticated (valid JWT required)
 * - SaySecret: admin only (JWT with 'admin' role)
 */

import { create } from "@bufbuild/protobuf";
import type { ConnectRouter } from "@connectrpc/connect";
import {
    GreeterService,
    type SayGoodbyeRequest,
    SayGoodbyeResponseSchema,
    type SayHelloRequest,
    SayHelloResponseSchema,
    type SaySecretRequest,
    SaySecretResponseSchema,
} from "#gen/greeter/v1/greeter_pb.ts";
import { getAuthContext, requireAuthContext } from "@connectum/auth";

/**
 * Register Greeter service routes with auth-aware handlers.
 *
 * @param router - ConnectRouter instance
 */
export function greeterServiceRoutes(router: ConnectRouter): void {
    router.service(GreeterService, {
        /**
         * Public endpoint -- auth context may be undefined.
         *
         * Demonstrates optional auth: if the caller provides a valid JWT
         * the response includes who they are, otherwise a generic greeting.
         */
        async sayHello(request: SayHelloRequest) {
            const name = request.name || "World";
            const auth = getAuthContext();

            const greeting = auth
                ? `Hello, ${name}! (authenticated as ${auth.subject})`
                : `Hello, ${name}!`;

            console.log(`[SayHello] ${greeting}`);

            return create(SayHelloResponseSchema, {
                message: greeting,
            });
        },

        /**
         * Authenticated endpoint -- requires a valid JWT.
         *
         * Demonstrates requireAuthContext() which throws
         * ConnectError(Code.Unauthenticated) if no auth context is present.
         */
        async sayGoodbye(request: SayGoodbyeRequest) {
            const name = request.name || "World";
            const auth = requireAuthContext();

            const message = `Goodbye, ${name}! (from ${auth.name ?? auth.subject})`;
            console.log(`[SayGoodbye] ${message}`);

            return create(SayGoodbyeResponseSchema, {
                message,
            });
        },

        /**
         * Admin-only endpoint -- requires JWT with 'admin' role.
         *
         * The authorization interceptor checks roles before this handler runs.
         * By the time we get here, auth.roles is guaranteed to include 'admin'.
         */
        async saySecret(request: SaySecretRequest) {
            const name = request.name || "World";
            const auth = requireAuthContext();

            const message = `Hello, ${name}!`;
            const secret = `The admin secret is 42. Verified by ${auth.subject} with roles: ${auth.roles.join(", ")}`;
            console.log(`[SaySecret] ${secret}`);

            return create(SaySecretResponseSchema, {
                message,
                secret,
            });
        },
    });
}
