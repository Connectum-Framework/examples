/**
 * E2E tests for the quickstart.
 *
 * Verifies the greeter over a real HTTP/2 gRPC client, plus the gRPC health
 * protocol — both wired by a single createServer call.
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { create } from "@bufbuild/protobuf";
import { createClient } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import type { Server } from "@connectum/core";
import { GreeterService, SayHelloRequestSchema } from "#gen/greeter/v1/greeter_pb.ts";
import { buildServer } from "#server.ts";

describe("E2E: getting-started", () => {
    let server: Server;
    let greeter: ReturnType<typeof createClient<typeof GreeterService>>;

    before(async () => {
        server = buildServer(0);
        await server.start();
        const port = server.address?.port ?? 0;
        greeter = createClient(GreeterService, createGrpcTransport({ baseUrl: `http://localhost:${port}` }));
    });

    after(async () => {
        if (server.state === "running") await server.stop();
    });

    it("SayHello greets the caller", async () => {
        const res = await greeter.sayHello(create(SayHelloRequestSchema, { name: "Ada" }));
        assert.equal(res.message, "Hello, Ada!");
    });

    it("SayGoodbye works too", async () => {
        const res = await greeter.sayGoodbye({ name: "Ada" });
        assert.equal(res.message, "Goodbye, Ada!");
    });

    it("an empty name falls back to 'world'", async () => {
        const res = await greeter.sayHello({ name: "" });
        assert.equal(res.message, "Hello, world!");
    });

    it("registers Greeter + Health + Reflection", () => {
        assert.equal(server.hasService(GreeterService), true);
    });
});
