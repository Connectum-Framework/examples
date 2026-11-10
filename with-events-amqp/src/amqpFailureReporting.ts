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
 * the error class and the refused object visible. Node's uncaught-error output
 * carries the class and message but not the structured `object` field, which is
 * the part that names what to fix.
 */
export function reportStartupFailure(service: string, error: unknown): void {
    if (error instanceof AmqpTopologyError) {
        console.error(`${service} cannot start: ${error.name}${refusedObject(error)}: ${error.message}`);
    } else {
        console.error(`${service} cannot start:`, error);
    }
    process.exitCode = 1;
}
