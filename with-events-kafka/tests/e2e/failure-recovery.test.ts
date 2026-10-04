import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MAX_RETRIES } from "../../src/retryPolicy.ts";
import {
    INVENTORY_URL,
    compose,
    createOrder,
    eventually,
    getOrders,
    getReservations,
    isHealthy,
    reservationOf,
    statusOf,
} from "./support.ts";

// What a failing handler costs: the retry middleware runs it MAX_RETRIES more
// times, then the failure reaches the adapter and the message is delivered
// again. A FLAKY order fails all of the first delivery's runs and succeeds on
// the next one.
const FLAKY_RUNS_UNTIL_SUCCESS = MAX_RETRIES + 2;

// The first delivery spends 1 s + 2 s + 4 s in retry backoff before it fails;
// then the adapter pauses the partition for its redelivery delay, and an idle
// consumer sees the message again on its next fetch cycle (about 5 s). The
// deadline sits well above that sum so that a slow machine does not fail it.
const REDELIVERY_DEADLINE_MS = 90_000;

// A restarted consumer first has to join its group again, which can wait for
// the stopped member's session to expire before the partition is reassigned.
const RESTART_DEADLINE_MS = 120_000;

describe("EventBus with Kafka — failure and restart", () => {
    it("a handler that fails is redelivered and neither it nor its neighbours are lost or repeated", async () => {
        const before = await createOrder("Widget");
        const flaky = await createOrder("FLAKY");
        const after = await createOrder("Gadget");

        await eventually(
            getOrders,
            (orders) => [before, flaky, after].every((id) => statusOf(orders, id) === "confirmed"),
            `orders ${before}, ${flaky} (its handler fails first) and ${after} to be confirmed; an order that never gets confirmed had its OrderCreated message lost`,
            REDELIVERY_DEADLINE_MS,
        );

        const reservations = await getReservations();
        assert.equal(reservationOf(reservations, flaky)?.deliveries, FLAKY_RUNS_UNTIL_SUCCESS, "the failing order is handled successfully once, after the redelivery");
        assert.equal(reservationOf(reservations, before)?.deliveries, 1, "the order before the failing one is handled once");
        assert.equal(reservationOf(reservations, after)?.deliveries, 1, "the order after the failing one is handled once, not repeated by the redelivery");
    });

    it("a failed handler is reported in the service log with topic, partition and offset", async () => {
        const flaky = await createOrder("FLAKY");
        await eventually(getOrders, (orders) => statusOf(orders, flaky) === "confirmed", `order ${flaky} to be confirmed`, REDELIVERY_DEADLINE_MS);

        const log = await compose("logs", "--no-color", "--no-log-prefix", "inventory-service");
        const reported = log.split("\n").filter((line) => line.includes("handler error for"));
        assert.ok(
            reported.some((line) => /handler error for orders\.v1\.OrderCreated\[\d+\]@\d+:/.test(line)),
            `the log has no "handler error for <topic>[<partition>]@<offset>" line; got ${reported.length} lines mentioning "handler error for"`,
        );
        // Only the failure that the retry middleware could not absorb reaches the
        // adapter, so the logged run is the last of the first delivery.
        const failedRun = `Simulated failure for product FLAKY (order ${flaky}, run ${MAX_RETRIES + 1})`;
        assert.ok(log.includes(failedRun), `the log does not show "${failedRun}"`);
    });

    it("a consumer restarted after downtime gets what was published meanwhile, once, and nothing it already acknowledged", async () => {
        const acknowledged = await createOrder("Widget");
        await eventually(getOrders, (orders) => statusOf(orders, acknowledged) === "confirmed", `order ${acknowledged} to be confirmed before the stop`);

        await compose("stop", "inventory-service");
        assert.equal(await isHealthy(INVENTORY_URL), false, "the inventory service is still answering after the stop");

        const duringDowntime = [await createOrder("Gadget"), await createOrder("Gizmo")];
        const pending = await getOrders();
        for (const id of duringDowntime) {
            assert.equal(statusOf(pending, id), "pending", "no one can confirm an order while the inventory service is stopped");
        }

        await compose("start", "inventory-service");
        await eventually(() => isHealthy(INVENTORY_URL), (healthy) => healthy, "the inventory service to answer again", RESTART_DEADLINE_MS);

        await eventually(
            getOrders,
            (orders) => duringDowntime.every((id) => statusOf(orders, id) === "confirmed"),
            `orders ${duringDowntime.join(", ")} (published while the inventory service was stopped) to be confirmed; an order that never gets confirmed had its OrderCreated message lost`,
            RESTART_DEADLINE_MS,
        );

        // The restarted service starts with an empty reservation list, so an
        // acknowledged order that shows up in it was delivered a second time.
        const reservations = await getReservations();
        for (const id of duringDowntime) {
            assert.equal(reservationOf(reservations, id)?.deliveries, 1, `order ${id}, published during the downtime, is handled once`);
        }
        assert.equal(reservationOf(reservations, acknowledged), undefined, `order ${acknowledged} was acknowledged before the stop and must not be delivered again`);
    });
});
