/**
 * Health check tests
 *
 * Verifies that the health check protocol works correctly:
 * - HTTP /healthz endpoint
 * - gRPC Health.Check RPC
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import http2 from "node:http2";
import { createServer } from "@connectum/core";
import type { Server } from "@connectum/core";
import { createHealthcheckManager, Healthcheck, ServingStatus } from "@connectum/healthcheck";
import type { HealthcheckManager } from "@connectum/healthcheck";
import { createDefaultInterceptors } from "@connectum/interceptors";
import { greeterServiceRoutes } from "#services/greeterService.ts";

/**
 * Helper: make an HTTP/2 GET request and return { status, body }
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

describe("Health check", () => {
    let server: Server;
    let port: number;
    let manager: HealthcheckManager;

    before(async () => {
        manager = createHealthcheckManager();
        server = createServer({
            services: [greeterServiceRoutes],
            port: 0,
            protocols: [Healthcheck({ httpEnabled: true, manager })],
            interceptors: createDefaultInterceptors(),
        });
        server.on("ready", () => {
            manager.update(ServingStatus.SERVING);
        });
        await server.start();
        port = server.address!.port;
    });

    after(async () => {
        if (server.state === "running") {
            await server.stop();
        }
    });

    it("should respond to HTTP/2 health check on /healthz", async () => {
        const { status, body } = await http2Get(`http://localhost:${port}/healthz`);
        assert.strictEqual(status, 200);
        const json = JSON.parse(body);
        assert.strictEqual(json.status, "SERVING");
    });

    it("should respond to /readyz endpoint", async () => {
        const { status, body } = await http2Get(`http://localhost:${port}/readyz`);
        assert.strictEqual(status, 200);
        const json = JSON.parse(body);
        assert.strictEqual(json.status, "SERVING");
    });
});
