import { createJwtAuthInterceptor } from "@connectum/auth";
import { createProtoAuthzInterceptor, getPublicMethods } from "@connectum/auth/proto";
import { TEST_JWT_SECRET } from "@connectum/auth/testing";
import { createServer } from "@connectum/core";
import { Healthcheck, healthcheckManager, ServingStatus } from "@connectum/healthcheck";
import { createDefaultInterceptors } from "@connectum/interceptors";
import { createOtelInterceptor, initProvider } from "@connectum/otel";
import { Reflection } from "@connectum/reflection";
import { codeBasedServiceRoutes } from "./services/codeBasedService.ts";
import { protoBasedServiceRoutes } from "./services/protoBasedService.ts";
import { testServiceRoutes } from "./services/testService.ts";
import { ProtoBasedService } from "#gen/protobased/v1/protobased_pb.ts";

// ---------------------------------------------------------------------------
// OpenTelemetry (env-based: OTEL_SERVICE_NAME, OTEL_EXPORTER_OTLP_ENDPOINT)
// ---------------------------------------------------------------------------
initProvider({ serviceName: "runn-e2e-server" });

// ---------------------------------------------------------------------------
// Auto-discover public methods from proto options
// ---------------------------------------------------------------------------
const protoPublicMethods = getPublicMethods([ProtoBasedService]);

// ---------------------------------------------------------------------------
// JWT Authentication
// ---------------------------------------------------------------------------
const jwtAuth = createJwtAuthInterceptor({
    secret: TEST_JWT_SECRET,
    issuer: "runn-e2e",
    claimsMapping: {
        roles: "roles",
        name: "name",
    },
    skipMethods: [
        "codebased.v1.CodeBasedService/SayHello",
        ...protoPublicMethods,
        "test.v1.TestService/*",
        "grpc.health.v1.Health/*",
        "grpc.reflection.v1.ServerReflection/*",
    ],
});

// ---------------------------------------------------------------------------
// Authorization (single interceptor for both approaches)
// ---------------------------------------------------------------------------
const authz = createProtoAuthzInterceptor({
    defaultPolicy: "deny",
    // Fallback rules for CodeBasedService + infrastructure services
    rules: [
        {
            name: "codebased-public",
            methods: [
                "codebased.v1.CodeBasedService/SayHello",
                "test.v1.TestService/*",
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
// Server (ALL packages enabled)
// ---------------------------------------------------------------------------
const port = Number(process.env.PORT) || 5000;
const allowHTTP1 = process.env.ALLOW_HTTP1 !== "false";
const tlsDir = process.env.TLS_DIR;

const server = createServer({
    services: [codeBasedServiceRoutes, protoBasedServiceRoutes, testServiceRoutes],
    port,
    host: "0.0.0.0",
    allowHTTP1,
    tls: tlsDir ? { dirPath: tlsDir } : undefined,
    protocols: [Healthcheck({ httpEnabled: true }), Reflection()],
    interceptors: [
        ...createDefaultInterceptors({
            errorHandler: { logErrors: true },
            timeout: { duration: 3_000 },
            circuitBreaker: false,
            retry: false,
            bulkhead: false,
        }),
        createOtelInterceptor({
            serverPort: port,
            filter: ({ service }) => !service.includes("Health"),
        }),
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
    console.log("runn E2E server starting...");
});

server.on("ready", () => {
    healthcheckManager.update(ServingStatus.SERVING, "codebased.v1.CodeBasedService");
    healthcheckManager.update(ServingStatus.SERVING, "protobased.v1.ProtoBasedService");
    healthcheckManager.update(ServingStatus.SERVING, "test.v1.TestService");

    const addr = server.address;
    console.log(`runn E2E server ready on ${addr?.address}:${addr?.port}`);
});

server.on("stop", () => {
    console.log("runn E2E server stopped");
});

server.on("error", (err: unknown) => {
    console.error("Server error:", err);
});

await server.start();
