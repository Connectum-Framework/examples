import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

export const ORDER_URL = process.env.ORDER_URL ?? "http://localhost:5001";
export const INVENTORY_URL = process.env.INVENTORY_URL ?? "http://localhost:5002";

export async function connectPost(baseUrl: string, method: string, body: Record<string, unknown> = {}): Promise<unknown> {
    const res = await fetch(`${baseUrl}/${method}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });
    if (!res.ok) {
        const text = await res.text();
        throw new Error(`${res.status} ${method}: ${text}`);
    }
    return res.json();
}

export function sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
}

/**
 * Poll `read` until `done` holds. The saga runs through the broker
 * asynchronously, so a fixed pause is either too short on a slow machine (a
 * false failure) or longer than needed. The deadline is generous; when it
 * passes, the error shows the last value read.
 */
export async function eventually<T>(read: () => Promise<T>, done: (value: T) => boolean, what: string, timeoutMs = 30_000): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    let last = await read();
    while (!done(last)) {
        if (Date.now() > deadline) {
            throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}; last value: ${JSON.stringify(last)}`);
        }
        await sleep(200);
        last = await read();
    }
    return last;
}

export type Order = { orderId: string; status: string };
export type Reservation = { orderId: string; status: string; product: string; deliveries: number };

// JSON omits an empty repeated field, so an empty list arrives as an absent key.
export const getOrders = async (): Promise<Order[]> =>
    ((await connectPost(ORDER_URL, "orders.v1.OrderService/GetOrders", {})) as { orders?: Order[] }).orders ?? [];
export const getReservations = async (): Promise<Reservation[]> =>
    ((await connectPost(INVENTORY_URL, "orders.v1.InventoryService/GetInventory", {})) as { reservations?: Reservation[] }).reservations ?? [];

export const statusOf = (orders: Order[], orderId: string): string | undefined => orders.find((o) => o.orderId === orderId)?.status;
export const reservationOf = (reservations: Reservation[], orderId: string): Reservation | undefined => reservations.find((r) => r.orderId === orderId);

export async function createOrder(product: string, quantity = 1, customer = "e2e"): Promise<string> {
    const { orderId } = (await connectPost(ORDER_URL, "orders.v1.OrderService/CreateOrder", { product, quantity, customer })) as { orderId: string };
    return orderId;
}

const exampleDir = fileURLToPath(new URL("../../", import.meta.url));
const execFileAsync = promisify(execFile);

/**
 * Run `docker compose` against the stack the example's tests talk to. The
 * restart scenarios stop and start a service of that stack, so the tests have
 * to run where the stack was started; without it they fail with this message
 * instead of being skipped.
 */
export async function compose(...args: string[]): Promise<string> {
    try {
        const { stdout } = await execFileAsync("docker", ["compose", ...args], { cwd: exampleDir, maxBuffer: 32 * 1024 * 1024 });
        return stdout;
    } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`docker compose ${args.join(" ")} failed in ${exampleDir}: ${detail}. These scenarios drive the compose stack; start it there with "docker compose up -d --build --wait" first.`);
    }
}

export async function isHealthy(baseUrl: string): Promise<boolean> {
    try {
        return (await fetch(`${baseUrl}/healthz`)).status === 200;
    } catch {
        return false;
    }
}
