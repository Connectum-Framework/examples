/**
 * E2E tests for the quickstart.
 *
 * Verifies the greeter over a real HTTP/2 gRPC client, plus the gRPC health
 * protocol — both wired by a single createServer call.
 */

import assert from "node:assert/strict";
import http2 from "node:http2";
import { after, afterEach, before, describe, it } from "node:test";
import { create } from "@bufbuild/protobuf";
import { Code, createClient } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import type { Server } from "@connectum/core";
import { healthcheckManager, ServingStatus } from "@connectum/healthcheck";
import { GreeterService, SayHelloRequestSchema } from "#gen/greeter/v1/greeter_pb.ts";
import { buildServer } from "#server.ts";

describe("E2E: getting-started", () => {
    let server: Server;
    let greeter: ReturnType<typeof createClient<typeof GreeterService>>;
    const port = () => server.address?.port ?? 0;

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

    it("mounts the Greeter service", () => {
        assert.equal(server.hasService(GreeterService), true);
    });

    describe("health and reflection protocols", () => {
        afterEach(() => {
            healthcheckManager.update(ServingStatus.UNKNOWN);
        });

        it("grpc.health.v1.Health/Check answers SERVING, then NOT_SERVING, for the whole server", async () => {
            // Wire format of grpc.health.v1.HealthCheckResponse: field 1 (status, varint).
            // SERVING = 1, NOT_SERVING = 2 (gRPC health checking protocol).
            healthcheckManager.update(ServingStatus.SERVING);
            const serving = await grpcUnary(port(), "/grpc.health.v1.Health/Check", EMPTY_MESSAGE);
            assert.equal(serving.grpcStatus, "0");
            assert.deepEqual([...serving.body], [0, 0, 0, 0, 2, 0x08, 1]);

            healthcheckManager.update(ServingStatus.NOT_SERVING);
            const notServing = await grpcUnary(port(), "/grpc.health.v1.Health/Check", EMPTY_MESSAGE);
            assert.equal(notServing.grpcStatus, "0");
            assert.deepEqual([...notServing.body], [0, 0, 0, 0, 2, 0x08, 2]);
        });

        it("grpc.health.v1.Health/Check for an unregistered service is NOT_FOUND", async () => {
            // HealthCheckRequest.service = field 1 (string).
            const name = Buffer.from("no.such.v1.Service");
            const res = await grpcUnary(port(), "/grpc.health.v1.Health/Check", frame(Buffer.concat([Buffer.from([0x0a, name.length]), name])));
            assert.equal(res.grpcStatus, String(Code.NotFound));
        });

        it("/healthz maps the serving status to the documented HTTP code and body", async () => {
            healthcheckManager.update(ServingStatus.SERVING);
            const up = await httpGet(port(), "/healthz");
            assert.equal(up.status, 200);
            assert.equal(JSON.parse(up.body).status, "SERVING");
            assert.equal(JSON.parse(up.body).service, "overall");

            healthcheckManager.update(ServingStatus.NOT_SERVING);
            const down = await httpGet(port(), "/healthz");
            assert.equal(down.status, 503);
            assert.equal(JSON.parse(down.body).status, "NOT_SERVING");

            const unknown = await httpGet(port(), "/healthz?service=no.such.v1.Service");
            assert.equal(unknown.status, 404);
            assert.equal(JSON.parse(unknown.body).status, "SERVICE_UNKNOWN");
        });

        it("grpc.reflection.v1.ServerReflection lists the greeter and health services, and not itself", async () => {
            // ServerReflectionRequest.list_services = field 7 (string), tag 0x3a, empty value.
            // A successful answer proves Reflection() is mounted. The listing holds the
            // application services and the protocols registered before Reflection(); the
            // reflection service itself is documented as not listed.
            const res = await grpcUnary(port(), "/grpc.reflection.v1.ServerReflection/ServerReflectionInfo", frame(Buffer.from([0x3a, 0])));
            assert.equal(res.grpcStatus, "0");
            for (const name of ["greeter.v1.GreeterService", "grpc.health.v1.Health"]) {
                assert.ok(res.body.includes(Buffer.from(name)), `reflection must list ${name}`);
            }
            assert.ok(!res.body.includes(Buffer.from("grpc.reflection.v1.ServerReflection")), "reflection must not list itself");
        });
    });
});

/** A gRPC length-prefixed message: 1 byte compression flag + 4 byte big-endian length + payload. */
function frame(payload: Buffer): Buffer {
    const header = Buffer.alloc(5);
    header.writeUInt32BE(payload.length, 1);
    return Buffer.concat([header, payload]);
}

const EMPTY_MESSAGE = frame(Buffer.alloc(0));

interface RawGrpcResult {
    grpcStatus: string | undefined;
    body: Buffer;
}

/** Sends one framed message over plaintext HTTP/2 and returns the response body plus grpc-status. */
function grpcUnary(port: number, path: string, message: Buffer): Promise<RawGrpcResult> {
    return new Promise((resolve, reject) => {
        const session = http2.connect(`http://localhost:${port}`);
        session.on("error", reject);
        const req = session.request({ ":method": "POST", ":path": path, "content-type": "application/grpc", te: "trailers" });
        const chunks: Buffer[] = [];
        let grpcStatus: string | undefined;
        req.on("response", (headers) => {
            // Trailers-only responses carry grpc-status in the headers.
            if (headers["grpc-status"] !== undefined) grpcStatus = String(headers["grpc-status"]);
        });
        req.on("trailers", (trailers) => {
            if (trailers["grpc-status"] !== undefined) grpcStatus = String(trailers["grpc-status"]);
        });
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("error", reject);
        req.on("close", () => {
            session.close();
            resolve({ grpcStatus, body: Buffer.concat(chunks) });
        });
        req.end(message);
    });
}

/** GET over plaintext HTTP/2 (the server is h2c-only; HTTP/1.1 is disabled). */
function httpGet(port: number, path: string): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
        const session = http2.connect(`http://localhost:${port}`);
        session.on("error", reject);
        const req = session.request({ ":method": "GET", ":path": path });
        let status = 0;
        let body = "";
        req.setEncoding("utf8");
        req.on("response", (headers) => {
            status = Number(headers[":status"]);
        });
        req.on("data", (chunk: string) => {
            body += chunk;
        });
        req.on("error", reject);
        req.on("close", () => {
            session.close();
            resolve({ status, body });
        });
        req.end();
    });
}
