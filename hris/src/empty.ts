/**
 * Small helper for RPCs that return `google.protobuf.Empty`.
 *
 * The onboarding-saga compensations (revokeAccess, teardownPayroll,
 * revokeTimeOff) are declared `returns (google.protobuf.Empty)` in proto. Their
 * handlers must return an `Empty` message instance; this wraps the one-liner so
 * each service does not repeat the well-known-type import.
 *
 * @module empty
 */

import { create } from "@bufbuild/protobuf";
import type { Empty } from "@bufbuild/protobuf/wkt";
import { EmptySchema } from "@bufbuild/protobuf/wkt";

/** Build an empty `google.protobuf.Empty` message. */
export function empty(): Empty {
    return create(EmptySchema, {});
}
