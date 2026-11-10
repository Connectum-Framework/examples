import { AmqpTopologyError } from "@connectum/events-amqp";
import type { AmqpLifecycleEvent } from "@connectum/events-amqp";

/**
 * Name the broker object a topology error refused: the error class says why the
 * setup failed, `object` says what it failed on, and an operator acts on the
 * second half.
 */
function refusedObject(error: Error): string {
    if (!(error instanceof AmqpTopologyError) || error.object === undefined) {
        return "";
    }
    const object = error.object;
    if (object.kind === "binding") {
        return ` (binding ${object.source} -> ${object.destination} ${object.destinationType}, routing key '${object.routingKey}')`;
    }
    return ` (${object.kind} '${object.name}')`;
}

/**
 * Log topology setup failures only. At boot one explains a rejected start; on a
 * reconnect one is the reason the adapter cannot re-apply its topology and
 * keeps retrying. Logging every lifecycle event instead would bury the saga
 * output an example reader follows.
 */
export function logSetupFailures(service: string): (event: AmqpLifecycleEvent) => void {
    return (event) => {
        if (event.type !== "setup-failed") {
            return;
        }
        const phase = event.initial ? "initial setup" : `reconnect attempt ${event.attempt}`;
        console.error(`[${service}] setup-failed during ${phase}: ${event.error.name}${refusedObject(event.error)}: ${event.error.message}`);
    };
}

/**
 * A start rejected by the broker must leave a process that exits non-zero with
 * the error class and the refused object visible. The server's own "error"
 * listener has already printed the full error and its stack: @connectum/core
 * emits that event for every failed start() when a listener exists. This adds
 * the one line an operator scans for instead of repeating the stack.
 */
export function reportStartupFailure(service: string, error: unknown): void {
    const failed = error instanceof Error ? error : new Error(String(error));
    console.error(`${service} cannot start: ${failed.name}${refusedObject(failed)}`);
    process.exitCode = 1;
}
