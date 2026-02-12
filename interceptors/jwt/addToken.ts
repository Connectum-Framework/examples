/**
 * JWT token interceptor example
 *
 * Automatically adds JWT token to Authorization header.
 * This is domain-specific code — not part of the core framework.
 *
 * @module addToken
 */

import type { Interceptor } from "@connectrpc/connect";

interface AddTokenOptions {
    token: string;
    skipIfExists?: boolean;
}

/**
 * Create add token interceptor
 *
 * Primarily designed for CLIENT-SIDE usage.
 */
export function createAddTokenInterceptor(options: AddTokenOptions): Interceptor {
    const { token, skipIfExists = true } = options;

    return (next) => async (req) => {
        if (!skipIfExists || !req.header.has("Authorization")) {
            req.header.set("Authorization", `Bearer ${token}`);
        }

        return await next(req);
    };
}
