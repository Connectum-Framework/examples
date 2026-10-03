/**
 * Test fixture for service-to-service auth: a real `trips` and a real `worker`
 * signer, each publishing its public key on its own in-process JWKS endpoint,
 * plus the issuer map a server under test must trust.
 *
 * It uses the production module (`#internalAuth.ts`) end to end — key
 * generation, token minting, JWKS serving and the issuer settings handed to
 * `signedTokenTrust` — so the suites exercise the same verification path as a
 * deployment, only with loopback URLs and ephemeral ports.
 *
 * @module tests/helpers/internalAuth
 */

import type { DescService } from "@bufbuild/protobuf";
import type { Client } from "@connectrpc/connect";
import { createClient } from "@connectrpc/connect";
import type { InternalIssuers, InternalSigner, JwksServer } from "#internalAuth.ts";
import { createInternalSigner, createSignedTransport, InternalIdentity, internalIssuer, startJwksServer } from "#internalAuth.ts";

/** Both service identities with their JWKS endpoints running. */
export interface InternalAuthFixture {
    /** Signs as `trips` (the StartTrip pre-check's identity). */
    readonly trips: InternalSigner;
    /** Signs as `worker` (the Temporal activities' identity). */
    readonly worker: InternalSigner;
    /** Issuer map that trusts exactly these two signers. */
    readonly issuers: InternalIssuers;
    /** Stop both JWKS endpoints. */
    close(): Promise<void>;
}

/** Start a `trips` and a `worker` signer, each on its own loopback JWKS port. */
export async function startInternalAuth(): Promise<InternalAuthFixture> {
    const trips = await createInternalSigner(InternalIdentity.trips);
    const worker = await createInternalSigner(InternalIdentity.worker);
    const tripsJwks: JwksServer = await startJwksServer({ signer: trips, port: 0, host: "127.0.0.1" });
    const workerJwks: JwksServer = await startJwksServer({ signer: worker, port: 0, host: "127.0.0.1" });
    return {
        trips,
        worker,
        issuers: {
            [InternalIdentity.trips]: internalIssuer(tripsJwks.url),
            [InternalIdentity.worker]: internalIssuer(workerJwks.url),
        },
        close: async () => {
            await Promise.all([tripsJwks.close(), workerJwks.close()]);
        },
    };
}

/**
 * A gRPC client for `service` at `baseUrl` whose every request carries
 * `signer`'s service token — what another service of the app would send.
 */
export function signedClient<S extends DescService>(service: S, baseUrl: string, signer: InternalSigner): Client<S> {
    return createClient(service, createSignedTransport(baseUrl, signer));
}
