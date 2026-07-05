/**
 * Trip lifecycle status domain — a side-effect-free `const` object.
 *
 * This module is imported by BOTH the Temporal workflow (`workflows.ts`, which
 * runs in the deterministic, bundled sandbox) and the Node-side services /
 * activities. It therefore MUST stay import-clean: no Node built-ins, no
 * Connectum/generated runtime, no Drizzle — only this literal map. Importing a
 * module with side effects (e.g. `db/schema.ts`, which pulls in drizzle) into
 * the workflow bundle would break determinism, so the trip-status domain lives
 * here on its own rather than next to {@link VehicleStatus}.
 *
 * The status is a plain string on the wire (no proto enum — the example's
 * `erasableSyntaxOnly` tsconfig rejects the native `enum` protoc-gen-es emits),
 * with the domain pinned by this `const` object.
 *
 * @module temporal/tripStatus
 */

/**
 * Trip lifecycle states.
 *
 *  - `STARTED`   — vehicle reserved, trip row created, drive in progress.
 *  - `ENDED`     — drive finished, duration known, billing not yet settled.
 *  - `SETTLED`   — billing tab finalized; the terminal happy-path state.
 *  - `CANCELLED` — the saga rolled back (a compensation closed the trip).
 */
export const TripStatus = {
    STARTED: "STARTED",
    ENDED: "ENDED",
    SETTLED: "SETTLED",
    CANCELLED: "CANCELLED",
} as const;

/** One of the {@link TripStatus} string values. */
export type TripStatus = (typeof TripStatus)[keyof typeof TripStatus];
