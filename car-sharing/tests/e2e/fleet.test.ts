/**
 * E2E tests — FleetService over Drizzle + PGlite.
 *
 * The fleet is the only persistent service: a PGlite in-process Postgres is
 * migrated + seeded in the test and injected into `buildServer({ db })`, the
 * same parameter production uses for its postgres.js client. Every assertion
 * goes through a REAL gRPC client over HTTP/2 — the server keeps the default
 * h2c posture (`allowHTTP1` unset → `false`), exercising the actual wire path,
 * not the db directly. (`allowHTTP1` is an opt-in for the Oathkeeper
 * Connect/HTTP1 edge; the gRPC/streaming path here is unaffected by that default.)
 *
 * FleetService is `internal` (see fleet.proto): every call carries a service
 * token, exactly as its real callers send one. Reads go out signed as `trips`
 * (the StartTrip pre-check's identity), reserve/release signed as `worker` (the
 * saga activities' identity), each the role proto grants for that RPC.
 *
 * Covered:
 *  - GetVehicle: point read returns the persisted Vehicle (incl. status +
 *    location); unknown id → NOT_FOUND.
 *  - ListVehicles (server-streaming): the unfiltered stream returns all seeds in
 *    id order; cursor pagination (page_size + page_token) walks pages; the
 *    available_only filter excludes reserved / maintenance vehicles.
 *  - ReserveVehicle: flips an available vehicle to reserved; reserving an
 *    already-reserved or maintenance vehicle → FAILED_PRECONDITION; unknown id
 *    → NOT_FOUND.
 *  - ReleaseVehicle: returns a reserved vehicle to the pool; maintenance →
 *    FAILED_PRECONDITION; unknown id → NOT_FOUND.
 *  - Least privilege per RPC: a call with no token is UNAUTHENTICATED; a valid
 *    token from a service the RPC does not list is PERMISSION_DENIED (trips
 *    cannot reserve, the worker cannot read).
 *
 * Reserve/Release mutate shared rows, so the db is re-seeded before each test.
 */

import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, createClient } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import type { Client } from "@connectrpc/connect";
import type { Server } from "@connectum/core";
import { FleetService, GetVehicleRequestSchema, ListVehiclesRequestSchema, ReleaseVehicleRequestSchema, ReserveVehicleRequestSchema } from "#gen/fleet/v1/fleet_pb.ts";
import type { Vehicle } from "#gen/fleet/v1/fleet_pb.ts";
import { buildServer } from "#server.ts";
import type { Db } from "#db/client.ts";
import { vehicles } from "#db/schema.ts";
import { resolveTopology } from "#topology.ts";
import { makeTestDb, reseed } from "../helpers/db.ts";
import type { InternalAuthFixture } from "../helpers/internalAuth.ts";
import { signedClient, startInternalAuth } from "../helpers/internalAuth.ts";

/** Drain a server-streaming response into an array. */
async function collect(stream: AsyncIterable<Vehicle>): Promise<Vehicle[]> {
    const out: Vehicle[] = [];
    for await (const v of stream) out.push(v);
    return out;
}

