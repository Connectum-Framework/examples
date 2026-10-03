/**
 * EmployeeOnboarded broadcast tests — DOCKERLESS.
 *
 * One `EmployeeOnboarded`, published by the REAL `announceOnboarded` activity
 * body, must reach EVERY reactor (welcome, audit, headcount), each on its own
 * bus built by `createBroadcastSubscribers`. No broker: one shared
 * `MemoryAdapter` (wrapped to record topics) feeds the publisher bus and all
 * reactor buses.
 *
 * Limit of this suite: the memory adapter ignores consumer groups and simply
 * delivers to every matching subscription. It proves that every reactor is
 * subscribed to the announced topic and handles the full event; it cannot prove
 * the broker-side property that distinct groups give each reactor its own
 * durable consumer. That property is asserted only at the configuration level
 * here (the groups are distinct).
 *
 * @module tests/e2e/broadcast
 */

import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { create } from "@bufbuild/protobuf";
import { resolveTopicName } from "@connectum/events";
import { MockActivityEnvironment } from "@temporalio/testing";
import { buildOnboardedPublisherBus, buildReactorBuses } from "#broadcast/buses.ts";
import type { ManagedBus } from "#broadcast/buses.ts";
import { ALL_REACTORS, auditRecords, departmentHeadcount, REACTOR_GROUP, resetReactors, welcomeEmails } from "#broadcast/reactors.ts";
import { EmployeeOnboardedSchema, OnboardingEventHandlers } from "#gen/onboarding/v1/onboarding_events_pb.ts";
import { LeaveApprovedSchema } from "#gen/payroll/v1/payroll_pb.ts";
import * as activities from "#temporal/activities.ts";
import type { NewHire } from "#temporal/activities.ts";
import { setOnboardedPublisher } from "#temporal/publisher.ts";
import { recordingAdapter } from "../helpers/recordingAdapter.ts";

/** The topic the reactors subscribe to, as written in onboarding_events.proto. */
const EMPLOYEE_ONBOARDED_TOPIC = "onboarding.employee-onboarded";

const env = new MockActivityEnvironment();

/** Run a real activity body inside a mocked Temporal activity context. */
function run<A extends unknown[], R>(fn: (...args: A) => Promise<R>, ...args: A): Promise<R> {
    return env.run(fn, ...args);
}

const HIRE: NewHire = {
    employeeId: "e-100",
    name: "New Hire",
    email: "newhire@example.com",
    title: "Software Engineer",
    department: "Engineering",
    managerId: "e-002",
};

describe("EmployeeOnboarded broadcast: one announcement reaches every reactor (MemoryAdapter)", () => {
    const published: string[] = [];
    let publisher: ManagedBus;
    let reactorBuses: ManagedBus[];

    before(async () => {
        const adapter = recordingAdapter(published);
        publisher = buildOnboardedPublisherBus({ adapter });
        reactorBuses = buildReactorBuses({ reactors: ALL_REACTORS, adapter });
        await Promise.all([publisher.start(), ...reactorBuses.map((bus) => bus.start())]);
        // The same hand-over the worker performs at startup.
        setOnboardedPublisher(publisher);
    });

    beforeEach(() => {
        resetReactors();
        published.length = 0;
    });

    after(async () => {
        setOnboardedPublisher(undefined);
        // Stop only here, once: the buses share one memory adapter, and the
        // first stop disconnects it, which drops every bus's subscriptions.
        await Promise.allSettled([publisher.stop(), ...reactorBuses.map((bus) => bus.stop())]);
    });

    it("builds one bus per reactor, each under a distinct consumer group", () => {
        assert.equal(reactorBuses.length, ALL_REACTORS.length);
        const groups = ALL_REACTORS.map((key) => REACTOR_GROUP[key]);
        assert.equal(new Set(groups).size, groups.length);
    });

    it("the announce activity publishes once, and every reactor handles the full event", async () => {
        await run(activities.announceOnboarded, HIRE);

        assert.deepEqual(published, [EMPLOYEE_ONBOARDED_TOPIC]);

        assert.deepEqual(welcomeEmails(), ["newhire@example.com"]);
        assert.equal(departmentHeadcount("Engineering"), 1);
        // The audit record mirrors the documented five-field event, so this
        // checks the decoded payload, not merely that something arrived.
        assert.deepEqual(auditRecords(), [
            {
                employeeId: "e-100",
                name: "New Hire",
                email: "newhire@example.com",
                department: "Engineering",
                managerId: "e-002",
            },
        ]);
    });

    it("a redelivered announcement for the same employee is applied only once by every reactor", async () => {
        await run(activities.announceOnboarded, HIRE);
        // At-least-once delivery: a retried activity announces the same hire again.
        await run(activities.announceOnboarded, HIRE);

        assert.equal(published.length, 2);
        assert.equal(welcomeEmails().length, 1);
        assert.equal(departmentHeadcount("Engineering"), 1);
        assert.equal(auditRecords().length, 1);
    });

    it("the topic is the one declared by the proto option, not the message typeName", () => {
        const topic = resolveTopicName(OnboardingEventHandlers.method.onEmployeeOnboarded);
        assert.equal(topic, EMPLOYEE_ONBOARDED_TOPIC);
        assert.notEqual(topic, EmployeeOnboardedSchema.typeName);
    });

    it("the publish-only bus refuses an event it never declared (strictTopics)", async () => {
        await assert.rejects(
            publisher.publish(LeaveApprovedSchema, create(LeaveApprovedSchema, { leaveRequestId: "lr-x", employeeId: "e-100", days: 1 })),
            (err: unknown) => err instanceof Error && err.message.includes("strictTopics is enabled") && err.message.includes(LeaveApprovedSchema.typeName),
        );
        assert.deepEqual(published, []);
    });

    it("the announce activity fails loudly when the hosting process never handed it a bus", async () => {
        setOnboardedPublisher(undefined);
        try {
            await assert.rejects(run(activities.announceOnboarded, HIRE), /publisher bus is not set/);
            assert.deepEqual(published, []);
        } finally {
            setOnboardedPublisher(publisher);
        }
    });
});
