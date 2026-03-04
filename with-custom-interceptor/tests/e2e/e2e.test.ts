/**
 * E2E Tests for Custom Interceptor Example
 *
 * Starts a real ConnectRPC server and verifies:
 * - Echo service basic calls
 * - API key authentication interceptor (SecureEcho)
 * - Rate limiting interceptor (RateLimitedEcho)
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "@connectum/core";
import type { Server } from "@connectum/core";
import { createDefaultInterceptors } from "@connectum/interceptors";
import { createGrpcTransport } from "@connectrpc/connect-node";
import { Code, ConnectError, createClient } from "@connectrpc/connect";
import { EchoService } from "#gen/echo/v1/echo_pb.ts";
import { echoServiceRoutes } from "#services/echoService.ts";
import { apiKeyInterceptor } from "#interceptors/apiKeyInterceptor.ts";
import {
    rateLimitInterceptor,
    resetRateLimits,
} from "#interceptors/rateLimitInterceptor.ts";

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("E2E: Custom Interceptors", () => {
    let server: Server;
    let port: number;
    let client: ReturnType<typeof createClient<typeof EchoService>>;

    before(async () => {
        server = createServer({
            services: [echoServiceRoutes],
            port: 0,
            interceptors: [
                ...createDefaultInterceptors(),
                apiKeyInterceptor,
                rateLimitInterceptor,
            ],
            allowHTTP1: false,
        });

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

    // -----------------------------------------------------------------------
    // 1. Echo service (no protection)
    // -----------------------------------------------------------------------

    describe("Echo service", () => {
        it("Echo with message", async () => {
            const response = await client.echo({ message: "Hello" });
            assert.equal(response.message, "Hello");
            assert.equal(typeof response.timestamp, "bigint");
        });

        it("Echo empty message defaults to Echo!", async () => {
            const response = await client.echo({ message: "" });
            assert.equal(response.message, "Echo!");
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

    // -----------------------------------------------------------------------
    // 3. Rate Limiting (RateLimitedEcho)
    // -----------------------------------------------------------------------

    describe("Rate Limiting (RateLimitedEcho)", () => {
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
