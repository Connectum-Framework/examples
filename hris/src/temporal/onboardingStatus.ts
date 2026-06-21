/**
 * Onboarding lifecycle status domain — a side-effect-free `const` object.
 *
 * This module is imported by BOTH the Temporal workflow (`workflows.ts`, which
 * runs in the deterministic, bundled sandbox) and the Node-side services /
 * activities. It therefore MUST stay import-clean: no Node built-ins, no
 * Connectum/generated runtime, no Drizzle — only this literal map. Importing a
 * module with side effects (e.g. `db/schema.ts`, which pulls in drizzle) into
 * the workflow bundle would break determinism, so the onboarding-status domain
 * lives here on its own.
 *
 * The status is a plain string on the wire (no proto enum — the example's
 * `erasableSyntaxOnly` tsconfig rejects the native `enum` protoc-gen-es emits),
 * with the domain pinned by this `const` object (ADR-001: no `enum`).
 *
 * @module temporal/onboardingStatus
 */

/**
 * Onboarding saga lifecycle states.
 *
 *  - `STARTED`   — the saga is running (provisioning the new hire across services).
 *  - `COMPLETED` — every forward step succeeded and the employee is now active;
 *                  the terminal happy-path state.
 *  - `FAILED`    — a step failed and the saga rolled back (compensations ran).
 */
export const OnboardingStatus = {
    STARTED: "STARTED",
    COMPLETED: "COMPLETED",
    FAILED: "FAILED",
} as const;

/** One of the {@link OnboardingStatus} string values. */
export type OnboardingStatus = (typeof OnboardingStatus)[keyof typeof OnboardingStatus];
