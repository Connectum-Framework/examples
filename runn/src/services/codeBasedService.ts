import { create } from "@bufbuild/protobuf";
import type { ConnectRouter } from "@connectrpc/connect";
import { getAuthContext, requireAuthContext } from "@connectum/auth";
import {
    CodeBasedService,
    type SayGoodbyeRequest,
    SayGoodbyeResponseSchema,
    type SayHelloRequest,
    SayHelloResponseSchema,
    type SaySecretRequest,
    SaySecretResponseSchema,
} from "#gen/codebased/v1/codebased_pb.ts";

export function codeBasedServiceRoutes(router: ConnectRouter): void {
    router.service(CodeBasedService, {
        async sayHello(request: SayHelloRequest) {
            const name = request.name || "World";
            const auth = getAuthContext();

            const greeting = auth ? `Hello, ${name}! (authenticated as ${auth.subject})` : `Hello, ${name}!`;

            return create(SayHelloResponseSchema, { message: greeting });
        },

        async sayGoodbye(request: SayGoodbyeRequest) {
            const name = request.name || "World";
            const auth = requireAuthContext();

            const message = `Goodbye, ${name}! (from ${auth.name ?? auth.subject})`;

            return create(SayGoodbyeResponseSchema, { message });
        },

        async saySecret(request: SaySecretRequest) {
            const name = request.name || "World";
            const auth = requireAuthContext();

            const message = `Hello, ${name}!`;
            const secret = `The admin secret is 42. Verified by ${auth.subject} with roles: ${auth.roles.join(", ")}`;

            return create(SaySecretResponseSchema, { message, secret });
        },
    });
}
