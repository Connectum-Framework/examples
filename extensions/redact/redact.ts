/**
 * Redact interceptor example
 *
 * Demonstrates sensitive data redaction for RPC responses.
 * This is domain-specific code — not part of the core framework.
 *
 * @module redact
 */

import { getOption } from "@bufbuild/protobuf";
import type { DescMessage, DescMethod } from "@bufbuild/protobuf";
import type { Interceptor } from "@connectrpc/connect";
import { sensitive, useSensitive } from "./extensions.ts";

interface RedactOptions {
    skipStreaming?: boolean;
}

/**
 * Redact sensitive data from message
 */
export function redact<T extends Record<string, unknown>>(schema: DescMessage, message: T): T {
    for (const field of schema.fields) {
        // biome-ignore lint/suspicious/noExplicitAny: Temporary workaround until proper proto extension is generated
        if (getOption(field, sensitive as any)) {
            delete message[field.localName];
        }
    }
    return message;
}

/**
 * Check if RPC method uses sensitive data redaction
 */
export function rpcCheck(rpc: DescMethod): boolean {
    // biome-ignore lint/suspicious/noExplicitAny: Temporary workaround until proper proto extension is generated
    const option = getOption(rpc, useSensitive as any);
    return option === true;
}

/**
 * Create redact interceptor
 */
export function createRedactInterceptor(options: RedactOptions = {}): Interceptor {
    const { skipStreaming = true } = options;

    return (next) => async (req) => {
        if (!rpcCheck(req.method)) {
            return await next(req);
        }

        if (!req.stream) {
            redact(req.method.input, req.message as Record<string, unknown>);
        }

        const res = await next(req);

        if (skipStreaming && res.stream) {
            return res;
        }

        redact(res.method.output, res.message as Record<string, unknown>);

        return res;
    };
}
