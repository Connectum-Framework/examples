/**
 * Phase 3 EventBus broadcast / fan-out tests — DOCKERLESS.
 *
 * Proves the third interaction mechanism: ONE `TripCompleted` published on the
 * saga's terminal step fans out to THREE INDEPENDENT reactors. No broker — one
 * shared `MemoryAdapter()` feeds the publisher bus AND all three reactor buses,
 * so a single publish reaches all three in-process (MemoryAdapter broadcasts to
 * every matching subscription and ignores group; the distinct groups are still
 * written so the SAME wiring fans out on NATS).
 *
 * Tests:
 *
 *  1. PRIMARY — drives the actual publish SITE: injects the publisher bus into
 *     the activities module (the same `setPublisherBus` seam the worker uses),
 *     runs the REAL `publishTripCompleted` activity body via
 *     `MockActivityEnvironment`, and asserts ALL THREE reactors fired with the
 *     FULL `TripCompleted` shape (contract-conformance: the audit record equals
 *     the documented five-field contract, not just "an event arrived"). This is
 *     the only test that ties the publish-site decision (D1) to behavior.
 *  2. TOPIC — `resolveTopicName(TripEventHandlers.method.onTripCompleted)` is
 *     exactly `"trips.completed"`, pinning the topic to the proto option (not the
 *     `typeName` fallback). No raw `{topic}` is passed anywhere.
 *  3. NEGATIVE — an off-topic subscriber (pattern `trips.other`) receives 0,
 *     proving the broadcast is scoped to `trips.completed`, not "everything".
 *  4. IDEMPOTENCY — a redelivery of the same `tripId` does NOT double-apply.
 *  5. GROUPS — every reactor bus subscribes to `trips.completed` under its OWN
 *     consumer group. MemoryAdapter ignores groups, so tests 1-4 would still
 *     pass with a shared or missing group — which on NATS silently turns the
 *     broadcast into a load-balanced queue. This test records what the buses
 *     actually ask the adapter for, so that regression is caught without a broker.
 *
 * @module tests/e2e/broadcast
 */

import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { create, toBinary } from "@bufbuild/protobuf";
import { MemoryAdapter, resolveTopicName } from "@connectum/events";
import type { EventAdapter, EventSubscription, RawSubscribeOptions } from "@connectum/events";
import { MockActivityEnvironment } from "@temporalio/testing";
import { TripCompletedSchema, TripEventHandlers } from "#gen/trips/v1/trip_events_pb.ts";
import { buildPublisherBus, buildReactorBuses, REACTOR_GROUP } from "#events/eventBus.ts";
import type { ManagedBus, ReactorWiring } from "#events/eventBus.ts";
import { auditRecords, notifyReactorRoutes, auditReactorRoutes, pricingReactorRoutes, pricingRevenueCentsValue, pricingTripCountValue, resetAllReactors, sentReceipts } from "#events/reactors.ts";
import * as activities from "#temporal/activities.ts";

const env = new MockActivityEnvironment();

/** All three reactors, wired exactly as the three reactor processes wire themselves. */
const ALL_REACTORS: readonly ReactorWiring[] = [
    { key: "pricing", route: pricingReactorRoutes },
    { key: "audit", route: auditReactorRoutes },
    { key: "notify", route: notifyReactorRoutes },
];

/** Run a real activity body inside a mocked Temporal Activity Context. */
function run<A extends unknown[], R>(fn: (...args: A) => Promise<R>, ...args: A): Promise<R> {
    return env.run(fn, ...args);
}

