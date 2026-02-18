/**
 * Server lifecycle tests
 *
 * Verifies that the server starts, reaches running state,
 * exposes a valid address, and can be stopped.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { createServer } from "@connectum/core";
import type { Server } from "@connectum/core";
import { createHealthcheckManager, Healthcheck, ServingStatus } from "@connectum/healthcheck";
import { createDefaultInterceptors } from "@connectum/interceptors";
import { Reflection } from "@connectum/reflection";
import { greeterServiceRoutes } from "#services/greeterService.ts";

describe("Server lifecycle", () => {
    let server: Server;

    before(async () => {
        const manager = createHealthcheckManager();
        server = createServer({
            services: [greeterServiceRoutes],
            port: 0,
            protocols: [Healthcheck({ httpEnabled: true, manager }), Reflection()],
            interceptors: createDefaultInterceptors(),
            allowHTTP1: false,
        });
        server.on("ready", () => {
            manager.update(ServingStatus.SERVING);
        });
        await server.start();
    });

    after(async () => {
        if (server.state === "running") {
            await server.stop();
        }
    });

    it("should be in running state after start", () => {
        assert.strictEqual(server.state, "running");
    });

    it("should have a valid address with port > 0", () => {
        assert.ok(server.address, "Server address should not be null");
        assert.ok(server.address.port > 0, `Port should be > 0, got ${server.address.port}`);
    });

    it("should report isRunning as true", () => {
        assert.strictEqual(server.isRunning, true);
    });
});
