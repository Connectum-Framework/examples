/**
 * Event-topic resolution tests — DOCKERLESS.
 *
 * The LeaveApproved topic is declared once, by the proto option
 * `(connectum.events.v1.event).topic = "timeoff.leave-approved"` on
 * `PayrollEventHandlers.OnLeaveApproved`. The publisher passes no topic, so the
 * bus has to find it on its own. These tests pin down that it does, in the case
 * where it is easiest to get wrong:
 *
 *  - a process that runs TimeOffService WITHOUT PayrollService (the split
 *    timeoff role) has no subscriber route for LeaveApproved. Only the
 *    `publishes` declaration can tell its bus the topic; if that declaration is
 *    missing, the event would go out under the message typeName and the payroll
 *    role, listening on `timeoff.leave-approved`, would never see it.
 *  - a process that does not run TimeOffService has declared nothing about
 *    LeaveApproved. With `strictTopics` on, a publish from there must fail
 *    loudly instead of emitting to the typeName where nobody listens.
 *
 * The adapter is a thin recorder around `MemoryAdapter` (`helpers/recordingAdapter.ts`),
 * so the assertion reads the topic the bus actually handed to the broker layer.
 *
 * @module tests/e2e/eventTopics
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { create } from "@bufbuild/protobuf";
import type { Server } from "@connectum/core";
import { resolveTopicName } from "@connectum/events";
import { buildEventBus } from "#eventBus.ts";
import { DirectoryService } from "#gen/directory/v1/directory_pb.ts";
import { LeaveApprovedSchema, PayrollEventHandlers, PayrollService } from "#gen/payroll/v1/payroll_pb.ts";
import { RequestLeaveRequestSchema, TimeOffService } from "#gen/timeoff/v1/timeoff_pb.ts";
import { buildServer } from "#server.ts";
import { resolveTopology, TYPE_NAMES } from "#topology.ts";
import { makeTestDb } from "../helpers/db.ts";
import { recordingAdapter } from "../helpers/recordingAdapter.ts";

/** The topic the payroll subscriber listens on, as written in payroll.proto. */
const LEAVE_APPROVED_TOPIC = "timeoff.leave-approved";

describe("LeaveApproved topic: resolved from the proto option in a publisher-only process", () => {
    const published: string[] = [];
    let server: Server;

    before(async () => {
        // TimeOff + Directory local (so the ctx.call validation stays
        // in-process), Payroll deliberately NOT local: the bus gets no payroll
        // subscriber route that could supply the topic by accident.
        const topology = resolveTopology(`${TYPE_NAMES.timeoff},${TYPE_NAMES.directory}`);
        const eventBus = buildEventBus({ localTypeNames: topology.localTypeNames, adapter: recordingAdapter(published) });
        const db = await makeTestDb();
        server = buildServer({ port: 0, topology, eventBus, db });
        await server.start();
    });

    after(async () => {
        if (server.state === "running") await server.stop();
    });

    it("the role hosts the publisher but not the payroll subscriber", () => {
        assert.equal(server.hasService(TimeOffService), true);
        assert.equal(server.hasService(DirectoryService), true);
        assert.equal(server.hasService(PayrollService), false);
    });

    it("the proto option on OnLeaveApproved declares the topic, distinct from the typeName", () => {
        assert.equal(resolveTopicName(PayrollEventHandlers.method.onLeaveApproved), LEAVE_APPROVED_TOPIC);
        assert.notEqual(LEAVE_APPROVED_TOPIC, LeaveApprovedSchema.typeName);
    });

    it("RequestLeave publishes LeaveApproved to the declared topic, not to the message typeName", async () => {
        published.length = 0;
        const timeoff = server.localClient(TimeOffService);

        const res = await timeoff.requestLeave(create(RequestLeaveRequestSchema, { employeeId: "e-001", days: 2 }));
        assert.equal(res.leaveRequest?.status, "APPROVED");

        assert.deepEqual(published, [LEAVE_APPROVED_TOPIC]);
        assert.ok(!published.includes(LeaveApprovedSchema.typeName), "the typeName fallback must not be used");
    });
});

describe("strictTopics: a role that never declared LeaveApproved cannot publish it", () => {
    it("publishing LeaveApproved from a directory-only bus throws and reaches no broker topic", async () => {
        const published: string[] = [];
        const bus = buildEventBus({ localTypeNames: [TYPE_NAMES.directory], adapter: recordingAdapter(published) });
        await bus.start();
        try {
            await assert.rejects(
                bus.publish(LeaveApprovedSchema, create(LeaveApprovedSchema, { leaveRequestId: "lr-x", employeeId: "e-001", days: 1 })),
                (err: unknown) => err instanceof Error && err.message.includes("strictTopics is enabled") && err.message.includes(LeaveApprovedSchema.typeName),
            );
            assert.deepEqual(published, []);
        } finally {
            await bus.stop();
        }
    });
});
