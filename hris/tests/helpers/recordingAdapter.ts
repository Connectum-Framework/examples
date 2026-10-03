/**
 * A `MemoryAdapter` that also records the topic of every publish.
 *
 * The bus decides the topic before it reaches the adapter, so the recorded list
 * is exactly what a real broker would have been asked to publish to — which is
 * what the topic-resolution tests need to assert, rather than the topic a test
 * expects the bus to compute.
 *
 * @module tests/helpers/recordingAdapter
 */

import { MemoryAdapter } from "@connectum/events";
import type { EventAdapter } from "@connectum/events";

/**
 * Build the recording adapter.
 *
 * @param published - Receives each published topic, in publish order.
 */
export function recordingAdapter(published: string[]): EventAdapter {
    const inner = MemoryAdapter();
    return {
        name: inner.name,
        connect: (context) => inner.connect(context),
        disconnect: () => inner.disconnect(),
        publish: async (eventType, payload, options) => {
            published.push(eventType);
            await inner.publish(eventType, payload, options);
        },
        subscribe: (patterns, handler, options) => inner.subscribe(patterns, handler, options),
    };
}
