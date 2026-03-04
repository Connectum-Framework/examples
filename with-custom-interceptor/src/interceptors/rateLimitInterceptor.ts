/**
 * Rate Limit Interceptor
 *
 * Limits request rate for the RateLimitedEcho RPC method using
 * a sliding window counter per client IP address.
 *
 * @module rateLimitInterceptor
 */

import type { Interceptor } from "@connectrpc/connect";
import { Code, ConnectError } from "@connectrpc/connect";

/** Rate limit window in milliseconds (60 seconds) */
const WINDOW_MS = 60_000;

/** Maximum requests allowed per window */
const MAX_REQUESTS = 5;

/** Per-client rate limit state */
interface RateLimitEntry {
    count: number;
    windowStart: number;
}

/** In-memory rate limit store keyed by client identifier */
const rateLimitStore = new Map<string, RateLimitEntry>();

/**
 * Reset all rate limit counters.
 *
 * Useful for testing to ensure a clean state between test runs.
 */
export function resetRateLimits(): void {
    rateLimitStore.clear();
}

/**
 * Extract client identifier from request headers.
 *
 * Checks common proxy headers for the real client IP,
 * falling back to "global" if none are available.
 *
 * @param headers - Request headers
 * @returns Client identifier string
 */
function getClientId(headers: Headers): string {
    return (
        headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
        headers.get("x-real-ip") ||
        "global"
    );
}

/**
 * Rate limit interceptor for the RateLimitedEcho method.
 *
 * Uses a fixed-window counter algorithm:
 * - Each client gets up to {@link MAX_REQUESTS} requests per {@link WINDOW_MS} window
 * - Clients are identified by IP address (from proxy headers) or "global" fallback
 * - Only the `RateLimitedEcho` method is rate-limited; all others pass through
 *
 * @example
 * ```typescript
 * import { createServer } from '@connectum/core';
 * import { rateLimitInterceptor } from './interceptors/rateLimitInterceptor.ts';
 *
 * const server = createServer({
 *   services: [echoServiceRoutes],
 *   interceptors: [rateLimitInterceptor],
 * });
 * ```
 */
export const rateLimitInterceptor: Interceptor = (next) => async (req) => {
    // Only rate-limit the RateLimitedEcho method
    if (req.method.name !== "RateLimitedEcho") {
        return await next(req);
    }

    const clientId = getClientId(req.header);
    const now = Date.now();

    let entry = rateLimitStore.get(clientId);

    // Reset window if expired or no entry exists
    if (!entry || now - entry.windowStart >= WINDOW_MS) {
        entry = { count: 0, windowStart: now };
        rateLimitStore.set(clientId, entry);
    }

    entry.count++;

    if (entry.count > MAX_REQUESTS) {
        throw new ConnectError("Rate limit exceeded", Code.ResourceExhausted);
    }

    return await next(req);
};
