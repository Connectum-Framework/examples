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
 *
 * @module tests/e2e/broadcast
 */

import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { create, toBinary } from "@bufbuild/protobuf";
import { MemoryAdapter, resolveTopicName } from "@connectum/events";
import type { EventAdapter, EventSubscription } from "@connectum/events";
import { MockActivityEnvironment } from "@temporalio/testing";
import { TripCompletedSchema, TripEventHandlers } from "#gen/trips/v1/trip_events_pb.ts";
import { buildPublisherBus, buildReactorBus } from "#events/eventBus.ts";
import type { ManagedBus } from "#events/eventBus.ts";
import { auditRecords, notifyReactorRoutes, auditReactorRoutes, pricingReactorRoutes, pricingRevenueCentsValue, pricingTripCountValue, resetAllReactors, sentReceipts } from "#events/reactors.ts";
import * as activities from "#temporal/activities.ts";

const env = new MockActivityEnvironment();

/** Run a real activity body inside a mocked Temporal Activity Context. */
function run<A extends unknown[], R>(fn: (...args: A) => Promise<R>, ...args: A): Promise<R> {
    return env.run(fn, ...args);
}

describe("Phase 3 broadcast: one TripCompleted fans out to three independent reactors (dockerless, MemoryAdapter)", () => {
    let adapter: EventAdapter;
    let publisher: ManagedBus;
    let pricing: ManagedBus;
    let audit: ManagedBus;
    let notify: ManagedBus;

    before(async () => {
        // ONE shared in-memory adapter feeds all four buses (F8): a publish on
        // the publisher bus reaches every reactor's subscription on the SAME
        // adapter. Groups are ignored in-memory but written so the wiring fans
        // out on NATS.
        adapter = MemoryAdapter();
        publisher = buildPublisherBus({ adapter });
        pricing = buildReactorBus({ key: "pricing", route: pricingReactorRoutes, adapter });
        audit = buildReactorBus({ key: "audit", route: auditReactorRoutes, adapter });
        notify = buildReactorBus({ key: "notify", route: notifyReactorRoutes, adapter });
        await Promise.all([publisher.start(), pricing.start(), audit.start(), notify.start()]);
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
        await Promise.all([publisher.stop(), pricing.stop(), audit.stop(), notify.stop()]);
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
});
