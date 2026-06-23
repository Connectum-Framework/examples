/**
 * ConnectRPC client factory for the Temporal activities.
 *
 * The worker is a separate process with NO Connectum `Server`, so the in-process
 * `ctx.call` / `server.localClient` facilities are unavailable there. Activities
 * therefore reach the role services as a plain network client — exactly the
 * example's split-topology story (`*_ADDR` env), just initiated from the worker
 * instead of a request handler.
 *
 * The clients carry no Authorization header — the HRIS edge has no auth chain
 * (the real trust boundary is the mesh). Each activity is one RPC against one
 * role service over the network.
 *
 * @module temporal/clients
 */

import type { Client } from "@connectrpc/connect";
import { createClient } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import { AccessService } from "#gen/access/v1/access_pb.ts";
import { DirectoryService } from "#gen/directory/v1/directory_pb.ts";
import { PayrollService } from "#gen/payroll/v1/payroll_pb.ts";
import { TimeOffService } from "#gen/timeoff/v1/timeoff_pb.ts";

/** Default endpoints for a local `docker compose up` (one role per service). */
const DEFAULT_DIRECTORY_ADDR = "http://localhost:5001";
const DEFAULT_PAYROLL_ADDR = "http://localhost:5002";
const DEFAULT_TIMEOFF_ADDR = "http://localhost:5003";
const DEFAULT_ACCESS_ADDR = "http://localhost:5004";

/** The typed clients the activities use to drive the onboarding saga's RPCs. */
export interface ServiceClients {
    readonly directory: Client<typeof DirectoryService>;
    readonly payroll: Client<typeof PayrollService>;
    readonly timeoff: Client<typeof TimeOffService>;
    readonly access: Client<typeof AccessService>;
}

/**
 * Build the directory/payroll/timeoff/access clients from the `*_ADDR` env
 * convention.
 *
 * `createGrpcTransport({ baseUrl })` requires a full URL (`http://host:port`),
 * the same shape `DIRECTORY_ADDR`/`PAYROLL_ADDR`/`TIMEOFF_ADDR`/`ACCESS_ADDR`
 * carry in k8s/compose.
 *
 * @param env - Process env to read endpoints from (defaults to `process.env`).
 */
export function createServiceClients(env: NodeJS.ProcessEnv = process.env): ServiceClients {
    const directoryAddr = env.DIRECTORY_ADDR ?? DEFAULT_DIRECTORY_ADDR;
    const payrollAddr = env.PAYROLL_ADDR ?? DEFAULT_PAYROLL_ADDR;
    const timeoffAddr = env.TIMEOFF_ADDR ?? DEFAULT_TIMEOFF_ADDR;
    const accessAddr = env.ACCESS_ADDR ?? DEFAULT_ACCESS_ADDR;

    return {
        directory: createClient(DirectoryService, createGrpcTransport({ baseUrl: directoryAddr })),
        payroll: createClient(PayrollService, createGrpcTransport({ baseUrl: payrollAddr })),
        timeoff: createClient(TimeOffService, createGrpcTransport({ baseUrl: timeoffAddr })),
        access: createClient(AccessService, createGrpcTransport({ baseUrl: accessAddr })),
    };
}
