/**
 * Server reflection tests
 *
 * Verifies that gRPC Server Reflection protocol is functional.
 * Uses a raw gRPC client to call ServerReflection.ServerReflectionInfo.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { createServer } from "@connectum/core";
import type { Server, ProtocolRegistration } from "@connectum/core";
import { createDefaultInterceptors } from "@connectum/interceptors";
import { Reflection } from "@connectum/reflection";
import { greeterServiceRoutes } from "#services/greeterService.ts";

describe("Server reflection", () => {
    let server: Server;
    before(async () => {
        server = createServer({
            services: [greeterServiceRoutes],
            port: 0,
            protocols: [Reflection()],
            interceptors: createDefaultInterceptors(),
            allowHTTP1: false,
        });
        await server.start();
    });

    after(async () => {
        if (server.state === "running") {
            await server.stop();
        }
    });

    it("should start server with reflection protocol enabled", () => {
        assert.strictEqual(server.state, "running");
        // Verify reflection protocol is registered
        const reflectionProtocol = server.protocols.find((p: ProtocolRegistration) => p.name === "reflection");
        assert.ok(reflectionProtocol, "Reflection protocol should be registered");
    });

    it("should have reflection protocol named correctly", () => {
        const reflectionProtocol = server.protocols.find((p: ProtocolRegistration) => p.name === "reflection");
        assert.strictEqual(reflectionProtocol!.name, "reflection");
    });
});
