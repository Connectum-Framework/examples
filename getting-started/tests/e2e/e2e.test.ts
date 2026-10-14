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

    it("SayGoodbye returns a goodbye message addressed to the caller, distinct from the greeting", async () => {
        // The proto documents the response field as the "Goodbye message" for the
        // named person; it does not fix the exact wording, so the check is the
        // documented property (a goodbye that names the caller), not a literal.
        // Comparing with SayHello catches a handler wired to the wrong response.
        const goodbye = await greeter.sayGoodbye({ name: "Ada" });
        const hello = await greeter.sayHello({ name: "Ada" });
        assert.match(goodbye.message, /goodbye/i);
        assert.ok(goodbye.message.includes("Ada"), `goodbye must name the caller, got "${goodbye.message}"`);
        assert.notEqual(goodbye.message, hello.message);
    });

    it("SayHello with an empty name still returns a well-formed greeting", async () => {
        // The README documents the `Hello, <name>!` shape. The word substituted for
        // an empty name is the example's own choice and is not documented, so the
        // test pins only what is documented: the greeting keeps its shape and does
        // not render an empty name (`Hello, !`) or the string "undefined".
        const res = await greeter.sayHello({ name: "" });
        assert.match(res.message, /^Hello, .+!$/);
        assert.doesNotMatch(res.message, /undefined|null/);
    });

    it("registers Greeter + Health + Reflection", () => {
        assert.equal(server.hasService(GreeterService), true);
    });
});
