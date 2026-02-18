import { createAuthzInterceptor, createJwtAuthInterceptor } from "@connectum/auth";
import { TEST_JWT_SECRET } from "@connectum/auth/testing";
import { createServer } from "@connectum/core";
import { Healthcheck, healthcheckManager, ServingStatus } from "@connectum/healthcheck";
import { createDefaultInterceptors } from "@connectum/interceptors";
import { createOtelInterceptor, initProvider } from "@connectum/otel";
import { Reflection } from "@connectum/reflection";
import { greeterServiceRoutes } from "./services/greeterService.ts";
import { testServiceRoutes } from "./services/testService.ts";

// ---------------------------------------------------------------------------
// OpenTelemetry (env-based: OTEL_SERVICE_NAME, OTEL_EXPORTER_OTLP_ENDPOINT)
// ---------------------------------------------------------------------------
initProvider({ serviceName: "runn-e2e-server" });

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
    skipMethods: ["greeter.v1.GreeterService/SayHello", "test.v1.TestService/*", "grpc.health.v1.Health/*", "grpc.reflection.v1.ServerReflection/*"],
});

// ---------------------------------------------------------------------------
// Authorization Rules
// ---------------------------------------------------------------------------
const authz = createAuthzInterceptor({
    defaultPolicy: "deny",
    rules: [
        {
            name: "public",
            methods: ["greeter.v1.GreeterService/SayHello", "test.v1.TestService/*", "grpc.health.v1.Health/*", "grpc.reflection.v1.ServerReflection/*"],
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
    skipMethods: ["greeter.v1.GreeterService/SayHello", "test.v1.TestService/*", "grpc.health.v1.Health/*", "grpc.reflection.v1.ServerReflection/*"],
});

// ---------------------------------------------------------------------------
// Server (ALL packages enabled)
// ---------------------------------------------------------------------------
const port = Number(process.env.PORT) || 5000;
const allowHTTP1 = process.env.ALLOW_HTTP1 !== "false";
const tlsDir = process.env.TLS_DIR;

const server = createServer({
    services: [greeterServiceRoutes, testServiceRoutes],
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
    healthcheckManager.update(ServingStatus.SERVING, "greeter.v1.GreeterService");
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
