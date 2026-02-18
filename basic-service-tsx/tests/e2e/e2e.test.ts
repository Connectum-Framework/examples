/**
 * E2E Tests for Basic Service
 *
 * Starts a real ConnectRPC server and verifies:
 * - gRPC service calls (SayHello, SayGoodbye)
 * - Health check via gRPC protocol (grpc.health.v1.Health/Check)
 * - Health check via HTTP endpoints (/healthz, /readyz)
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
import { createGrpcTransport } from "@connectrpc/connect-node";
import { createClient } from "@connectrpc/connect";
import { GreeterService } from "#gen/greeter/v1/greeter_pb.ts";
import { greeterServiceRoutes } from "#services/greeterService.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Make an HTTP/2 GET request, return status and body string.
 */
function http2Get(url: string): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
        const parsedUrl = new URL(url);
        const client = http2.connect(parsedUrl.origin);

        client.on("error", reject);

        const req = client.request({
            ":method": "GET",
            ":path": parsedUrl.pathname,
        });

        let data = "";
        let status = 0;

        req.on("response", (headers) => {
            status = Number(headers[":status"]);
        });

        req.on("data", (chunk: Buffer) => {
            data += chunk.toString();
        });

        req.on("end", () => {
            client.close();
            resolve({ status, body: data });
        });

        req.on("error", (err: Error) => {
            client.close();
            reject(err);
        });

        req.end();
    });
}

/**
 * Make a Connect protocol POST request over HTTP/2, return status and parsed JSON body.
 */
function connectPost(
    port: number,
    method: string,
    body: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
    return new Promise((resolve, reject) => {
        const client = http2.connect(`http://localhost:${port}`);
        client.on("error", reject);

        const req = client.request({
            ":method": "POST",
            ":path": `/${method}`,
            "content-type": "application/json",
        });

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

        req.write(JSON.stringify(body));
        req.end();
    });
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("E2E: Basic Service", () => {
    let server: Server;
    let port: number;
    let manager: HealthcheckManager;
    let client: ReturnType<typeof createClient<typeof GreeterService>>;

    before(async () => {
        manager = createHealthcheckManager();
        server = createServer({
            services: [greeterServiceRoutes],
            port: 0,
            protocols: [Healthcheck({ httpEnabled: true, manager }), Reflection()],
            interceptors: createDefaultInterceptors(),
        });

        server.on("ready", () => {
            manager.update(ServingStatus.SERVING);
        });

        await server.start();
        port = server.address!.port;

        const transport = createGrpcTransport({
            baseUrl: `http://localhost:${port}`,
        });
        client = createClient(GreeterService, transport);
    });

    after(async () => {
        if (server.state === "running") {
            await server.stop();
        }
    });

    // -----------------------------------------------------------------------
    // 1. ConnectRPC service calls
    // -----------------------------------------------------------------------

    describe("ConnectRPC service calls", () => {
        it("SayHello with name", async () => {
            const response = await client.sayHello({ name: "TestUser" });
            assert.equal(response.message, "Hello, TestUser!");
        });

        it("SayHello empty name defaults to World", async () => {
            const response = await client.sayHello({ name: "" });
            assert.equal(response.message, "Hello, World!");
        });

        it("SayGoodbye with name", async () => {
            const response = await client.sayGoodbye({ name: "TestUser" });
            assert.equal(response.message, "Goodbye, TestUser! See you soon!");
        });

        it("SayGoodbye empty name defaults to World", async () => {
            const response = await client.sayGoodbye({ name: "" });
            assert.equal(response.message, "Goodbye, World! See you soon!");
        });
    });

    // -----------------------------------------------------------------------
    // 2. Healthcheck via ConnectRPC (gRPC protocol)
    // -----------------------------------------------------------------------

    describe("Healthcheck via ConnectRPC", () => {
        it("Health/Check returns SERVING", async () => {
            const result = await connectPost(
                port,
                "grpc.health.v1.Health/Check",
                {},
            );

            assert.equal(result.status, 200);
            assert.equal(result.body.status, "SERVING");
        });
    });

    // -----------------------------------------------------------------------
    // 3. Healthcheck via HTTP
    // -----------------------------------------------------------------------

    describe("Healthcheck via HTTP", () => {
        it("GET /healthz returns 200 SERVING", async () => {
            const { status, body } = await http2Get(`http://localhost:${port}/healthz`);
            assert.equal(status, 200);
            const json = JSON.parse(body);
            assert.equal(json.status, "SERVING");
        });

        it("GET /readyz returns 200 SERVING", async () => {
            const { status, body } = await http2Get(`http://localhost:${port}/readyz`);
            assert.equal(status, 200);
            const json = JSON.parse(body);
            assert.equal(json.status, "SERVING");
        });
    });
});
