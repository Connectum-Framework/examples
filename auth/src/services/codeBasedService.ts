/**
 * Code-Based Service Implementation
 *
 * Authorization rules are defined in TypeScript code (src/index.ts)
 * using createProtoAuthzInterceptor({ rules: [...] }).
 *
 * Three authorization levels:
 * - SayHello: public (no auth required)
 * - SayGoodbye: authenticated (valid JWT required)
 * - SaySecret: admin only (JWT with 'admin' role)
 */

import { create } from "@bufbuild/protobuf";
import type { ConnectRouter } from "@connectrpc/connect";
import {
    CodeBasedService,
    type SayGoodbyeRequest,
    SayGoodbyeResponseSchema,
    type SayHelloRequest,
    SayHelloResponseSchema,
    type SaySecretRequest,
    SaySecretResponseSchema,
} from "#gen/codebased/v1/codebased_pb.ts";
import { getAuthContext, requireAuthContext } from "@connectum/auth";

export function codeBasedServiceRoutes(router: ConnectRouter): void {
    router.service(CodeBasedService, {
        // Auth rules defined in src/index.ts (programmatic rules)
        async sayHello(request: SayHelloRequest) {
            const name = request.name || "World";
            const auth = getAuthContext();

            const greeting = auth
                ? `Hello, ${name}! (authenticated as ${auth.subject})`
                : `Hello, ${name}!`;

            console.log(`[CodeBased/SayHello] ${greeting}`);

            return create(SayHelloResponseSchema, {
                message: greeting,
            });
        },

        async sayGoodbye(request: SayGoodbyeRequest) {
            const name = request.name || "World";
            const auth = requireAuthContext();

            const message = `Goodbye, ${name}! (from ${auth.name ?? auth.subject})`;
            console.log(`[CodeBased/SayGoodbye] ${message}`);

            return create(SayGoodbyeResponseSchema, {
                message,
            });
        },

        async saySecret(request: SaySecretRequest) {
            const name = request.name || "World";
            const auth = requireAuthContext();

            const message = `Hello, ${name}!`;
            const secret = `The admin secret is 42. Verified by ${auth.subject} with roles: ${auth.roles.join(", ")}`;
            console.log(`[CodeBased/SaySecret] ${secret}`);

            return create(SaySecretResponseSchema, {
                message,
                secret,
            });
        },
    });
}