describe("E2E: FleetService persistence (Drizzle + PGlite, real gRPC client)", () => {
    let server: Server;
    let db: Db;
    let internalAuth: InternalAuthFixture;
    /** Signed as `trips` — the identity proto grants the fleet reads to. */
    let reader: Client<typeof FleetService>;
    /** Signed as `worker` — the identity proto grants reserve/release to. */
    let writer: Client<typeof FleetService>;
    /** No service token at all. */
    let anonymous: Client<typeof FleetService>;

    before(async () => {
        const topology = resolveTopology("*");
        db = await makeTestDb();
        internalAuth = await startInternalAuth();
        server = buildServer({ port: 0, topology, db, internalSigner: internalAuth.trips, internalIssuers: internalAuth.issuers });
        await server.start();
        const baseUrl = `http://localhost:${server.address?.port ?? 0}`;
        reader = signedClient(FleetService, baseUrl, internalAuth.trips);
        writer = signedClient(FleetService, baseUrl, internalAuth.worker);
        anonymous = createClient(FleetService, createGrpcTransport({ baseUrl }));
    });

    beforeEach(async () => {
        // Reserve/Release mutate shared rows; restore the seed before each test
        // so ordering does not couple tests.
        await reseed(db);
    });

    after(async () => {
        if (server.state === "running") await server.stop();
        await internalAuth.close();
    });

    it("GetVehicle returns the persisted vehicle with status and location", async () => {
        const res = await reader.getVehicle(create(GetVehicleRequestSchema, { id: "v-001" }));
        assert.equal(res.vehicle?.id, "v-001");
        assert.equal(res.vehicle?.model, "Tesla Model 3");
        assert.equal(res.vehicle?.available, true);
        assert.equal(res.vehicle?.status, "available");
        assert.equal(res.vehicle?.location?.lat, 52.52);
        assert.equal(res.vehicle?.location?.lng, 13.405);
    });

    it("GetVehicle on an unknown id is NOT_FOUND", async () => {
        await assert.rejects(
            reader.getVehicle(create(GetVehicleRequestSchema, { id: "ghost" })),
            (err: unknown) => err instanceof ConnectError && err.code === Code.NotFound,
        );
    });

    it("ListVehicles streams every seeded vehicle in id order (no filter)", async () => {
        const all = await collect(reader.listVehicles(create(ListVehiclesRequestSchema, {})));
        assert.equal(all.length, 7);
        assert.deepEqual(
            all.map((v) => v.id),
            ["v-001", "v-002", "v-003", "v-004", "v-005", "v-006", "v-007"],
        );
    });

    it("ListVehicles paginates with page_size + page_token (cursor over the stream)", async () => {
        // Page 1 — first three by id.
        const page1 = await collect(reader.listVehicles(create(ListVehiclesRequestSchema, { pageSize: 3 })));
        assert.deepEqual(
            page1.map((v) => v.id),
            ["v-001", "v-002", "v-003"],
        );

        // Page 2 — cursor = last streamed id of page 1.
        const cursor = page1[page1.length - 1]?.id ?? "";
        const page2 = await collect(reader.listVehicles(create(ListVehiclesRequestSchema, { pageSize: 3, pageToken: cursor })));
        assert.deepEqual(
            page2.map((v) => v.id),
            ["v-004", "v-005", "v-006"],
        );

        // Page 3 — the remainder (fewer than page_size).
        const cursor2 = page2[page2.length - 1]?.id ?? "";
        const page3 = await collect(reader.listVehicles(create(ListVehiclesRequestSchema, { pageSize: 3, pageToken: cursor2 })));
        assert.deepEqual(
            page3.map((v) => v.id),
            ["v-007"],
        );
    });

    it("ListVehicles with available_only excludes reserved and maintenance vehicles", async () => {
        const available = await collect(reader.listVehicles(create(ListVehiclesRequestSchema, { availableOnly: true })));
        // Seeds: v-003 is maintenance, v-006 is reserved → both excluded.
        assert.deepEqual(
            available.map((v) => v.id),
            ["v-001", "v-002", "v-004", "v-005", "v-007"],
        );
        assert.ok(available.every((v) => v.available === true));
    });

    it("ListVehicles combines available_only with cursor pagination", async () => {
        // available seeds in id order: v-001, v-002, v-004, v-005, v-007.
        const page1 = await collect(reader.listVehicles(create(ListVehiclesRequestSchema, { availableOnly: true, pageSize: 2 })));
        assert.deepEqual(
            page1.map((v) => v.id),
            ["v-001", "v-002"],
        );

        const cursor = page1[page1.length - 1]?.id ?? "";
        const page2 = await collect(reader.listVehicles(create(ListVehiclesRequestSchema, { availableOnly: true, pageSize: 2, pageToken: cursor })));
        // The cursor skips past v-003 (maintenance) — the filter + cursor compose.
        assert.deepEqual(
            page2.map((v) => v.id),
            ["v-004", "v-005"],
        );
        assert.ok(page2.every((v) => v.available === true));
    });

    it("ReserveVehicle flips an available vehicle to reserved", async () => {
        const reserved = await writer.reserveVehicle(create(ReserveVehicleRequestSchema, { id: "v-001" }));
        assert.equal(reserved.id, "v-001");
        assert.equal(reserved.available, false);
        assert.equal(reserved.status, "reserved");

        // The mutation is persisted — a subsequent read reflects it.
        const after = await reader.getVehicle(create(GetVehicleRequestSchema, { id: "v-001" }));
        assert.equal(after.vehicle?.available, false);
        assert.equal(after.vehicle?.status, "reserved");
    });

    it("ReserveVehicle on an already-reserved vehicle is FAILED_PRECONDITION", async () => {
        await writer.reserveVehicle(create(ReserveVehicleRequestSchema, { id: "v-001" }));
        await assert.rejects(
            writer.reserveVehicle(create(ReserveVehicleRequestSchema, { id: "v-001" })),
            (err: unknown) => err instanceof ConnectError && err.code === Code.FailedPrecondition,
        );
    });

    it("ReserveVehicle on a maintenance vehicle is FAILED_PRECONDITION", async () => {
        await assert.rejects(
            writer.reserveVehicle(create(ReserveVehicleRequestSchema, { id: "v-003" })),
            (err: unknown) => err instanceof ConnectError && err.code === Code.FailedPrecondition,
        );
    });

    it("ReserveVehicle on an unknown id is NOT_FOUND", async () => {
        await assert.rejects(
            writer.reserveVehicle(create(ReserveVehicleRequestSchema, { id: "ghost" })),
            (err: unknown) => err instanceof ConnectError && err.code === Code.NotFound,
        );
    });

    it("ReleaseVehicle returns a reserved vehicle to the available pool", async () => {
        await writer.reserveVehicle(create(ReserveVehicleRequestSchema, { id: "v-001" }));
        const released = await writer.releaseVehicle(create(ReleaseVehicleRequestSchema, { id: "v-001" }));
        assert.equal(released.id, "v-001");
        assert.equal(released.available, true);
        assert.equal(released.status, "available");
    });

    it("ReleaseVehicle persists: a later read shows the vehicle available again", async () => {
        await writer.reserveVehicle(create(ReserveVehicleRequestSchema, { id: "v-001", holderId: "trip-a" }));
        await writer.releaseVehicle(create(ReleaseVehicleRequestSchema, { id: "v-001" }));
        const after = await reader.getVehicle(create(GetVehicleRequestSchema, { id: "v-001" }));
        assert.equal(after.vehicle?.available, true);
        assert.equal(after.vehicle?.status, "available");
    });

    // holder_id is documented as: the same holder re-reserving its own vehicle
    // succeeds, a held vehicle with a different holder is FAILED_PRECONDITION,
    // and an empty holder never matches (a held vehicle is always a conflict).
    it("ReserveVehicle with the SAME holder_id is idempotent and returns the reserved vehicle", async () => {
        await writer.reserveVehicle(create(ReserveVehicleRequestSchema, { id: "v-001", holderId: "trip-a" }));
        const again = await writer.reserveVehicle(create(ReserveVehicleRequestSchema, { id: "v-001", holderId: "trip-a" }));
        assert.equal(again.id, "v-001");
        assert.equal(again.available, false);
        assert.equal(again.status, "reserved");
    });

    it("ReserveVehicle with a DIFFERENT or EMPTY holder_id on a held vehicle is FAILED_PRECONDITION", async () => {
        await writer.reserveVehicle(create(ReserveVehicleRequestSchema, { id: "v-001", holderId: "trip-a" }));
        for (const holderId of ["trip-b", ""]) {
            await assert.rejects(
                writer.reserveVehicle(create(ReserveVehicleRequestSchema, { id: "v-001", holderId })),
                (err: unknown) => err instanceof ConnectError && err.code === Code.FailedPrecondition,
                `holder "${holderId}" must not take a vehicle held by trip-a`,
            );
        }
        // The rejected attempts changed nothing: trip-a still owns the reservation.
        const stillHeld = await writer.reserveVehicle(create(ReserveVehicleRequestSchema, { id: "v-001", holderId: "trip-a" }));
        assert.equal(stillHeld.status, "reserved");
    });

    it("a released vehicle can be reserved by a different holder", async () => {
        await writer.reserveVehicle(create(ReserveVehicleRequestSchema, { id: "v-001", holderId: "trip-a" }));
        await writer.releaseVehicle(create(ReleaseVehicleRequestSchema, { id: "v-001" }));
        const taken = await writer.reserveVehicle(create(ReserveVehicleRequestSchema, { id: "v-001", holderId: "trip-b" }));
        assert.equal(taken.available, false);
        assert.equal(taken.status, "reserved");
        // The previous holder is now locked out.
        await assert.rejects(
            writer.reserveVehicle(create(ReserveVehicleRequestSchema, { id: "v-001", holderId: "trip-a" })),
            (err: unknown) => err instanceof ConnectError && err.code === Code.FailedPrecondition,
        );
    });

    it("ReleaseVehicle on a maintenance vehicle is FAILED_PRECONDITION", async () => {
        await assert.rejects(
            writer.releaseVehicle(create(ReleaseVehicleRequestSchema, { id: "v-003" })),
            (err: unknown) => err instanceof ConnectError && err.code === Code.FailedPrecondition,
        );
    });

    it("ReleaseVehicle on an unknown id is NOT_FOUND", async () => {
        await assert.rejects(
            writer.releaseVehicle(create(ReleaseVehicleRequestSchema, { id: "ghost" })),
            (err: unknown) => err instanceof ConnectError && err.code === Code.NotFound,
        );
    });

    it("a fleet call with NO service token is Unauthenticated", async () => {
        await assert.rejects(
            anonymous.getVehicle(create(GetVehicleRequestSchema, { id: "v-001" })),
            (err: unknown) => err instanceof ConnectError && err.code === Code.Unauthenticated,
        );
    });

    it("trips may read but NOT reserve: its valid token on ReserveVehicle is PermissionDenied and nothing changes", async () => {
        const tripsSigned = signedClient(FleetService, `http://localhost:${server.address?.port ?? 0}`, internalAuth.trips);
        await assert.rejects(
            tripsSigned.reserveVehicle(create(ReserveVehicleRequestSchema, { id: "v-001" })),
            (err: unknown) => err instanceof ConnectError && err.code === Code.PermissionDenied,
        );
        const after = await reader.getVehicle(create(GetVehicleRequestSchema, { id: "v-001" }));
        assert.equal(after.vehicle?.status, "available");
    });

    it("the worker may reserve but NOT read: its valid token on ListVehicles and GetVehicle is PermissionDenied", async () => {
        await assert.rejects(
            collect(writer.listVehicles(create(ListVehiclesRequestSchema, {}))),
            (err: unknown) => err instanceof ConnectError && err.code === Code.PermissionDenied,
        );
        await assert.rejects(
            writer.getVehicle(create(GetVehicleRequestSchema, { id: "v-001" })),
            (err: unknown) => err instanceof ConnectError && err.code === Code.PermissionDenied,
        );
    });
});

