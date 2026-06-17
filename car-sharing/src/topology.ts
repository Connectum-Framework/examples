/**
 * Env-driven topology — the deployment headline of this example.
 *
 * One handler codebase runs as a MONOLITH (every service in-process) or as any
 * single MICROSERVICE role, chosen entirely by environment variables. Nothing in
 * the service handlers changes between topologies; only this module reads env and
 * tells the framework what is local vs remote.
 *
 *  - `SERVICES` (parsed via `parseServicesEnv`) lists the proto `typeName`s this
 *    process mounts locally. Unset or `*` = monolith (all local). The framework's
 *    `enabledServices` then skips mounting the rest and routes them remotely.
 *  - `remoteResolver` (`perServiceEnvResolver`) maps each non-local service to the
 *    env var holding its base URL (`FLEET_ADDR`, `TRIPS_ADDR`, `BILLING_ADDR`),
 *    so `ctx.call` auto-routes to the right pod. In Kubernetes those env vars are
 *    the in-cluster DNS names of the peer Services (see k8s/configmap.yaml).
 *
 * @module topology
 */

import { parseServicesEnv, perServiceEnvResolver } from "@connectum/core";
import type { RemoteResolver } from "@connectum/core";

/** Canonical proto `typeName`s of the three RPC services. */
export const TYPE_NAMES = {
    fleet: "fleet.v1.FleetService",
    trips: "trips.v1.TripService",
    billing: "billing.v1.BillingService",
} as const;

/** All RPC service typeNames (the monolith set). */
const ALL_TYPE_NAMES: readonly string[] = [TYPE_NAMES.fleet, TYPE_NAMES.trips, TYPE_NAMES.billing];

/** Per-service endpoint env var, consumed by the remote resolver. */
const ENDPOINT_ENV: Readonly<Record<string, string>> = {
    [TYPE_NAMES.fleet]: "FLEET_ADDR",
    [TYPE_NAMES.trips]: "TRIPS_ADDR",
    [TYPE_NAMES.billing]: "BILLING_ADDR",
};

/** The resolved deployment topology for this process. */
export interface Topology {
    /**
     * Proto `typeName`s mounted locally, as a concrete list (always populated;
     * `*`/unset expands to all three).
     */
    readonly localTypeNames: readonly string[];
    /**
     * Value for `createServer({ enabledServices })`: `undefined` in monolith mode
     * (mount everything), otherwise the explicit local subset.
     *
     * NB: `enabledServices: []` would mount ZERO services — so monolith MUST pass
     * `undefined`, never an empty array.
     */
    readonly enabledServices: readonly string[] | undefined;
    /** Resolver for services not mounted locally (consulted by `ctx.call`). */
    readonly remoteResolver: RemoteResolver;
    /** True when every RPC service runs in this one process. */
    readonly isMonolith: boolean;
}

/**
 * Resolve the topology from `SERVICES` (defaults to `process.env.SERVICES`).
 *
 * @param servicesEnv - Raw `SERVICES` value; unset/`*` = monolith.
 */
export function resolveTopology(servicesEnv: string | undefined = process.env.SERVICES): Topology {
    const parsed = parseServicesEnv(servicesEnv);
    const isMonolith = parsed.length === 0 || parsed.includes("*");

    const localTypeNames = isMonolith ? ALL_TYPE_NAMES : parsed;
    const enabledServices = isMonolith ? undefined : parsed;
    const remoteResolver = perServiceEnvResolver(ENDPOINT_ENV);

    return { localTypeNames, enabledServices, remoteResolver, isMonolith };
}
