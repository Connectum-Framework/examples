/**
 * Proto-Based Service Implementation
 *
 * Authorization rules are defined in protobased.proto using custom options:
 * - SayHello: option (connectum.auth.v1.method_auth) = { public: true }
 * - SayGoodbye: no option (falls through to defaultPolicy)
 * - SaySecret: option (connectum.auth.v1.method_auth) = { requires: { roles: "admin" } }
 *
 * createProtoAuthzInterceptor reads these options automatically at runtime.
 */

import { create } from "@bufbuild/protobuf";
import type { ConnectRouter } from "@connectrpc/connect";
import {
    ProtoBasedService,
    type SayGoodbyeRequest,
    SayGoodbyeResponseSchema,
    type SayHelloRequest,
    SayHelloResponseSchema,
    type SaySecretRequest,
    SaySecretResponseSchema,
} from "#gen/protobased/v1/protobased_pb.ts";
import { getAuthContext, requireAuthContext } from "@connectum/auth";

export function protoBasedServiceRoutes(router: ConnectRouter): void {
    router.service(ProtoBasedService, {
        // Auth rules defined in protobased.proto (proto options)
        async sayHello(request: SayHelloRequest) {
            const name = request.name || "World";
            const auth = getAuthContext();

            const greeting = auth
                ? `Hello, ${name}! (authenticated as ${auth.subject})`
                : `Hello, ${name}!`;

            console.log(`[ProtoBased/SayHello] ${greeting}`);

            return create(SayHelloResponseSchema, {
                message: greeting,
            });
        },

        async sayGoodbye(request: SayGoodbyeRequest) {
            const name = request.name || "World";
            const auth = requireAuthContext();

            const message = `Goodbye, ${name}! (from ${auth.name ?? auth.subject})`;
            console.log(`[ProtoBased/SayGoodbye] ${message}`);

            return create(SayGoodbyeResponseSchema, {
                message,
            });
        },

        async saySecret(request: SaySecretRequest) {
            const name = request.name || "World";
            const auth = requireAuthContext();

            const message = `Hello, ${name}!`;
            const secret = `The admin secret is 42. Verified by ${auth.subject} with roles: ${auth.roles.join(", ")}`;
            console.log(`[ProtoBased/SaySecret] ${secret}`);

            return create(SaySecretResponseSchema, {
                message,
                secret,
            });
        },
    });
}
