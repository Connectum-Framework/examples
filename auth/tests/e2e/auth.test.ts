/**
 * Auth E2E Tests
 *
 * Starts a real ConnectRPC server with JWT authentication and authorization,
 * makes HTTP requests using the Connect protocol, and verifies all
 * authorization scenarios.
 *
 * Test scenarios:
 * - Public endpoint (SayHello) with and without token
 * - Authenticated endpoint (SayGoodbye) with valid/invalid/missing token
 * - Admin-only endpoint (SaySecret) with admin/user/missing token
 * - Health check HTTP endpoint
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http2 from "node:http2";
import { createServer } from "@connectum/core";
import type { Server } from "@connectum/core";
import { createHealthcheckManager, Healthcheck, ServingStatus } from "@connectum/healthcheck";
import type { HealthcheckManager } from "@connectum/healthcheck";
import { createDefaultInterceptors } from "@connectum/interceptors";
import { Reflection } from "@connectum/reflection";
import {
    createJwtAuthInterceptor,
    createAuthzInterceptor,
} from "@connectum/auth";
import { createTestJwt, TEST_JWT_SECRET } from "@connectum/auth/testing";
import { greeterServiceRoutes } from "../../src/services/greeterService.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Make an HTTP/2 request, return status and parsed JSON body.
 */
function http2Request(
    port: number,
    reqHeaders: Record<string, string>,
    payload?: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
    return new Promise((resolve, reject) => {
        const client = http2.connect(`http://localhost:${port}`);
        client.on("error", reject);

        const req = client.request(reqHeaders);

        let status = 0;
        req.on("response", (headers) => {
            status = (headers[":status"] ?? 0) as number;
        });

        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => {
            const json = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>;
            client.close();
            resolve({ status, body: json });
        });
        req.on("error", (err: unknown) => {
            client.close();
            reject(err);
        });

        if (payload) req.write(payload);
        req.end();
    });
}

/**
 * Make a Connect protocol POST request over HTTP/2.
 */
function connectPost(
    port: number,
    method: string,
    body: Record<string, unknown>,
    headers?: Record<string, string>,
): Promise<{ status: number; body: Record<string, unknown> }> {
    return http2Request(
        port,
        {
            ":method": "POST",
            ":path": `/${method}`,
            "content-type": "application/json",
            ...headers,
        },
        JSON.stringify(body),
    );
}

/**
 * Make an HTTP/2 GET request, return status and parsed JSON body.
 */
function http2Get(
    port: number,
    path: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
    return http2Request(port, { ":method": "GET", ":path": path });
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
        // Generate test JWTs
        userToken = await createTestJwt(
            { sub: "user-123", name: "Alice" },
            { issuer: "auth-example" },
        );

        adminToken = await createTestJwt(
            { sub: "admin-1", name: "Bob", roles: ["admin"] },
            { issuer: "auth-example" },
        );

        // JWT Authentication -- mirrors src/index.ts configuration
        const jwtAuth = createJwtAuthInterceptor({
            secret: TEST_JWT_SECRET,
            issuer: "auth-example",
            claimsMapping: {
                roles: "roles",
                name: "name",
            },
            skipMethods: [
                "greeter.v1.GreeterService/SayHello",
                "grpc.health.v1.Health/*",
            ],
        });

        // Authorization Rules -- mirrors src/index.ts configuration
        const authz = createAuthzInterceptor({
            defaultPolicy: "deny",
            rules: [
                {
                    name: "public",
                    methods: [
                        "greeter.v1.GreeterService/SayHello",
                        "grpc.health.v1.Health/*",
                        "grpc.reflection.v1.ServerReflection/*",
                    ],
                    effect: "allow",
                },
                {
                    name: "authenticated",
                    methods: ["greeter.v1.GreeterService/SayGoodbye"],
                    effect: "allow",
                },
                {
                    name: "admin-only",
                    methods: ["greeter.v1.GreeterService/SaySecret"],
                    requires: { roles: ["admin"] },
                    effect: "allow",
                },
            ],
            skipMethods: [
                "greeter.v1.GreeterService/SayHello",
                "grpc.health.v1.Health/*",
            ],
        });

        // Server -- same setup as src/index.ts but with port: 0
        manager = createHealthcheckManager();
        server = createServer({
            services: [greeterServiceRoutes],
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
            manager.update(ServingStatus.SERVING, "greeter.v1.GreeterService");
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
    // 1. SayHello -- public endpoint
    // -----------------------------------------------------------------------

    describe("SayHello (public)", () => {
        it("should return greeting without auth info when no token provided", async () => {
            const result = await connectPost(
                port,
                "greeter.v1.GreeterService/SayHello",
                { name: "World" },
            );

            assert.equal(result.status, 200);
            assert.equal(result.body.message, "Hello, World!");
        });

        it("should return greeting without auth info even with token (skipMethods)", async () => {
            const result = await connectPost(
                port,
                "greeter.v1.GreeterService/SayHello",
                { name: "Alice" },
                { Authorization: `Bearer ${userToken}` },
            );

            assert.equal(result.status, 200);
            // SayHello is in skipMethods — JWT interceptor skips token processing,
            // so getAuthContext() returns undefined even with a valid token.
            assert.equal(result.body.message, "Hello, Alice!");
        });
    });

    // -----------------------------------------------------------------------
    // 2. SayGoodbye -- authenticated endpoint
    // -----------------------------------------------------------------------

    describe("SayGoodbye (authenticated)", () => {
        it("should return goodbye message with valid user token", async () => {
            const result = await connectPost(
                port,
                "greeter.v1.GreeterService/SayGoodbye",
                { name: "Alice" },
                { Authorization: `Bearer ${userToken}` },
            );

            assert.equal(result.status, 200);
            assert.equal(result.body.message, "Goodbye, Alice! (from Alice)");
        });

        it("should return unauthenticated error without token", async () => {
            const result = await connectPost(
                port,
                "greeter.v1.GreeterService/SayGoodbye",
                { name: "Eve" },
            );

            assert.notEqual(result.status, 200);
            assert.equal(result.body.code, "unauthenticated");
        });

        it("should return unauthenticated error with invalid token", async () => {
            const result = await connectPost(
                port,
                "greeter.v1.GreeterService/SayGoodbye",
                { name: "Eve" },
                { Authorization: "Bearer invalid.jwt.token" },
            );

            assert.notEqual(result.status, 200);
            assert.equal(result.body.code, "unauthenticated");
        });
    });

    // -----------------------------------------------------------------------
    // 3. SaySecret -- admin-only endpoint
    // -----------------------------------------------------------------------

    describe("SaySecret (admin-only)", () => {
        it("should return secret message with admin token", async () => {
            const result = await connectPost(
                port,
                "greeter.v1.GreeterService/SaySecret",
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
                "greeter.v1.GreeterService/SaySecret",
                { name: "Alice" },
                { Authorization: `Bearer ${userToken}` },
            );

            assert.notEqual(result.status, 200);
            assert.equal(result.body.code, "permission_denied");
        });

        it("should return unauthenticated error without token", async () => {
            const result = await connectPost(
                port,
                "greeter.v1.GreeterService/SaySecret",
                { name: "Eve" },
            );

            assert.notEqual(result.status, 200);
            assert.equal(result.body.code, "unauthenticated");
        });
    });

    // -----------------------------------------------------------------------
    // 4. Health check
    // -----------------------------------------------------------------------

    describe("Health check", () => {
        it("should respond 200 on GET /healthz", async () => {
            const result = await http2Get(port, "/healthz");

            assert.equal(result.status, 200);
            assert.equal(result.body.status, "SERVING");
        });
    });
});
