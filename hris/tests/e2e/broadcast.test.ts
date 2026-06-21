/**
 * Phase 5b EventBus broadcast / fan-out tests — DOCKERLESS.
 *
 * Proves the multi-subscriber face of the EventBus: ONE `EmployeeOnboarded`
 * published on the saga's terminal step fans out to THREE INDEPENDENT reactors.
 * No broker — one shared `MemoryAdapter()` feeds the publisher bus AND all three
 * reactor buses, so a single publish reaches all three in-process (MemoryAdapter
 * broadcasts to every matching subscription and ignores group; the distinct
 * groups are still written so the SAME wiring fans out on NATS).
 *
 * Tests:
 *
 *  1. PRIMARY — drives the actual publish SITE: injects the publisher bus into
 *     the activities module (the same `setPublisherBus` seam the worker uses),
 *     runs the REAL `announceOnboarded` activity body via `MockActivityEnvironment`,
 *     and asserts ALL THREE reactors fired with the FULL `EmployeeOnboarded`
 *     shape (the audit record equals the documented five-field contract, not
 *     just "an event arrived").
 *  2. TOPIC — `resolveTopicName(OnboardingEventHandlers.method.onEmployeeOnboarded)`
 *     is exactly `"onboarding.employee-onboarded"`, pinning the topic to the
 *     proto option (not the `typeName` fallback). No raw `{topic}` is passed.
 *  3. IDEMPOTENCY — a redelivery of the same `employeeId` does NOT double-apply.
 *
 * @module tests/e2e/broadcast
 */

import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { MemoryAdapter, resolveTopicName } from "@connectum/events";
import type { EventAdapter } from "@connectum/events";
import { MockActivityEnvironment } from "@temporalio/testing";
import { OnboardingEventHandlers } from "#gen/onboarding/v1/onboarding_events_pb.ts";
import { buildPublisherBus, buildReactorBus } from "#events/broadcastBus.ts";
import type { ManagedBus } from "#events/broadcastBus.ts";
import { auditRecords, departmentHeadcount, resetAllReactors, welcomeEmails, welcomeReactorRoutes, auditReactorRoutes, headcountReactorRoutes } from "#events/reactors.ts";
import * as activities from "#temporal/activities.ts";
import type { NewHire } from "#temporal/activities.ts";

const env = new MockActivityEnvironment();

/** Run a real activity body inside a mocked Temporal Activity Context. */
function run<A extends unknown[], R>(fn: (...args: A) => Promise<R>, ...args: A): Promise<R> {
    return env.run(fn, ...args);
}

/** The new hire carried into the broadcast event. */
const HIRE: NewHire = {
    employeeId: "e-100",
    name: "New Hire",
    email: "newhire@example.com",
    title: "Software Engineer",
    department: "Engineering",
    managerId: "e-002",
};

describe("Phase 5b broadcast: one EmployeeOnboarded fans out to three independent reactors (dockerless, MemoryAdapter)", () => {
    let adapter: EventAdapter;
    let publisher: ManagedBus;
    let welcome: ManagedBus;
    let audit: ManagedBus;
    let headcount: ManagedBus;

    before(async () => {
        // ONE shared in-memory adapter feeds all four buses: a publish on the
        // publisher bus reaches every reactor's subscription on the SAME adapter.
        // Groups are ignored in-memory but written so the wiring fans out on NATS.
        adapter = MemoryAdapter();
        publisher = buildPublisherBus({ adapter });
        welcome = buildReactorBus({ key: "welcome", route: welcomeReactorRoutes, adapter });
        audit = buildReactorBus({ key: "audit", route: auditReactorRoutes, adapter });
        headcount = buildReactorBus({ key: "headcount", route: headcountReactorRoutes, adapter });
        await Promise.all([publisher.start(), welcome.start(), audit.start(), headcount.start()]);
        // Inject the publisher bus into the activities module — the SAME seam the
        // worker uses — so the REAL activity publishes on it.
        activities.setPublisherBus(publisher);
    });

    beforeEach(() => {
        resetAllReactors();
    });

    after(async () => {
        // Stop ONLY after every assertion (the FIRST stop calls the shared
        // adapter's disconnect(), which wipes all subscriptions).
        activities.setPublisherBus(undefined);
        await Promise.all([publisher.stop(), welcome.stop(), audit.stop(), headcount.stop()]);
    });

    it("PRIMARY: the terminal announceOnboarded activity broadcasts ONCE, all three reactors react with the FULL message shape", async () => {
        // Drive the actual publish SITE: the real activity body, not a hand-built
        // publish.
        await run(activities.announceOnboarded, HIRE);

        // WELCOME reacted — a welcome was "sent" to the hire's email.
        assert.deepEqual(welcomeEmails(), ["newhire@example.com"]);

        // HEADCOUNT reacted — the hire's department was incremented once.
        assert.equal(departmentHeadcount("Engineering"), 1);

        // AUDIT reacted — one record with the FULL documented five-field shape.
        const records = auditRecords();
        assert.equal(records.length, 1);
        assert.deepEqual(records[0], {
            employeeId: "e-100",
            name: "New Hire",
            email: "newhire@example.com",
            department: "Engineering",
            managerId: "e-002",
        });
    });

    it("TOPIC: the topic is pinned to the proto option, not the message typeName", () => {
        assert.equal(resolveTopicName(OnboardingEventHandlers.method.onEmployeeOnboarded), "onboarding.employee-onboarded");
    });

    it("IDEMPOTENCY: a redelivery of the same employeeId does not double-apply in any reactor", async () => {
        await run(activities.announceOnboarded, HIRE);
        // Publish the SAME employee again (at-least-once redelivery on a broker).
        await run(activities.announceOnboarded, HIRE);

        // Every reactor deduped by employeeId — counted/recorded/sent exactly once.
        assert.equal(welcomeEmails().length, 1);
        assert.equal(departmentHeadcount("Engineering"), 1);
        assert.equal(auditRecords().length, 1);
    });
});
