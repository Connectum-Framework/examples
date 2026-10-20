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
import { makeTestDb } from "../helpers/db.ts";
import { recordingAdapter } from "../helpers/recordingAdapter.ts";

/** The topic the payroll subscriber listens on, as written in payroll.proto. */
const LEAVE_APPROVED_TOPIC = "timeoff.leave-approved";

describe("E2E: HRIS monolith (in-process, no broker)", () => {
    let server: Server;
    let grpcTimeOff: ReturnType<typeof createClient<typeof TimeOffService>>;
    /** Topic of every event the bus handed to the adapter, in publish order. */
    const published: string[] = [];

    before(async () => {
        // Force monolith topology and an in-memory bus so publish → subscribe →
        // balance-decrement runs entirely in this process. The SAME bus instance
        // is injected into the server so the TimeOff publisher and the Payroll
        // subscriber share it. A PGlite-backed Drizzle db is injected too, so
        // DirectoryService persists without Docker — the TimeOff handler's
        // in-process ctx.call to GetEmployee reads from it.
        const topology = resolveTopology("*");
        const eventBus = buildEventBus({ localTypeNames: topology.localTypeNames, adapter: recordingAdapter(published) });
        const db = await makeTestDb();
        server = buildServer({ port: 0, topology, eventBus, db });
        await server.start();
        const port = server.address?.port ?? 0;
        grpcTimeOff = createClient(TimeOffService, createGrpcTransport({ baseUrl: `http://localhost:${port}` }));
    });

    beforeEach(() => {
        resetBalances();
        published.length = 0;
    });

    /** Remaining leave days for an employee, read through the PayrollService RPC. */
    async function remainingDays(employeeId: string): Promise<number | undefined> {
        const payroll = server.localClient(PayrollService);
        const res = await payroll.getBalance(create(GetBalanceRequestSchema, { employeeId }));
        return res.balance?.remainingDays;
    }

    after(async () => {
        if (server.state === "running") await server.stop();
    });

    it("mounts all three services from the generated catalog (monolith)", () => {
        assert.equal(server.hasService(DirectoryService), true);
        assert.equal(server.hasService(TimeOffService), true);
        assert.equal(server.hasService(PayrollService), true);
    });

    it("RequestLeave validates via ctx.call, approves, and the event decrements payroll", async () => {
        const timeoff = server.localClient(TimeOffService);

        // The starting balance is the demo ledger's own data; the documented
        // behaviour is the relation: each approved request lowers the balance by
        // its days, and by nothing else.
        const start = await remainingDays("e-001");
        assert.ok(start !== undefined && start > 5, `the demo employee needs spare leave days, got ${start}`);
        const otherStart = await remainingDays("e-002");

        const res = await timeoff.requestLeave(create(RequestLeaveRequestSchema, { employeeId: "e-001", days: 3 }));
        assert.equal(res.leaveRequest?.status, "APPROVED");
        assert.notEqual(res.leaveRequest?.id, "", "an approved request carries its id");

        // No sleep: the MemoryAdapter delivers the LeaveApproved event to the
        // Payroll subscriber synchronously within publish(), so the balance is
        // already decremented when requestLeave resolves.
        assert.equal(await remainingDays("e-001"), start - 3);

        // A second approval accumulates, and another employee is untouched.
        await timeoff.requestLeave(create(RequestLeaveRequestSchema, { employeeId: "e-001", days: 2 }));
        assert.equal(await remainingDays("e-001"), start - 5);
        assert.equal(await remainingDays("e-002"), otherStart);

        // Each approval published exactly one LeaveApproved, on the topic the proto declares.
        assert.deepEqual(published, [LEAVE_APPROVED_TOPIC, LEAVE_APPROVED_TOPIC]);
    });

    it("unknown employee: ctx.call surfaces Code.NotFound from the directory", async () => {
        const timeoff = server.localClient(TimeOffService);
        await assert.rejects(
            timeoff.requestLeave(create(RequestLeaveRequestSchema, { employeeId: "ghost", days: 1 })),
            (err: unknown) => err instanceof ConnectError && err.code === Code.NotFound,
        );
    });

    it("a rejected request publishes no event — payroll balance is unchanged", async () => {
        const timeoff = server.localClient(TimeOffService);
        const before = await remainingDays("e-001");

        await assert.rejects(timeoff.requestLeave(create(RequestLeaveRequestSchema, { employeeId: "ghost", days: 1 })));

        // The bus is the observation point: a rejected request must not have
        // reached it at all. (A balance read cannot show this, since the
        // payroll ledger answers 0 for any id it does not hold.)
        assert.deepEqual(published, []);
        assert.equal(await remainingDays("ghost"), 0);
        assert.equal(await remainingDays("e-001"), before);
    });

    it("RequestLeave rejects days <= 0 with InvalidArgument: no event, balance unchanged", async () => {
        const timeoff = server.localClient(TimeOffService);
        const before = await remainingDays("e-001");

        // A negative value would otherwise raise the balance (the subscriber
        // subtracts the days), and zero approves nothing.
        for (const days of [0, -1, -5]) {
            await assert.rejects(
                timeoff.requestLeave(create(RequestLeaveRequestSchema, { employeeId: "e-001", days })),
                (err: unknown) => err instanceof ConnectError && err.code === Code.InvalidArgument,
                `days=${days} must be InvalidArgument`,
            );
        }

        assert.deepEqual(published, []);
        assert.equal(await remainingDays("e-001"), before);
    });

    it("demo simplification: a request for more days than the balance is still APPROVED and the balance floors at 0", async () => {
        // The example defines no policy for an overdrawn request: the approval
        // never looks at the balance and the payroll subscriber clamps at zero.
        // This test pins that behaviour so a change to it is a visible decision.
        const timeoff = server.localClient(TimeOffService);
        const start = await remainingDays("e-002");
        assert.ok(start !== undefined && start > 0);

        const res = await timeoff.requestLeave(create(RequestLeaveRequestSchema, { employeeId: "e-002", days: start + 10 }));

        assert.equal(res.leaveRequest?.status, "APPROVED");
        assert.equal(await remainingDays("e-002"), 0);
    });

    it("HTTP/2 gRPC loopback: the same RequestLeave flow over the network", async () => {
        const start = await remainingDays("e-003");
        assert.ok(start !== undefined && start > 4, `the demo employee needs spare leave days, got ${start}`);

        const res = await grpcTimeOff.requestLeave(create(RequestLeaveRequestSchema, { employeeId: "e-003", days: 4 }));
        assert.equal(res.leaveRequest?.status, "APPROVED");

        assert.equal(await remainingDays("e-003"), start - 4);
        assert.deepEqual(published, [LEAVE_APPROVED_TOPIC]);
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
