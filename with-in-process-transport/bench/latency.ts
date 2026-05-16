/**
 * Micro-benchmark: local in-process transport vs HTTP/2 loopback latency.
 *
 * Unary RPC (InventoryService.CheckStock), warmup + measurement run, p50/p95/p99.
 *
 * NOT for CI — run manually: `pnpm bench`
 */

import { createClient } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import { InventoryService } from "../gen/inventory/v1/inventory_pb.ts";
import { buildServer } from "../src/server.ts";

const WARMUP = 500;
const ITERS = 10_000;

function percentile(sorted: number[], p: number): number {
    const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
    return sorted[idx] ?? 0;
}

async function measure(name: string, call: () => Promise<unknown>) {
    for (let i = 0; i < WARMUP; i++) {
        await call();
    }
    const samples: number[] = new Array(ITERS);
    for (let i = 0; i < ITERS; i++) {
        const t0 = process.hrtime.bigint();
        await call();
        const t1 = process.hrtime.bigint();
        samples[i] = Number(t1 - t0) / 1_000; // microseconds
    }
    samples.sort((a, b) => a - b);
    const sum = samples.reduce((a, b) => a + b, 0);
    return {
        name,
        iters: ITERS,
        meanUs: +(sum / ITERS).toFixed(2),
        p50Us: +percentile(samples, 50).toFixed(2),
        p95Us: +percentile(samples, 95).toFixed(2),
        p99Us: +percentile(samples, 99).toFixed(2),
        minUs: +samples[0]!.toFixed(2),
        maxUs: +samples[samples.length - 1]!.toFixed(2),
    };
}

async function main() {
    const server = buildServer(0);
    await server.start();
    const port = server.address?.port ?? 0;

    const localClient = server.localClient(InventoryService);
    const httpTransport = createGrpcTransport({
        baseUrl: `http://localhost:${port}`,
    });
    const httpClient = createClient(InventoryService, httpTransport);

    const req = { sku: "SKU-1" };

    console.log(`Benchmark: unary CheckStock | warmup=${WARMUP} iters=${ITERS}\n`);

    const local = await measure("local-transport", () => localClient.checkStock(req));
    const http = await measure("http/2-loopback", () => httpClient.checkStock(req));

    const speedup = +(http.meanUs / local.meanUs).toFixed(2);

    console.log(JSON.stringify({ local, http, speedup_mean: `${speedup}x` }, null, 2));

    await server.stop();
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