describe("Phase 3 broadcast: one TripCompleted fans out to three independent reactors (dockerless, MemoryAdapter)", () => {
    let adapter: EventAdapter;
    let publisher: ManagedBus;
    let reactorBuses: ManagedBus[];

    before(async () => {
        // ONE shared in-memory adapter feeds all four buses: a publish on the
        // publisher bus reaches every reactor's subscription on the SAME
        // adapter. Groups are ignored in-memory but written so the wiring fans
        // out on NATS (the GROUPS test below checks they are written).
        adapter = MemoryAdapter();
        publisher = buildPublisherBus({ adapter });
        reactorBuses = buildReactorBuses({ reactors: ALL_REACTORS, adapter });
        assert.equal(reactorBuses.length, ALL_REACTORS.length, "one bus per reactor");
        await Promise.all([publisher.start(), ...reactorBuses.map((bus) => bus.start())]);
        // Inject the publisher bus into the activities module — the SAME seam
        // the worker uses — so the REAL activity publishes on it.
        activities.setPublisherBus(publisher);
    });

    beforeEach(() => {
        resetAllReactors();
    });

    afterEach(() => {
        resetAllReactors();
    });

    after(async () => {
        // Stop ONLY after every assertion (the FIRST stop calls the shared
        // adapter's disconnect(), which wipes all subscriptions).
        activities.setPublisherBus(undefined);
        await Promise.all([publisher.stop(), ...reactorBuses.map((bus) => bus.stop())]);
    });

    it("PRIMARY: the terminal publishTripCompleted activity broadcasts ONCE, all three reactors react with the FULL message shape", async () => {
        // Drive the actual publish SITE: the real activity body, not a hand-built
        // publish. `amountCents` is recomputed in the activity from durationMs
        // (60_000ms → 60s × 5 cents/s = 300n).
        await run(activities.publishTripCompleted, { tripId: "trip-x", userId: "u-1", vehicleId: "v-1", durationMs: 60_000 });

        // ALL THREE reacted to the SINGLE publish.
        assert.equal(pricingTripCountValue(), 1, "pricing reactor counted the trip");
        assert.equal(pricingRevenueCentsValue(), 300n, "pricing reactor tallied the settled revenue");

        assert.equal(sentReceipts().length, 1, "notifications reactor sent one receipt");
        assert.equal(sentReceipts()[0]?.userId, "u-1", "the receipt targets the renter");

        // Full-shape oracle (contract-conformance): the audit record equals the
        // documented five-field TripCompleted contract, field-by-field, proving
        // the decoded payload — not just that "an event arrived".
        const records = auditRecords();
        assert.equal(records.length, 1, "audit reactor appended exactly one record");
        assert.deepEqual(records[0], {
            tripId: "trip-x",
            userId: "u-1",
            vehicleId: "v-1",
            amountCents: 300n,
            durationMs: 60_000n,
        });
    });

    it("TOPIC: the event method resolves to exactly \"trips.completed\" from the proto option (no typeName fallback, no raw {topic})", () => {
        const topic = resolveTopicName(TripEventHandlers.method.onTripCompleted);
        assert.equal(topic, "trips.completed");
        // Guard the fallback explicitly: the typeName is NOT the topic.
        assert.notEqual(topic, TripCompletedSchema.typeName);
    });

    it("NEGATIVE: an off-topic subscriber (trips.other) receives 0 — the broadcast is scoped to trips.completed", async () => {
        let offTopicHits = 0;
        const sub: EventSubscription = await adapter.subscribe(["trips.other"], async (_event, ack) => {
            offTopicHits += 1;
            await ack();
        });
        try {
            await run(activities.publishTripCompleted, { tripId: "trip-neg", userId: "u-9", vehicleId: "v-9", durationMs: 30_000 });
            // The on-topic reactors DID receive (proving the publish happened)...
            assert.equal(pricingTripCountValue(), 1);
            // ...but the off-topic subscriber did NOT.
            assert.equal(offTopicHits, 0, "off-topic subscriber must not receive trips.completed");
        } finally {
            await sub.unsubscribe();
        }
    });

    it("IDEMPOTENT: a redelivery of the same tripId does NOT double-count revenue, double-audit, or double-notify", async () => {
        const payload = create(TripCompletedSchema, { tripId: "trip-dupe", userId: "u-2", vehicleId: "v-2", amountCents: 150n, durationMs: 30_000n });
        const bytes = toBinary(TripCompletedSchema, payload);

        // Publish the SAME tripId twice straight through the adapter (simulating a
        // broker redelivery / at-least-once), bypassing the publisher bus so we
        // control the exact bytes and topic.
        await adapter.publish("trips.completed", bytes);
        await adapter.publish("trips.completed", bytes);

        assert.equal(pricingTripCountValue(), 1, "trip counted once despite redelivery");
        assert.equal(pricingRevenueCentsValue(), 150n, "revenue tallied once despite redelivery");
        assert.equal(auditRecords().length, 1, "audited once despite redelivery");
        assert.equal(sentReceipts().length, 1, "notified once despite redelivery");
    });

    it("GROUPS: each reactor bus subscribes to trips.completed under its OWN consumer group (cs-pricing / cs-audit / cs-notify)", async () => {
        // A separate adapter so this test's buses never see the shared one's
        // traffic. It delegates to MemoryAdapter and records every subscribe
        // request — the topic patterns and the group a broker would receive.
        const inner = MemoryAdapter();
        const requested: Array<{ readonly patterns: readonly string[]; readonly group: string | undefined }> = [];
        const recording: EventAdapter = {
            name: inner.name,
            connect: (context) => inner.connect(context),
            disconnect: () => inner.disconnect(),
            publish: (eventType, payload, options) => inner.publish(eventType, payload, options),
            subscribe: (patterns, handler, options?: RawSubscribeOptions) => {
                requested.push({ patterns: [...patterns], group: options?.group });
                return inner.subscribe(patterns, handler, options);
            },
        };

        const buses = buildReactorBuses({ reactors: ALL_REACTORS, adapter: recording });
        await Promise.all(buses.map((bus) => bus.start()));
        try {
            const byGroup = [...requested].sort((a, b) => (a.group ?? "").localeCompare(b.group ?? ""));
            assert.deepEqual(byGroup, [
                { patterns: ["trips.completed"], group: REACTOR_GROUP.audit },
                { patterns: ["trips.completed"], group: REACTOR_GROUP.notify },
                { patterns: ["trips.completed"], group: REACTOR_GROUP.pricing },
            ]);
            assert.deepEqual([REACTOR_GROUP.audit, REACTOR_GROUP.notify, REACTOR_GROUP.pricing], ["cs-audit", "cs-notify", "cs-pricing"]);
        } finally {
            await Promise.all(buses.map((bus) => bus.stop()));
        }
    });

    it("GROUPS: wiring the same reactor twice is rejected — a shared group would load-balance instead of fan out", () => {
        assert.throws(
            () =>
                buildReactorBuses({
                    reactors: [
                        { key: "audit", route: auditReactorRoutes },
                        { key: "audit", route: auditReactorRoutes },
                    ],
                    adapter: MemoryAdapter(),
                }),
            /duplicate consumer group "cs-audit"/,
        );
    });
});
