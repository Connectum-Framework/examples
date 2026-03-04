/**
 * API Key Authentication Interceptor
 *
 * Validates the `x-api-key` header for the SecureEcho RPC method.
 * All other methods pass through without authentication.
 *
 * @module apiKeyInterceptor
 */

import type { Interceptor } from "@connectrpc/connect";
import { Code, ConnectError } from "@connectrpc/connect";

/** Hardcoded API key for example purposes */
const VALID_API_KEY = "test-api-key-123";

/**
 * Create an API key authentication interceptor.
 *
 * Only the `SecureEcho` method requires a valid `x-api-key` header.
 * All other methods are passed through without any authentication check.
 *
 * @returns ConnectRPC interceptor
 *
 * @example
 * ```typescript
 * import { createServer } from '@connectum/core';
 * import { apiKeyInterceptor } from './interceptors/apiKeyInterceptor.ts';
 *
 * const server = createServer({
 *   services: [echoServiceRoutes],
 *   interceptors: [apiKeyInterceptor],
 * });
 * ```
 */
export const apiKeyInterceptor: Interceptor = (next) => async (req) => {
    // Only check API key for SecureEcho method
    if (req.method.name !== "SecureEcho") {
        return await next(req);
    }

    const apiKey = req.header.get("x-api-key");

    if (!apiKey || apiKey !== VALID_API_KEY) {
        throw new ConnectError("Invalid or missing API key", Code.Unauthenticated);
    }

    return await next(req);
};
