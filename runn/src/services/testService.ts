import { setTimeout } from "node:timers/promises";
import { create } from "@bufbuild/protobuf";
import type { ConnectRouter } from "@connectrpc/connect";
import { Code, ConnectError } from "@connectrpc/connect";
import { createTestJwt, TEST_JWT_SECRET } from "@connectum/auth/testing";
import * as jose from "jose";
import { type ErrorMethodRequest, GetTestTokensResponseSchema, type SlowMethodRequest, SlowMethodResponseSchema, TestService } from "#gen/test/v1/test_pb.ts";

const CODE_MAP: Record<number, Code> = {
    3: Code.InvalidArgument,
    4: Code.DeadlineExceeded,
    5: Code.NotFound,
    7: Code.PermissionDenied,
    13: Code.Internal,
    16: Code.Unauthenticated,
};

const encodedSecret = new TextEncoder().encode(TEST_JWT_SECRET);

export function testServiceRoutes(router: ConnectRouter): void {
    router.service(TestService, {
        async slowMethod(request: SlowMethodRequest) {
            const delayMs = request.delayMs || 0;
            await setTimeout(delayMs);
            return create(SlowMethodResponseSchema, {
                message: `Completed after ${delayMs}ms`,
            });
        },

        async errorMethod(request: ErrorMethodRequest) {
            const code = CODE_MAP[request.code];
            if (code === undefined) {
                throw new ConnectError(`Unknown code: ${request.code}`, Code.InvalidArgument);
            }
            throw new ConnectError(request.message || "Test error", code);
        },

        async getTestTokens() {
            const userToken = await createTestJwt({ sub: "user-123", name: "Alice" }, { issuer: "runn-e2e", expiresIn: "1h" });

            const adminToken = await createTestJwt({ sub: "admin-1", name: "Bob", roles: ["admin"] }, { issuer: "runn-e2e", expiresIn: "1h" });

            const expiredToken = await new jose.SignJWT({ sub: "expired-user", name: "Eve" })
                .setProtectedHeader({ alg: "HS256" })
                .setIssuedAt(Math.floor(Date.now() / 1000) - 7200)
                .setExpirationTime(Math.floor(Date.now() / 1000) - 3600)
                .setIssuer("runn-e2e")
                .sign(encodedSecret);

            return create(GetTestTokensResponseSchema, {
                userToken,
                adminToken,
                expiredToken,
            });
        },
    });
}
