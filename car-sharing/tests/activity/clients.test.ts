/**
 * Worker catalog client — the endpoint fallback when `*_ADDR` is not set.
 *
 * The role servers route `ctx.call` with `perServiceEnvResolver` alone, where an
 * unset address means "no route" (`Code.Unavailable`, "the resolver returned
 * null"). The worker deliberately differs: with no `FLEET_ADDR` it must still
 * dial the local compose port, so `pnpm worker` works next to
 * `docker compose up` without env. The activity test always sets every
 * `*_ADDR`, so without this file a broken fallback — the worker silently
 * reporting "no route" for every activity — would go unnoticed.
 *
 * The test does not depend on anything listening on the compose port: a refused
 * connection, a timeout and a real answer all prove a route WAS resolved. Only
 * the resolver's own "returned null" error proves it was not. A service that is
 * in the catalog but has no endpoint at all is the control case showing that
 * this error message is what a missing route really looks like.
 *
 * Each test file runs in its own process under `node --test`, so clearing the
 * env here cannot leak into the activity test.
 *
 * @module tests/activity/clients
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { create } from "@bufbuild/protobuf";
import { ConnectError } from "@connectrpc/connect";
import { GetVehicleRequestSchema } from "#gen/fleet/v1/fleet_pb.ts";
import { TripCompletedSchema } from "#gen/trips/v1/trip_events_pb.ts";
import { createServiceClient } from "#temporal/clients.ts";

/** The error text the catalog client produces when the resolver finds no route. */
const NO_ROUTE = /resolver returned null/;

/** Settle a promise into its error (or `undefined` on success) without throwing. */
async function outcome(promise: Promise<unknown>): Promise<unknown> {
    try {
        await promise;
        return undefined;
    } catch (err) {
        return err;
    }
}

describe("Worker catalog client: endpoint resolution without *_ADDR", () => {
    const saved = process.env.FLEET_ADDR;

    before(() => {
        delete process.env.FLEET_ADDR;
    });

    after(() => {
        if (saved === undefined) {
            delete process.env.FLEET_ADDR;
        } else {
            process.env.FLEET_ADDR = saved;
        }
    });

    it("an unset FLEET_ADDR falls back to the local compose port instead of reporting no route", async () => {
        const client = createServiceClient();
        const err = await outcome(client.call("fleet.v1.FleetService/GetVehicle", create(GetVehicleRequestSchema, { id: "v-001" }), { timeoutMs: 1000 }));
        const noRoute = err instanceof ConnectError && NO_ROUTE.test(err.message);
        assert.equal(noRoute, false, `expected a resolved route to the default fleet endpoint, got: ${String(err)}`);
    });

    it("control: a catalog service with neither an env var nor a default has no route", async () => {
        const client = createServiceClient();
        const err = await outcome(client.call("trips.v1.TripEventHandlers/OnTripCompleted", create(TripCompletedSchema, { tripId: "t-1" }), { timeoutMs: 1000 }));
        assert.ok(err instanceof ConnectError, `expected a ConnectError, got: ${String(err)}`);
        assert.match(err.message, NO_ROUTE);
    });
});
