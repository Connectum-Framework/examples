/**
 * Catalog-typed ConnectRPC client for the Temporal activities.
 *
 * The worker is a separate process with NO Connectum `Server`, so the in-process
 * `ctx.call` / `server.client()` facilities are unavailable there. Activities
 * therefore reach the role services as a plain network client — exactly the
 * example's cross-pod story (`*_ADDR` env), just initiated from the worker
 * instead of a request handler.
 *
 * `createCatalogClient` gives the worker the SAME typed surface a handler gets
 * from `ctx.call`: `client.call("fleet.v1.FleetService/ReserveVehicle", req)`,
 * typed off the generated service catalog, with every target resolved through a
 * `RemoteResolver`. There is no local path — every call goes over the network.
 *
 * Every method the activities call is `internal` in proto (fleet and billing
 * entirely, trips RecordTrip / EndTrip), so every transport this client builds
 * signs each request with the worker's service token (`x-internal-token`, see
 * `#internalAuth.ts`). The receiving roles verify it against the worker's JWKS
 * and admit it where proto requires the `worker` role.
 *
 * @module temporal/clients
 */

import type { CatalogClient, RemoteResolver } from "@connectum/core";
import { createCatalogClient, mapResolver, perServiceEnvResolver } from "@connectum/core";
import { serviceCatalog } from "#gen/catalog.gen.ts";
import type { InternalSigner } from "#internalAuth.ts";
import { createSignedTransport } from "#internalAuth.ts";
import { ENDPOINT_ENV, TYPE_NAMES } from "#topology.ts";

/** Default endpoints for a local `docker compose up` (one role per service). */
const DEFAULT_FLEET_ADDR = "http://localhost:5001";
const DEFAULT_TRIPS_ADDR = "http://localhost:5002";
const DEFAULT_BILLING_ADDR = "http://localhost:5003";

/** Options for {@link createServiceClient}. */
export interface ServiceClientOptions {
    /** The worker's identity; every request this client sends is signed with it. */
    readonly signer: InternalSigner;
}

/**
 * Build the worker's catalog client from the `*_ADDR` env convention.
 *
 * Endpoints come from the same per-service env vars the role servers use for
 * `ctx.call` (`FLEET_ADDR`/`TRIPS_ADDR`/`BILLING_ADDR`, mapped in `topology.ts`),
 * each a full URL (`http://host:port`) as k8s/compose set them. Unlike a role
 * server — where an unset address must mean "no route" — the worker falls back
 * to the local compose ports, so `pnpm worker` works next to `docker compose up`
 * without any env. The env lookup and the fallback both happen when a service
 * is first called; the client then reuses that transport. BOTH paths build the
 * transport with the same signing factory, so no route can send an unsigned
 * request.
 *
 * @param options - {@link ServiceClientOptions}.
 */
export function createServiceClient(options: ServiceClientOptions): CatalogClient {
    const { signer } = options;
    const fromEnv = perServiceEnvResolver(ENDPOINT_ENV, { createTransport: (baseUrl) => createSignedTransport(baseUrl, signer) });
    // Transports connect lazily, so building all three up front opens no socket.
    const localDefaults = mapResolver({
        [TYPE_NAMES.fleet]: createSignedTransport(DEFAULT_FLEET_ADDR, signer),
        [TYPE_NAMES.trips]: createSignedTransport(DEFAULT_TRIPS_ADDR, signer),
        [TYPE_NAMES.billing]: createSignedTransport(DEFAULT_BILLING_ADDR, signer),
    });
    const resolver: RemoteResolver = (ctx) => fromEnv(ctx) ?? localDefaults(ctx);

    return createCatalogClient({ catalog: serviceCatalog, resolver });
}
