/**
 * gRPC call tests
 *
 * Verifies that gRPC SayHello and SayGoodbye RPCs work correctly
 * through the compiled @connectum/* packages.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { createServer } from "@connectum/core";
import type { Server } from "@connectum/core";
import { createDefaultInterceptors } from "@connectum/interceptors";
import { createGrpcTransport } from "@connectrpc/connect-node";
import { createClient } from "@connectrpc/connect";
import { GreeterService } from "#gen/greeter/v1/greeter_pb.ts";
import { greeterServiceRoutes } from "#services/greeterService.ts";

describe("gRPC calls", () => {
    let server: Server;
    let client: ReturnType<typeof createClient<typeof GreeterService>>;

    before(async () => {
        server = createServer({
            services: [greeterServiceRoutes],
            port: 0,
            interceptors: createDefaultInterceptors(),
            allowHTTP1: false,
        });
        await server.start();

        const port = server.address!.port;
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

    it("should handle SayHello with a name", async () => {
        const response = await client.sayHello({ name: "TestUser" });
        assert.strictEqual(response.message, "Hello, TestUser!");
    });

    it("should handle SayHello with empty name (defaults to World)", async () => {
        const response = await client.sayHello({ name: "" });
        assert.strictEqual(response.message, "Hello, World!");
    });

    it("should handle SayGoodbye with a name", async () => {
        const response = await client.sayGoodbye({ name: "TestUser" });
        assert.strictEqual(response.message, "Goodbye, TestUser! See you soon!");
    });

    it("should handle SayGoodbye with empty name (defaults to World)", async () => {
        const response = await client.sayGoodbye({ name: "" });
        assert.strictEqual(response.message, "Goodbye, World! See you soon!");
    });
});
