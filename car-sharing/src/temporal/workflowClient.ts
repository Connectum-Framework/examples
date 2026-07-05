/**
 * Lazy Temporal client factory for the gateway (TripService) role.
 *
 * Builds a `@temporalio/client` `WorkflowClient` over a LAZY connection
 * (`Connection.lazy` opens no socket until the first call). That laziness is
 * what lets the server START — and the pre-check e2e run — WITHOUT a live
 * Temporal server: only an actual `StartTrip` that reaches `workflowClient.start`
 * (or a `GetTrip` query) touches Temporal.
 *
 * `@temporalio/client` is pure JS (no core-bridge native addon), so importing it
 * here keeps every RPC role on its no-build native-TS run model — only
 * `src/worker.ts` pulls the native worker.
 *
 * @module temporal/workflowClient
 */

import { Client, Connection } from "@temporalio/client";
import { TEMPORAL_ADDRESS, TEMPORAL_NAMESPACE } from "#temporal/config.ts";

/** The `WorkflowClient` shape (a subset is consumed by `createTripService`). */
export type WorkflowClient = Client["workflow"];

/**
 * Create a `WorkflowClient` over a lazy connection. No socket opens until the
 * first workflow start/query, so this is safe to construct in any topology.
 */
export function createWorkflowClient(): WorkflowClient {
    const connection = Connection.lazy({ address: TEMPORAL_ADDRESS });
    const client = new Client({ connection, namespace: TEMPORAL_NAMESPACE });
    return client.workflow;
}
