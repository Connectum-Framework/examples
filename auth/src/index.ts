/**
 * Auth Example
 *
 * Demonstrates @connectum/auth setup with:
 * - JWT authentication via createJwtAuthInterceptor()
 * - Declarative authorization via createAuthzInterceptor()
 * - Auth context access in service handlers (getAuthContext / requireAuthContext)
 * - Test token generation for local development
 */

import { createServer } from "@connectum/core";
import { Healthcheck, healthcheckManager, ServingStatus } from "@connectum/healthcheck";
import { createDefaultInterceptors } from "@connectum/interceptors";
import { Reflection } from "@connectum/reflection";
import {
    createJwtAuthInterceptor,
    createAuthzInterceptor,
} from "@connectum/auth";
import { createTestJwt, TEST_JWT_SECRET } from "@connectum/auth/testing";
import { greeterServiceRoutes } from "./services/greeterService.ts";

console.log("Starting Auth Example...\n");

// ---------------------------------------------------------------------------
// JWT Authentication
// ---------------------------------------------------------------------------
// Uses TEST_JWT_SECRET for demo purposes. In production, use JWKS or a
// securely stored HMAC secret (>= 32 bytes).
const jwtAuth = createJwtAuthInterceptor({
    secret: TEST_JWT_SECRET,
    issuer: "auth-example",
    claimsMapping: {
        roles: "roles",
        name: "name",
    },
    skipMethods: [
        "greeter.v1.GreeterService/SayHello", // Public method
        "grpc.health.v1.Health/*",              // Health checks
    ],
});

// ---------------------------------------------------------------------------
// Authorization Rules
// ---------------------------------------------------------------------------
// Rules are evaluated in order; first matching rule wins.
// Methods not matching any rule fall through to defaultPolicy ("deny").
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

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------
const server = createServer({
    services: [greeterServiceRoutes],
    port: 5000,
    host: "0.0.0.0",
    protocols: [Healthcheck({ httpEnabled: true }), Reflection()],
    interceptors: [
        ...createDefaultInterceptors(),
        jwtAuth,
        authz,
    ],
    shutdown: {
        timeout: 10_000,
    },
});

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------
server.on("start", () => {
    console.log("Server is starting...");
});

server.on("ready", async () => {
    healthcheckManager.update(ServingStatus.SERVING, "greeter.v1.GreeterService");

    // Generate sample tokens for testing
    const userToken = await createTestJwt(
        { sub: "user-123", name: "Alice" },
        { issuer: "auth-example" },
    );

    const adminToken = await createTestJwt(
        { sub: "admin-1", name: "Bob", roles: ["admin"] },
        { issuer: "auth-example" },
    );

    const addr = server.address;
    console.log(`\nServer ready on ${addr?.address}:${addr?.port}\n`);

    console.log("=== Test tokens (for demo only) ===\n");
    console.log(`User token:\n  ${userToken}\n`);
    console.log(`Admin token:\n  ${adminToken}\n`);

    console.log("=== Test commands ===\n");

    console.log("# 1. Public (no token needed):");
    console.log(`curl -s -X POST http://localhost:${addr?.port}/greeter.v1.GreeterService/SayHello \\`);
    console.log(`  -H "Content-Type: application/json" \\`);
    console.log(`  -d '{"name":"World"}'\n`);

    console.log("# 2. Authenticated (user token):");
    console.log(`curl -s -X POST http://localhost:${addr?.port}/greeter.v1.GreeterService/SayGoodbye \\`);
    console.log(`  -H "Content-Type: application/json" \\`);
    console.log(`  -H "Authorization: Bearer ${userToken}" \\`);
    console.log(`  -d '{"name":"Alice"}'\n`);

    console.log("# 3. Admin only (admin token):");
    console.log(`curl -s -X POST http://localhost:${addr?.port}/greeter.v1.GreeterService/SaySecret \\`);
    console.log(`  -H "Content-Type: application/json" \\`);
    console.log(`  -H "Authorization: Bearer ${adminToken}" \\`);
    console.log(`  -d '{"name":"Bob"}'\n`);

    console.log("# 4. Should fail -- no token on authenticated method:");
    console.log(`curl -s -X POST http://localhost:${addr?.port}/greeter.v1.GreeterService/SayGoodbye \\`);
    console.log(`  -H "Content-Type: application/json" \\`);
    console.log(`  -d '{"name":"Eve"}'\n`);

    console.log("# 5. Should fail -- user calling admin method:");
    console.log(`curl -s -X POST http://localhost:${addr?.port}/greeter.v1.GreeterService/SaySecret \\`);
    console.log(`  -H "Content-Type: application/json" \\`);
    console.log(`  -H "Authorization: Bearer ${userToken}" \\`);
    console.log(`  -d '{"name":"Alice"}'\n`);

    console.log("Press Ctrl+C to shutdown gracefully\n");
});

server.on("stop", () => {
    console.log("Server stopped");
});

server.on("error", (err: unknown) => {
    console.error("Server error:", err);
});

await server.start();