describe("E2E: FleetService page-size clamping over a large fleet", () => {
    const EXTRA_VEHICLES = 130;
    let server: Server;
    let internalAuth: InternalAuthFixture;
    let reader: Client<typeof FleetService>;
    let totalVehicles = 0;

    before(async () => {
        const db = await makeTestDb();
        // A fleet larger than any sane page, so a clamp is visible as a short page.
        const rows = Array.from({ length: EXTRA_VEHICLES }, (_, i) => ({
            id: `x-${String(i).padStart(4, "0")}`,
            model: "Bulk",
            available: true,
            status: "available",
            holder: null,
            lat: 0,
            lng: 0,
        }));
        await db.insert(vehicles).values(rows);
        totalVehicles = (await db.select().from(vehicles)).length;
        internalAuth = await startInternalAuth();
        server = buildServer({ port: 0, topology: resolveTopology("*"), db, internalSigner: internalAuth.trips, internalIssuers: internalAuth.issuers });
        await server.start();
        reader = signedClient(FleetService, `http://localhost:${server.address?.port ?? 0}`, internalAuth.trips);
    });

    after(async () => {
        if (server.state === "running") await server.stop();
        await internalAuth.close();
    });

    // The proto documents page_size as: "Server clamps to a sane default/max
    // when 0 or large".
    it("page_size 0 streams a default page: at least one vehicle, fewer than the whole fleet", async () => {
        const page = await collect(reader.listVehicles(create(ListVehiclesRequestSchema, { pageSize: 0 })));
        assert.ok(page.length >= 1, "the default page must not be empty");
        assert.ok(page.length < totalVehicles, `the default page must be clamped, got ${page.length} of ${totalVehicles}`);
    });

    it("a very large page_size is clamped to a maximum below the whole fleet", async () => {
        const page = await collect(reader.listVehicles(create(ListVehiclesRequestSchema, { pageSize: 1_000_000 })));
        assert.ok(page.length >= 1);
        assert.ok(page.length < totalVehicles, `the maximum page must be clamped, got ${page.length} of ${totalVehicles}`);
    });

    it("following the cursor through default-sized pages visits every vehicle once, in id order", async () => {
        const ids: string[] = [];
        let cursor = "";
        for (let guard = 0; guard < 100; guard++) {
            const page = await collect(reader.listVehicles(create(ListVehiclesRequestSchema, { pageToken: cursor })));
            if (page.length === 0) break;
            ids.push(...page.map((v) => v.id));
            cursor = page[page.length - 1]?.id ?? "";
        }
        assert.equal(ids.length, totalVehicles);
        assert.deepEqual(ids, [...ids].sort());
        assert.equal(new Set(ids).size, totalVehicles, "no vehicle may appear on two pages");
    });
});
