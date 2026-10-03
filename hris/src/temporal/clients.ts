/**
 * Catalog client for the Temporal activities.
 *
 * The worker is a separate process with NO Connectum `Server`, so the in-process
 * `ctx.call` / `server.localClient` facilities are unavailable there. Instead of
 * hand-building one `createClient(Service, transport)` per role service, the
 * worker uses `createCatalogClient`: the SAME typed
 * `call("<typeName>/<Method>", req)` surface handlers get from `ctx.call`, keyed
 * off the generated service catalog, with every target resolved over the
 * network through a `RemoteResolver` — exactly the example's split-topology
 * story (`*_ADDR` env), just initiated from the worker instead of a handler.
 *
 * The client carries no Authorization header — the HRIS edge has no auth chain
 * (the real trust boundary is the mesh). Each activity is one RPC against one
 * role service over the network.
 *
 * @module temporal/clients
 */

import { createGrpcTransport } from "@connectrpc/connect-node";
import { createCatalogClient, perServiceEnvResolver } from "@connectum/core";
import type { CatalogClient, RemoteResolver } from "@connectum/core";
import { serviceCatalog } from "#gen/catalog.gen.ts";
import { ENDPOINT_ENV, TYPE_NAMES } from "#topology.ts";

/**
 * Fallback endpoints for a local run when the matching `*_ADDR` variable is not
 * set (one role per service). The env resolver alone has no defaults — an unset
 * variable means "no route" — so without this map a worker started without the
 * variables would fail every call instead of reaching the local roles.
 */
const DEFAULT_ENDPOINTS: Readonly<Record<string, string>> = {
    [TYPE_NAMES.directory]: "http://localhost:5001",
    [TYPE_NAMES.timeoff]: "http://localhost:5002",
    [TYPE_NAMES.payroll]: "http://localhost:5003",
    [TYPE_NAMES.access]: "http://localhost:5004",
};

/**
 * Resolve a service from its `*_ADDR` env var first (the same variables the RPC
 * roles use for `ctx.call`), and only when that is unset or empty fall back to
 * the local default. A service with neither resolves to `null`, which the
 * catalog client turns into `Code.Unavailable`.
 *
 * `createGrpcTransport({ baseUrl })` needs a full URL (`http://host:port`), the
 * shape the `*_ADDR` variables carry in k8s/compose. The transport connects
 * lazily, and the catalog client caches it per service, so this runs once per
 * service, not per call.
 */
function workerResolver(): RemoteResolver {
    const fromEnv = perServiceEnvResolver(ENDPOINT_ENV);
    return (ctx) => {
        const transport = fromEnv(ctx);
        if (transport !== null) return transport;
        const fallback = DEFAULT_ENDPOINTS[ctx.typeName];
        return fallback === undefined ? null : createGrpcTransport({ baseUrl: fallback });
    };
}

/**
 * Build the catalog client the activities drive the onboarding saga's RPCs
 * with: `client.call("directory.v1.DirectoryService/CreateEmployee", req)`.
 */
export function createWorkerClient(): CatalogClient {
    return createCatalogClient({ catalog: serviceCatalog, resolver: workerResolver() });
}
