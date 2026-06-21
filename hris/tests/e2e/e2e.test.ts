/**
 * E2E tests — MONOLITH mode, no Docker, no NATS.
 *
 * The whole HRIS runs in ONE process on ONE EventBus backed by an in-memory
 * adapter, so the headline flows are verified end to end without a broker:
 *
 *  - RequestLeave validates the employee via `ctx.call` to DirectoryService
 *    (in-process), then publishes LeaveApproved; the Payroll subscriber consumes
 *    it and decrements the balance — asserted with NO sleep, because the memory
 *    adapter delivers synchronously through `publish`.
 *  - An unknown employee surfaces the directory's `Code.NotFound` straight out of
 *    `ctx.call` — the cross-service-validation path, which needs no broker.
 *  - The same RequestLeave flow over an HTTP/2 gRPC client.
 *
 * The split (microservices) topology is config-only here (see docker-compose.yml
 * / README); it shares this exact handler code, selected by the `SERVICES` env.
 */

import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, createClient } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import type { Server } from "@connectum/core";
import { buildEventBus } from "#eventBus.ts";
import { DirectoryService } from "#gen/directory/v1/directory_pb.ts";
import { GetBalanceRequestSchema, PayrollService } from "#gen/payroll/v1/payroll_pb.ts";
import { RequestLeaveRequestSchema, TimeOffService } from "#gen/timeoff/v1/timeoff_pb.ts";
import { buildServer } from "#server.ts";
import { resetBalances } from "#services/payrollService.ts";
import { resolveTopology } from "#topology.ts";
import { MemoryAdapter } from "@connectum/events";
import { makeTestDb } from "../helpers/db.ts";

describe("E2E: HRIS monolith (in-process, no broker)", () => {
    let server: Server;
    let grpcTimeOff: ReturnType<typeof createClient<typeof TimeOffService>>;

    before(async () => {
        // Force monolith topology and an in-memory bus so publish → subscribe →
        // balance-decrement runs entirely in this process. The SAME bus instance
        // is injected into the server so the TimeOff publisher and the Payroll
        // subscriber share it. A PGlite-backed Drizzle db is injected too, so
        // DirectoryService persists without Docker — the TimeOff handler's
        // in-process ctx.call to GetEmployee reads from it.
        const topology = resolveTopology("*");
        const eventBus = buildEventBus({ localTypeNames: topology.localTypeNames, adapter: MemoryAdapter() });
        const db = await makeTestDb();
        server = buildServer({ port: 0, topology, eventBus, db });
        await server.start();
        const port = server.address?.port ?? 0;
        grpcTimeOff = createClient(TimeOffService, createGrpcTransport({ baseUrl: `http://localhost:${port}` }));
    });

    beforeEach(() => {
        resetBalances();
    });

    after(async () => {
        if (server.state === "running") await server.stop();
    });

    it("mounts all three services from the generated catalog (monolith)", () => {
        assert.equal(server.hasService(DirectoryService), true);
        assert.equal(server.hasService(TimeOffService), true);
        assert.equal(server.hasService(PayrollService), true);
    });

    it("RequestLeave validates via ctx.call, approves, and the event decrements payroll", async () => {
        const payroll = server.localClient(PayrollService);
        const timeoff = server.localClient(TimeOffService);

        const before = await payroll.getBalance(create(GetBalanceRequestSchema, { employeeId: "e-001" }));
        assert.equal(before.balance?.remainingDays, 25);

        const res = await timeoff.requestLeave(create(RequestLeaveRequestSchema, { employeeId: "e-001", days: 3 }));
        assert.equal(res.leaveRequest?.status, "APPROVED");
        assert.ok(res.leaveRequest?.id.startsWith("lr-"));

        // No sleep: the MemoryAdapter delivers the LeaveApproved event to the
        // Payroll subscriber synchronously within publish(), so the balance is
        // already decremented when requestLeave resolves.
        const afterLeave = await payroll.getBalance(create(GetBalanceRequestSchema, { employeeId: "e-001" }));
        assert.equal(afterLeave.balance?.remainingDays, 22);
    });

    it("unknown employee: ctx.call surfaces Code.NotFound from the directory", async () => {
        const timeoff = server.localClient(TimeOffService);
        await assert.rejects(
            timeoff.requestLeave(create(RequestLeaveRequestSchema, { employeeId: "ghost", days: 1 })),
            (err: unknown) => err instanceof ConnectError && err.code === Code.NotFound,
        );
    });

    it("a rejected request publishes no event — payroll balance is unchanged", async () => {
        const payroll = server.localClient(PayrollService);
        const timeoff = server.localClient(TimeOffService);

        await assert.rejects(timeoff.requestLeave(create(RequestLeaveRequestSchema, { employeeId: "ghost", days: 1 })));

        const balance = await payroll.getBalance(create(GetBalanceRequestSchema, { employeeId: "e-002" }));
        assert.equal(balance.balance?.remainingDays, 25);
    });

    it("HTTP/2 gRPC loopback: the same RequestLeave flow over the network", async () => {
        const res = await grpcTimeOff.requestLeave(create(RequestLeaveRequestSchema, { employeeId: "e-003", days: 4 }));
        assert.equal(res.leaveRequest?.status, "APPROVED");

        const payroll = server.localClient(PayrollService);
        const balance = await payroll.getBalance(create(GetBalanceRequestSchema, { employeeId: "e-003" }));
        assert.equal(balance.balance?.remainingDays, 18 - 4);
    });

    it("HTTP/2 gRPC: a ctx.call error surfaces the downstream Code (not a protocol error)", async () => {
        // The directory's NotFound travels back through TimeOffService's
        // ctx.call and out to an external gRPC client. The framework strips the
        // in-process framing headers, so the client sees Code.NotFound rather
        // than an HTTP/2 trailer (protocol) error.
        await assert.rejects(
            grpcTimeOff.requestLeave(create(RequestLeaveRequestSchema, { employeeId: "ghost", days: 1 })),
            (err: unknown) => err instanceof ConnectError && err.code === Code.NotFound,
        );
    });
});
