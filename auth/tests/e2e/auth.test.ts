/**
 * Auth E2E Tests — Proto-Based + Code-Based Authorization
 *
 * Starts a real ConnectRPC server with JWT authentication and authorization,
 * makes HTTP requests using the Connect protocol, and verifies all
 * authorization scenarios for both approaches:
 *
 * - CodeBasedService: authorization rules defined in TypeScript (programmatic rules)
 * - ProtoBasedService: authorization rules defined in .proto file (custom options)
 *
 * Both services have identical behavior:
 * - SayHello: public (no auth required)
 * - SayGoodbye: authenticated (valid JWT required)
 * - SaySecret: admin only (JWT with 'admin' role)
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "@connectum/core";
import type { Server } from "@connectum/core";
import { createHealthcheckManager, Healthcheck, ServingStatus } from "@connectum/healthcheck";
import type { HealthcheckManager } from "@connectum/healthcheck";
import { createDefaultInterceptors } from "@connectum/interceptors";
import { Reflection } from "@connectum/reflection";
import { createJwtAuthInterceptor } from "@connectum/auth";
import { createProtoAuthzInterceptor, getPublicMethods } from "@connectum/auth/proto";
import { createTestJwt, TEST_JWT_SECRET } from "@connectum/auth/testing";
import { codeBasedServiceRoutes } from "../../src/services/codeBasedService.ts";
import { protoBasedServiceRoutes } from "../../src/services/protoBasedService.ts";
import { ProtoBasedService } from "#gen/protobased/v1/protobased_pb.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function connectPost(
    port: number,
    method: string,
    body: Record<string, unknown>,
    headers?: Record<string, string>,
): Promise<{ status: number; body: Record<string, unknown> }> {
    const response = await fetch(`http://localhost:${port}/${method}`, {
        method: "POST",
        headers: {
            "content-type": "application/json",
            ...headers,
        },
        body: JSON.stringify(body),
    });

    const json = (await response.json()) as Record<string, unknown>;
    return { status: response.status, body: json };
}

async function httpGet(
    port: number,
    path: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
    const response = await fetch(`http://localhost:${port}${path}`);
    const json = (await response.json()) as Record<string, unknown>;
    return { status: response.status, body: json };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("Auth E2E", () => {
    let server: Server;
    let port: number;
    let manager: HealthcheckManager;

    let userToken: string;
    let adminToken: string;

    before(async () => {
        userToken = await createTestJwt(
            { sub: "user-123", name: "Alice" },
            { issuer: "auth-example" },
        );

        adminToken = await createTestJwt(
            { sub: "admin-1", name: "Bob", roles: ["admin"] },
            { issuer: "auth-example" },
        );

        const protoPublicMethods = getPublicMethods([ProtoBasedService]);

        const jwtAuth = createJwtAuthInterceptor({
            secret: TEST_JWT_SECRET,
            issuer: "auth-example",
            claimsMapping: {
                roles: "roles",
                name: "name",
            },
            skipMethods: [
                "codebased.v1.CodeBasedService/SayHello",
                ...protoPublicMethods,
                "grpc.health.v1.Health/*",
            ],
        });

        const authz = createProtoAuthzInterceptor({
            defaultPolicy: "deny",
            rules: [
                {
                    name: "codebased-public",
                    methods: [
                        "codebased.v1.CodeBasedService/SayHello",
                        "grpc.health.v1.Health/*",
                        "grpc.reflection.v1.ServerReflection/*",
                    ],
                    effect: "allow",
                },
                {
                    name: "codebased-authenticated",
                    methods: ["codebased.v1.CodeBasedService/SayGoodbye"],
                    effect: "allow",
                },
                {
                    name: "codebased-admin-only",
                    methods: ["codebased.v1.CodeBasedService/SaySecret"],
                    requires: { roles: ["admin"] },
                    effect: "allow",
                },
            ],
        });

        manager = createHealthcheckManager();
        server = createServer({
            services: [codeBasedServiceRoutes, protoBasedServiceRoutes],
            port: 0,
            protocols: [Healthcheck({ httpEnabled: true, manager }), Reflection()],
            interceptors: [
                ...createDefaultInterceptors(),
                jwtAuth,
                authz,
            ],
            shutdown: {
                timeout: 10_000,
            },
        });

        server.on("ready", () => {
            manager.update(ServingStatus.SERVING, "codebased.v1.CodeBasedService");
            manager.update(ServingStatus.SERVING, "protobased.v1.ProtoBasedService");
        });

        await server.start();
        port = server.address!.port;
    });

    after(async () => {
        if (server.state === "running") {
            await server.stop();
        }
    });

    // -----------------------------------------------------------------------
    // CodeBasedService (programmatic rules)
    // -----------------------------------------------------------------------

    describe("CodeBasedService (programmatic rules)", () => {
        describe("SayHello (public)", () => {
            it("should return greeting without auth info when no token provided", async () => {
                const result = await connectPost(
                    port,
                    "codebased.v1.CodeBasedService/SayHello",
                    { name: "World" },
                );

                assert.equal(result.status, 200);
                assert.equal(result.body.message, "Hello, World!");
            });

            it("should return greeting without auth info even with token (skipMethods)", async () => {
                const result = await connectPost(
                    port,
                    "codebased.v1.CodeBasedService/SayHello",
                    { name: "Alice" },
                    { Authorization: `Bearer ${userToken}` },
                );

                assert.equal(result.status, 200);
                assert.equal(result.body.message, "Hello, Alice!");
            });
        });

        describe("SayGoodbye (authenticated)", () => {
            it("should return goodbye message with valid user token", async () => {
                const result = await connectPost(
                    port,
                    "codebased.v1.CodeBasedService/SayGoodbye",
                    { name: "Alice" },
                    { Authorization: `Bearer ${userToken}` },
                );

                assert.equal(result.status, 200);
                assert.equal(result.body.message, "Goodbye, Alice! (from Alice)");
            });

            it("should return unauthenticated error without token", async () => {
                const result = await connectPost(
                    port,
                    "codebased.v1.CodeBasedService/SayGoodbye",
                    { name: "Eve" },
                );

                assert.notEqual(result.status, 200);
                assert.equal(result.body.code, "unauthenticated");
            });

            it("should return unauthenticated error with invalid token", async () => {
                const result = await connectPost(
                    port,
                    "codebased.v1.CodeBasedService/SayGoodbye",
                    { name: "Eve" },
                    { Authorization: "Bearer invalid.jwt.token" },
                );

                assert.notEqual(result.status, 200);
                assert.equal(result.body.code, "unauthenticated");
            });
        });

        describe("SaySecret (admin-only)", () => {
            it("should return secret message with admin token", async () => {
                const result = await connectPost(
                    port,
                    "codebased.v1.CodeBasedService/SaySecret",
                    { name: "Bob" },
                    { Authorization: `Bearer ${adminToken}` },
                );

                assert.equal(result.status, 200);
                assert.equal(result.body.message, "Hello, Bob!");
                assert.ok(
                    typeof result.body.secret === "string",
                    "secret should be a string",
                );
                assert.ok(
                    (result.body.secret as string).includes("admin"),
                    "secret should mention admin role",
                );
            });

            it("should return permission_denied error with user token (no admin role)", async () => {
                const result = await connectPost(
                    port,
                    "codebased.v1.CodeBasedService/SaySecret",
                    { name: "Alice" },
                    { Authorization: `Bearer ${userToken}` },
                );

                assert.notEqual(result.status, 200);
                assert.equal(result.body.code, "permission_denied");
            });

            it("should return unauthenticated error without token", async () => {
                const result = await connectPost(
                    port,
                    "codebased.v1.CodeBasedService/SaySecret",
                    { name: "Eve" },
                );

                assert.notEqual(result.status, 200);
                assert.equal(result.body.code, "unauthenticated");
            });
        });
    });

    // -----------------------------------------------------------------------
    // ProtoBasedService (proto options)
    // -----------------------------------------------------------------------

    describe("ProtoBasedService (proto options)", () => {
        describe("SayHello (public — proto: public=true)", () => {
            it("should return greeting without auth info when no token provided", async () => {
                const result = await connectPost(
                    port,
                    "protobased.v1.ProtoBasedService/SayHello",
                    { name: "World" },
                );

                assert.equal(result.status, 200);
                assert.equal(result.body.message, "Hello, World!");
            });

            it("should return greeting without auth info even with token (public skips auth)", async () => {
                const result = await connectPost(
                    port,
                    "protobased.v1.ProtoBasedService/SayHello",
                    { name: "Alice" },
                    { Authorization: `Bearer ${userToken}` },
                );

                assert.equal(result.status, 200);
                assert.equal(result.body.message, "Hello, Alice!");
            });
        });

        describe("SayGoodbye (authenticated — proto: default policy)", () => {
            it("should return goodbye message with valid user token", async () => {
                const result = await connectPost(
                    port,
                    "protobased.v1.ProtoBasedService/SayGoodbye",
                    { name: "Alice" },
                    { Authorization: `Bearer ${userToken}` },
                );

                assert.equal(result.status, 200);
                assert.equal(result.body.message, "Goodbye, Alice! (from Alice)");
            });

            it("should return unauthenticated error without token", async () => {
                const result = await connectPost(
                    port,
                    "protobased.v1.ProtoBasedService/SayGoodbye",
                    { name: "Eve" },
                );

                assert.notEqual(result.status, 200);
                assert.equal(result.body.code, "unauthenticated");
            });

            it("should return unauthenticated error with invalid token", async () => {
                const result = await connectPost(
                    port,
                    "protobased.v1.ProtoBasedService/SayGoodbye",
                    { name: "Eve" },
                    { Authorization: "Bearer invalid.jwt.token" },
                );

                assert.notEqual(result.status, 200);
                assert.equal(result.body.code, "unauthenticated");
            });
        });

        describe("SaySecret (admin-only — proto: requires roles=admin)", () => {
            it("should return secret message with admin token", async () => {
                const result = await connectPost(
                    port,
                    "protobased.v1.ProtoBasedService/SaySecret",
                    { name: "Bob" },
                    { Authorization: `Bearer ${adminToken}` },
                );

                assert.equal(result.status, 200);
                assert.equal(result.body.message, "Hello, Bob!");
                assert.ok(
                    typeof result.body.secret === "string",
                    "secret should be a string",
                );
                assert.ok(
                    (result.body.secret as string).includes("admin"),
                    "secret should mention admin role",
                );
            });

            it("should return permission_denied error with user token (no admin role)", async () => {
                const result = await connectPost(
                    port,
                    "protobased.v1.ProtoBasedService/SaySecret",
                    { name: "Alice" },
                    { Authorization: `Bearer ${userToken}` },
                );

                assert.notEqual(result.status, 200);
                assert.equal(result.body.code, "permission_denied");
            });

            it("should return unauthenticated error without token", async () => {
                const result = await connectPost(
                    port,
                    "protobased.v1.ProtoBasedService/SaySecret",
                    { name: "Eve" },
                );

                assert.notEqual(result.status, 200);
                assert.equal(result.body.code, "unauthenticated");
            });
        });
    });

    // -----------------------------------------------------------------------
    // Health check
    // -----------------------------------------------------------------------

    describe("Health check", () => {
        it("should respond 200 on GET /healthz", async () => {
            const result = await httpGet(port, "/healthz");

            assert.equal(result.status, 200);
            assert.equal(result.body.status, "SERVING");
        });
    });
});
