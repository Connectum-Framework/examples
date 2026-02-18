/**
 * Auth Example — Proto-Based + Code-Based Authorization
 *
 * Demonstrates two approaches to authorization side by side:
 *
 * 1. **Code-Based** (CodeBasedService): Authorization rules defined
 *    in TypeScript via programmatic rules in createProtoAuthzInterceptor().
 *
 * 2. **Proto-Based** (ProtoBasedService): Authorization rules defined
 *    in .proto file via custom options (connectum.auth.v1.method_auth).
 *
 * Both approaches use the same interceptor chain:
 *   defaultInterceptors → jwtAuth → protoAuthz → handler
 */

import { createServer } from "@connectum/core";
import { Healthcheck, healthcheckManager, ServingStatus } from "@connectum/healthcheck";
import { createDefaultInterceptors } from "@connectum/interceptors";
import { Reflection } from "@connectum/reflection";
import { createJwtAuthInterceptor } from "@connectum/auth";
import { createProtoAuthzInterceptor, getPublicMethods } from "@connectum/auth/proto";
import { createTestJwt, TEST_JWT_SECRET } from "@connectum/auth/testing";
import { codeBasedServiceRoutes } from "./services/codeBasedService.ts";
import { protoBasedServiceRoutes } from "./services/protoBasedService.ts";
import { ProtoBasedService } from "#gen/protobased/v1/protobased_pb.ts";

console.log("Starting Auth Example (Proto-Based + Code-Based)...\n");

// ---------------------------------------------------------------------------
// Auto-discover public methods from proto options
// ---------------------------------------------------------------------------
// getPublicMethods reads `method_auth.public = true` from .proto files
// and returns patterns like ["protobased.v1.ProtoBasedService/SayHello"]
const protoPublicMethods = getPublicMethods([ProtoBasedService]);

// ---------------------------------------------------------------------------
// JWT Authentication
// ---------------------------------------------------------------------------
const jwtAuth = createJwtAuthInterceptor({
    secret: TEST_JWT_SECRET,
    issuer: "auth-example",
    claimsMapping: {
        roles: "roles",
        name: "name",
    },
    skipMethods: [
        "codebased.v1.CodeBasedService/SayHello", // Code-based: programmatic skip
        ...protoPublicMethods,                      // Proto-based: auto-discovered
        "grpc.health.v1.Health/*",
    ],
});

// ---------------------------------------------------------------------------
// Authorization (single interceptor for both approaches)
// ---------------------------------------------------------------------------
// createProtoAuthzInterceptor handles both:
// - Proto options (ProtoBasedService): reads auth options from .proto file
// - Programmatic rules (CodeBasedService): evaluates fallback rules
const authz = createProtoAuthzInterceptor({
    defaultPolicy: "deny",
    // Fallback rules for CodeBasedService (no proto options defined)
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

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------
const server = createServer({
    services: [codeBasedServiceRoutes, protoBasedServiceRoutes],
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
    healthcheckManager.update(ServingStatus.SERVING, "codebased.v1.CodeBasedService");
    healthcheckManager.update(ServingStatus.SERVING, "protobased.v1.ProtoBasedService");

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

    console.log("=== Code-Based Service (programmatic rules) ===\n");

    console.log("# 1. Public (no token needed):");
    console.log(`curl -s -X POST http://localhost:${addr?.port}/codebased.v1.CodeBasedService/SayHello \\`);
    console.log(`  -H "Content-Type: application/json" \\`);
    console.log(`  -d '{"name":"World"}'\n`);

    console.log("# 2. Authenticated (user token):");
    console.log(`curl -s -X POST http://localhost:${addr?.port}/codebased.v1.CodeBasedService/SayGoodbye \\`);
    console.log(`  -H "Content-Type: application/json" \\`);
    console.log(`  -H "Authorization: Bearer ${userToken}" \\`);
    console.log(`  -d '{"name":"Alice"}'\n`);

    console.log("# 3. Admin only (admin token):");
    console.log(`curl -s -X POST http://localhost:${addr?.port}/codebased.v1.CodeBasedService/SaySecret \\`);
    console.log(`  -H "Content-Type: application/json" \\`);
    console.log(`  -H "Authorization: Bearer ${adminToken}" \\`);
    console.log(`  -d '{"name":"Bob"}'\n`);

    console.log("=== Proto-Based Service (proto options) ===\n");

    console.log("# 4. Public (no token needed — proto: public=true):");
    console.log(`curl -s -X POST http://localhost:${addr?.port}/protobased.v1.ProtoBasedService/SayHello \\`);
    console.log(`  -H "Content-Type: application/json" \\`);
    console.log(`  -d '{"name":"World"}'\n`);

    console.log("# 5. Authenticated (user token — proto: default policy):");
    console.log(`curl -s -X POST http://localhost:${addr?.port}/protobased.v1.ProtoBasedService/SayGoodbye \\`);
    console.log(`  -H "Content-Type: application/json" \\`);
    console.log(`  -H "Authorization: Bearer ${userToken}" \\`);
    console.log(`  -d '{"name":"Alice"}'\n`);

    console.log("# 6. Admin only (admin token — proto: requires roles=admin):");
    console.log(`curl -s -X POST http://localhost:${addr?.port}/protobased.v1.ProtoBasedService/SaySecret \\`);
    console.log(`  -H "Content-Type: application/json" \\`);
    console.log(`  -H "Authorization: Bearer ${adminToken}" \\`);
    console.log(`  -d '{"name":"Bob"}'\n`);

    console.log("Press Ctrl+C to shutdown gracefully\n");
});

server.on("stop", () => {
    console.log("Server stopped");
});

server.on("error", (err: unknown) => {
    console.error("Server error:", err);
});

await server.start();
