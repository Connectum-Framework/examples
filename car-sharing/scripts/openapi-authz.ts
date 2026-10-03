// Overlay Connectum authz onto the base OpenAPI.
//
// The base spec (sudorandom/protoc-gen-connect-openapi) knows the Connect API
// but NOT Connectum's authz. This step reads the connectum.auth.v1 proto options
// via `resolveMethodAuth` — the SAME reader the runtime `createProtoAuthzInterceptor`
// uses — and injects, per operation, an OpenAPI `security` requirement plus
// `x-connectum-*` extensions. One resolver drives BOTH runtime enforcement and
// the published contract, so the spec can't drift from what's actually enforced.
//
// Run via `pnpm openapi` (generates the base from buf.gen.openapi.yaml, then this
// overlay). NOTE: streaming RPCs (e.g. ListVehicles) are omitted from the base
// unless the plugin's `with-streaming` opt is set, so they get no operation here.
//
// Three kinds of operation, mirroring the runtime chain:
//  - `public`   → no credential at all;
//  - `internal` → a per-service signed token in `x-internal-token` (an end-user
//                 JWT is NOT accepted there), so it gets its own security scheme;
//  - otherwise  → the end-user Bearer JWT.

import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse, stringify } from "yaml";
import { resolveMethodAuth } from "@connectum/auth/proto";
import { BillingService } from "#gen/billing/v1/billing_pb.ts";
import { FleetService } from "#gen/fleet/v1/fleet_pb.ts";
import { TripService } from "#gen/trips/v1/trips_pb.ts";

/** Each generated service ↔ its base OpenAPI file (relative to the package root). */
const SPECS = [
    { svc: TripService, file: "openapi/trips/v1/trips.openapi.yaml" },
    { svc: FleetService, file: "openapi/fleet/v1/fleet.openapi.yaml" },
    { svc: BillingService, file: "openapi/billing/v1/billing.openapi.yaml" },
] as const;

/** The JWT bearer scheme the gateway enforces (createJwtAuthInterceptor). */
const BEARER_AUTH = {
    type: "http",
    scheme: "bearer",
    bearerFormat: "JWT",
    description: "End-user JWT (createJwtAuthInterceptor / proto authz). Required for every method that is neither public nor internal.",
};

/** The service-to-service token internal methods require (createInternalAuthInterceptor + signedTokenTrust). */
const INTERNAL_TOKEN_AUTH = {
    type: "apiKey",
    in: "header",
    name: "x-internal-token",
    description:
        "Service-to-service only. A short-lived RS256 JWT the CALLING SERVICE signs with its own key (iss = the service, aud = car-sharing-internal, roles = [the service]); verified against that service's JWKS. End-user JWTs are not accepted. x-connectum-required-roles names the services allowed to call.",
};

for (const { svc, file } of SPECS) {
    const path = fileURLToPath(new URL(`../${file}`, import.meta.url));
    // biome-ignore lint/suspicious/noExplicitAny: structurally patching a parsed OpenAPI doc.
    const doc: any = parse(readFileSync(path, "utf8"));

    doc.components ??= {};
    doc.components.securitySchemes ??= {};
    doc.components.securitySchemes.bearerAuth = BEARER_AUTH;
    doc.components.securitySchemes.internalToken = INTERNAL_TOKEN_AUTH;

    let publicCount = 0;
    let internalCount = 0;
    let securedCount = 0;
    for (const method of svc.methods) {
        const op = doc.paths?.[`/${svc.typeName}/${method.name}`]?.post;
        if (op === undefined) continue;
        const auth = resolveMethodAuth(method);
        if (auth.public) {
            op.security = []; // explicitly open — overrides any global requirement
            op["x-connectum-public"] = true;
            publicCount += 1;
            continue;
        }
        if (auth.internal) {
            op.security = [{ internalToken: [] }];
            op["x-connectum-internal"] = true;
            internalCount += 1;
        } else {
            op.security = [{ bearerAuth: [] }];
            securedCount += 1;
        }
        if (auth.requires && auth.requires.roles.length > 0) op["x-connectum-required-roles"] = [...auth.requires.roles];
        if (auth.requires && auth.requires.scopes.length > 0) op["x-connectum-required-scopes"] = [...auth.requires.scopes];
    }

    // Drop a scheme no operation of this spec uses, so a reader is not told a
    // credential exists that the service never accepts.
    if (internalCount === 0) delete doc.components.securitySchemes.internalToken;
    if (securedCount === 0) delete doc.components.securitySchemes.bearerAuth;

    writeFileSync(path, stringify(doc));
    console.log(`overlay ${file}: ${securedCount} user-JWT, ${internalCount} internal, ${publicCount} public (of ${svc.methods.length} methods)`);
}

// The base plugin also emits a schemas-only spec for the imported
// connectum/auth/v1/options.proto (no service of our own) — drop that noise so
// only this example's API specs remain.
rmSync(fileURLToPath(new URL("../openapi/connectum", import.meta.url)), { recursive: true, force: true });

