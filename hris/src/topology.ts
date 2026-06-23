/**
 * Env-driven topology — the headline of this example.
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
 *    env var holding its base URL (`DIRECTORY_ADDR`, `TIMEOFF_ADDR`,
 *    `PAYROLL_ADDR`), so `ctx.call` auto-routes to the right process.
 *
 * @module topology
 */

import { parseServicesEnv, perServiceEnvResolver } from "@connectum/core";
import type { RemoteResolver } from "@connectum/core";

/** Canonical proto `typeName`s of the RPC services. */
export const TYPE_NAMES = {
    directory: "directory.v1.DirectoryService",
    timeoff: "timeoff.v1.TimeOffService",
    payroll: "payroll.v1.PayrollService",
    access: "access.v1.AccessService",
    onboarding: "onboarding.v1.OnboardingService",
} as const;

/** All RPC service typeNames (the monolith set). */
const ALL_TYPE_NAMES: readonly string[] = [TYPE_NAMES.directory, TYPE_NAMES.timeoff, TYPE_NAMES.payroll, TYPE_NAMES.access, TYPE_NAMES.onboarding];

/** Per-service endpoint env var, consumed by the remote resolver. */
const ENDPOINT_ENV: Readonly<Record<string, string>> = {
    [TYPE_NAMES.directory]: "DIRECTORY_ADDR",
    [TYPE_NAMES.timeoff]: "TIMEOFF_ADDR",
    [TYPE_NAMES.payroll]: "PAYROLL_ADDR",
    [TYPE_NAMES.access]: "ACCESS_ADDR",
    [TYPE_NAMES.onboarding]: "ONBOARDING_ADDR",
};

/** The resolved deployment topology for this process. */
export interface Topology {
    /**
     * Proto `typeName`s mounted locally, as a concrete list (always populated;
     * `*`/unset expands to all five). Drives the EventBus role decisions.
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
