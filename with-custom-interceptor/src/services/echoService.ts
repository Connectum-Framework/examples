/**
 * Echo Service Implementation
 *
 * Demonstrates three RPC methods with different interceptor behaviors:
 * - Echo: no special protection
 * - SecureEcho: protected by API key authentication
 * - RateLimitedEcho: protected by rate limiting
 *
 * @module echoService
 */

import { create } from "@bufbuild/protobuf";
import type { ConnectRouter } from "@connectrpc/connect";
import { EchoService } from "#gen/echo/v1/echo_pb.ts";
import { type EchoRequest, EchoResponseSchema } from "#gen/echo/v1/echo_pb.ts";

/**
 * Build an echo response from the given request.
 *
 * @param request - Incoming echo request
 * @returns EchoResponse with message and timestamp
 */
function buildEchoResponse(request: EchoRequest) {
    return create(EchoResponseSchema, {
        message: request.message || "Echo!",
        timestamp: BigInt(Date.now()),
    });
}

/**
 * Register Echo service routes
 *
 * @param router - ConnectRouter instance
 */
export function echoServiceRoutes(router: ConnectRouter): void {
    router.service(EchoService, {
        /**
         * Echo returns the same message it receives.
         * No special interceptor protection.
         *
         * @param request - EchoRequest with message
         * @returns EchoResponse with message and timestamp
         */
        async echo(request: EchoRequest) {
            console.log(`Echo: "${request.message}"`);
            return buildEchoResponse(request);
        },

        /**
         * SecureEcho requires API key authentication (handled by apiKeyInterceptor).
         * The service logic is identical to Echo.
         *
         * @param request - EchoRequest with message
         * @returns EchoResponse with message and timestamp
         */
        async secureEcho(request: EchoRequest) {
            console.log(`SecureEcho: "${request.message}"`);
            return buildEchoResponse(request);
        },

        /**
         * RateLimitedEcho is protected by rate limiting (handled by rateLimitInterceptor).
         * The service logic is identical to Echo.
         *
         * @param request - EchoRequest with message
         * @returns EchoResponse with message and timestamp
         */
        async rateLimitedEcho(request: EchoRequest) {
            console.log(`RateLimitedEcho: "${request.message}"`);
            return buildEchoResponse(request);
        },
    });
}
