/**
 * E2E Tests for Custom Interceptor Example
 *
 * Starts a real ConnectRPC server and verifies:
 * - Echo service basic calls
 * - API key authentication interceptor (SecureEcho)
 * - Rate limiting interceptor (RateLimitedEcho)
 */

import { describe, it, before, after, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "@connectum/core";
import { createGrpcTransport } from "@connectrpc/connect-node";
import { Code, ConnectError, createClient } from "@connectrpc/connect";
import { EchoService } from "#gen/echo/v1/echo_pb.ts";
import { resetRateLimits } from "#interceptors/rateLimitInterceptor.ts";
import { buildServer } from "#server.ts";

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("E2E: Custom Interceptors", () => {
    let server: Server;
    let port: number;
    let client: ReturnType<typeof createClient<typeof EchoService>>;

    before(async () => {
        // The same composition root `src/index.ts` starts, on an ephemeral port.
        server = buildServer(0);

        await server.start();
        port = server.address!.port;

        const transport = createGrpcTransport({
            baseUrl: `http://localhost:${port}`,
        });
        client = createClient(EchoService, transport);
    });

    after(async () => {
        if (server.state === "running") {
            await server.stop();
        }
    });

    /** A client that sends the given request headers on every call. */
    function clientWithHeaders(headers: Record<string, string>) {
        return createClient(
            EchoService,
            createGrpcTransport({
                baseUrl: `http://localhost:${port}`,
                interceptors: [
                    (next) => async (req) => {
                        for (const [name, value] of Object.entries(headers)) {
                            req.header.set(name, value);
                        }
                        return await next(req);
                    },
                ],
            }),
        );
    }

    // -----------------------------------------------------------------------
    // 1. Echo service (no protection)
    // -----------------------------------------------------------------------

    describe("Echo service", () => {
        it("Echo with message", async () => {
            // The proto documents `timestamp` as Unix epoch milliseconds, so the
            // reply must carry a time inside the window of the call.
            const before = BigInt(Date.now());
            const response = await client.echo({ message: "Hello" });
            const after = BigInt(Date.now());
            assert.equal(response.message, "Hello");
            assert.ok(
                response.timestamp >= before && response.timestamp <= after,
                `timestamp ${response.timestamp} must be epoch milliseconds within [${before}, ${after}]`,
            );
        });

        it("Echo with an empty message returns an empty message and a timestamp", async () => {
            // The proto says Echo "returns the same message it receives": an empty
            // message comes back empty, not replaced by a placeholder.
            const before = BigInt(Date.now());
            const response = await client.echo({ message: "" });
            const after = BigInt(Date.now());
            assert.equal(response.message, "");
            assert.ok(response.timestamp >= before && response.timestamp <= after);
        });

        it("Echo is neither protected by the API key nor throttled by the rate limit", async () => {
            // The protection is documented per method (SecureEcho / RateLimitedEcho);
            // a plain Echo must keep answering well past the rate-limit threshold
            // without any credential.
            resetRateLimits();
            for (let i = 0; i < 8; i++) {
                const response = await client.echo({ message: `plain ${i}` });
                assert.equal(response.message, `plain ${i}`);
            }
        });
    });

    // -----------------------------------------------------------------------
    // 2. API Key Authentication (SecureEcho)
    // -----------------------------------------------------------------------

    describe("API Key Authentication (SecureEcho)", () => {
        it("SecureEcho with valid API key", async () => {
            const transportWithAuth = createGrpcTransport({
                baseUrl: `http://localhost:${port}`,
                interceptors: [
                    (next) => async (req) => {
                        req.header.set("x-api-key", "test-api-key-123");
                        return await next(req);
                    },
                ],
            });
            const authClient = createClient(EchoService, transportWithAuth);

            const response = await authClient.secureEcho({
                message: "Secret",
            });
            assert.equal(response.message, "Secret");
            assert.equal(typeof response.timestamp, "bigint");
        });

        it("SecureEcho without API key rejects with Unauthenticated", async () => {
            try {
                await client.secureEcho({ message: "No key" });
                assert.fail("Expected ConnectError");
            } catch (err) {
                assert.ok(err instanceof ConnectError);
                assert.equal(err.code, Code.Unauthenticated);
            }
        });

        it("SecureEcho with invalid API key rejects with Unauthenticated", async () => {
            const transportWithBadKey = createGrpcTransport({
                baseUrl: `http://localhost:${port}`,
                interceptors: [
                    (next) => async (req) => {
                        req.header.set("x-api-key", "wrong-key");
                        return await next(req);
                    },
                ],
            });
            const badKeyClient = createClient(
                EchoService,
                transportWithBadKey,
            );

            try {
                await badKeyClient.secureEcho({ message: "Bad key" });
                assert.fail("Expected ConnectError");
            } catch (err) {
                assert.ok(err instanceof ConnectError);
                assert.equal(err.code, Code.Unauthenticated);
            }
        });
    });

    describe("API key scope", () => {
        it("SecureEcho with an empty API key rejects with Unauthenticated", async () => {
            const emptyKeyClient = clientWithHeaders({ "x-api-key": "" });
            await assert.rejects(emptyKeyClient.secureEcho({ message: "Empty key" }), (err: unknown) => {
                assert.ok(err instanceof ConnectError);
                assert.equal(err.code, Code.Unauthenticated);
                return true;
            });
        });

        it("a wrong API key does not block the unprotected methods", async () => {
            // Only SecureEcho is protected: the other two methods must answer even
            // when the caller sends a key the server would reject on SecureEcho.
            resetRateLimits();
            const badKeyClient = clientWithHeaders({ "x-api-key": "wrong-key" });
            assert.equal((await badKeyClient.echo({ message: "a" })).message, "a");
            assert.equal((await badKeyClient.rateLimitedEcho({ message: "b" })).message, "b");
        });
    });

    // -----------------------------------------------------------------------
    // 3. Rate Limiting (RateLimitedEcho)
    // -----------------------------------------------------------------------

    describe("Rate Limiting (RateLimitedEcho)", () => {
        afterEach(() => {
            mock.timers.reset();
            resetRateLimits();
        });

        it("the limit is per client: exhausting one client does not throttle another", async () => {
            // The README documents the limit as five requests per client, with the
            // client taken from x-forwarded-for or x-real-ip.
            resetRateLimits();
            const clientA = clientWithHeaders({ "x-forwarded-for": "203.0.113.10" });
            const clientB = clientWithHeaders({ "x-forwarded-for": "203.0.113.20" });
            const clientC = clientWithHeaders({ "x-real-ip": "203.0.113.30" });

            for (let i = 0; i < 5; i++) {
                await clientA.rateLimitedEcho({ message: `A${i}` });
            }
            await assert.rejects(clientA.rateLimitedEcho({ message: "A5" }), (err: unknown) => {
                assert.ok(err instanceof ConnectError);
                assert.equal(err.code, Code.ResourceExhausted);
                return true;
            });

            assert.equal((await clientB.rateLimitedEcho({ message: "B0" })).message, "B0");
            assert.equal((await clientC.rateLimitedEcho({ message: "C0" })).message, "C0");
        });

        it("callers without a client header share one global counter", async () => {
            // README: requests without either header share the global counter.
            resetRateLimits();
            const anonymousOne = clientWithHeaders({});
            const anonymousTwo = clientWithHeaders({});
            for (let i = 0; i < 3; i++) {
                await anonymousOne.rateLimitedEcho({ message: `one ${i}` });
            }
            for (let i = 0; i < 2; i++) {
                await anonymousTwo.rateLimitedEcho({ message: `two ${i}` });
            }
            await assert.rejects(anonymousOne.rateLimitedEcho({ message: "sixth" }), (err: unknown) => {
                assert.ok(err instanceof ConnectError);
                assert.equal(err.code, Code.ResourceExhausted);
                return true;
            });
        });

        it("the limit applies only to RateLimitedEcho: an exhausted client can still call Echo and SecureEcho", async () => {
            resetRateLimits();
            const caller = clientWithHeaders({ "x-forwarded-for": "198.51.100.7", "x-api-key": "test-api-key-123" });
            for (let i = 0; i < 5; i++) {
                await caller.rateLimitedEcho({ message: `r${i}` });
            }
            await assert.rejects(caller.rateLimitedEcho({ message: "r5" }));

            assert.equal((await caller.echo({ message: "still plain" })).message, "still plain");
            assert.equal((await caller.secureEcho({ message: "still secure" })).message, "still secure");
        });

        it("the 60-second fixed window: still limited inside it, allowed again after it", async () => {
            resetRateLimits();
            mock.timers.enable({ apis: ["Date"], now: 1_700_000_000_000 });
            const caller = clientWithHeaders({ "x-forwarded-for": "192.0.2.55" });

            for (let i = 0; i < 5; i++) {
                await caller.rateLimitedEcho({ message: `w${i}` });
            }
            mock.timers.tick(59_000);
            await assert.rejects(caller.rateLimitedEcho({ message: "inside the window" }), (err: unknown) => {
                assert.ok(err instanceof ConnectError);
                assert.equal(err.code, Code.ResourceExhausted);
                return true;
            });

            mock.timers.tick(2_000);
            // A fresh window grants the full quota of five, not a single request.
            for (let i = 0; i < 5; i++) {
                const response = await caller.rateLimitedEcho({ message: `next ${i}` });
                assert.equal(response.message, `next ${i}`);
            }
            await assert.rejects(caller.rateLimitedEcho({ message: "next 5" }), (err: unknown) => {
                assert.ok(err instanceof ConnectError);
                assert.equal(err.code, Code.ResourceExhausted);
                return true;
            });
        });

        it("RateLimitedEcho within limit succeeds", async () => {
            resetRateLimits();

            const response = await client.rateLimitedEcho({
                message: "Rate me",
            });
            assert.equal(response.message, "Rate me");
            assert.equal(typeof response.timestamp, "bigint");
        });

        it("RateLimitedEcho exceeds limit after 5 requests", async () => {
            resetRateLimits();

            // First 5 requests should succeed
            for (let i = 0; i < 5; i++) {
                const response = await client.rateLimitedEcho({
                    message: `Request ${i + 1}`,
                });
                assert.equal(response.message, `Request ${i + 1}`);
            }

            // 6th request should be rate-limited
            try {
                await client.rateLimitedEcho({ message: "Request 6" });
                assert.fail("Expected ConnectError");
            } catch (err) {
                assert.ok(err instanceof ConnectError);
                assert.equal(err.code, Code.ResourceExhausted);
            }
        });
    });
});
