/**
 * ConnectRPC client factory for the Temporal activities.
 *
 * The worker is a separate process with NO Connectum `Server`, so the in-process
 * `ctx.call` / `server.client()` facilities are unavailable there. Activities
 * therefore reach the role services as a plain network client — exactly the
 * example's cross-pod story (`*_ADDR` env), just initiated from the worker
 * instead of a request handler.
 *
 * The clients carry no Authorization header. That is fine: fleet/billing are
 * service-level `public`, and the trips RPCs the activities call (RecordTrip /
 * EndTrip) are method-level `public` (see trips.proto) — both skip the gateway
 * auth chain. The real trust boundary is the mesh.
 *
 * @module temporal/clients
 */

import type { Client } from "@connectrpc/connect";
import { createClient } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import { BillingService } from "#gen/billing/v1/billing_pb.ts";
import { FleetService } from "#gen/fleet/v1/fleet_pb.ts";
import { TripService } from "#gen/trips/v1/trips_pb.ts";

/** Default endpoints for a local `docker compose up` (one role per service). */
const DEFAULT_FLEET_ADDR = "http://localhost:5001";
const DEFAULT_TRIPS_ADDR = "http://localhost:5002";
const DEFAULT_BILLING_ADDR = "http://localhost:5003";

/** The typed clients the activities use to drive the saga's RPCs. */
export interface ServiceClients {
    readonly fleet: Client<typeof FleetService>;
    readonly trips: Client<typeof TripService>;
    readonly billing: Client<typeof BillingService>;
}

/**
 * Build the fleet/trips/billing clients from the `*_ADDR` env convention.
 *
 * `createGrpcTransport({ baseUrl })` requires a full URL (`http://host:port`),
 * the same shape `TRIPS_ADDR`/`FLEET_ADDR`/`BILLING_ADDR` carry in k8s/compose.
 *
 * @param env - Process env to read endpoints from (defaults to `process.env`).
 */
export function createServiceClients(env: NodeJS.ProcessEnv = process.env): ServiceClients {
    const fleetAddr = env.FLEET_ADDR ?? DEFAULT_FLEET_ADDR;
    const tripsAddr = env.TRIPS_ADDR ?? DEFAULT_TRIPS_ADDR;
    const billingAddr = env.BILLING_ADDR ?? DEFAULT_BILLING_ADDR;

    return {
        fleet: createClient(FleetService, createGrpcTransport({ baseUrl: fleetAddr })),
        trips: createClient(TripService, createGrpcTransport({ baseUrl: tripsAddr })),
        billing: createClient(BillingService, createGrpcTransport({ baseUrl: billingAddr })),
    };
}
