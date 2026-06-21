/**
 * Temporal configuration — the single source of truth for the durable layer.
 *
 * Read once from env so the onboarding gateway (which builds a
 * `@temporalio/client`), the worker (`@temporalio/worker`), and the dockerless
 * tests all agree on the connection target, namespace, and task queue. The
 * defaults make a local `docker compose up` (temporalio/auto-setup on `:7233`,
 * namespace `default`) work with no extra env.
 *
 * @module temporal/config
 */

/** Temporal frontend gRPC address (host:port). Compose sets `temporal:7233`. */
export const TEMPORAL_ADDRESS = process.env.TEMPORAL_ADDRESS ?? "localhost:7233";

/** Temporal namespace. `temporalio/auto-setup` creates `default`. */
export const TEMPORAL_NAMESPACE = process.env.TEMPORAL_NAMESPACE ?? "default";

/**
 * Task queue the worker polls and the gateway targets when starting workflows.
 * Both sides MUST agree, or started workflows are never picked up.
 */
export const TEMPORAL_TASK_QUEUE = process.env.TEMPORAL_TASK_QUEUE ?? "hris-onboarding";
