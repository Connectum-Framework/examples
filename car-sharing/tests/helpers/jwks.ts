/**
 * Example-local RS256 + JWKS test helper — simulates the Ory Oathkeeper edge so
 * the dockerless e2e exercises the PRODUCTION token-validation path.
 *
 * Phase 4 makes the trips gateway a thin IdP consumer: it validates an RS256 JWT
 * minted by Oathkeeper against Oathkeeper's published JWKS. Ory is NOT run in the
 * dockerless suite (the full Kratos→Oathkeeper flow is config-only, like
 * `k8s/`/`istio/` and the compose `ory` profile). Instead, this helper reproduces
 * the part the Connectum side actually validates:
 *
 *  - {@link generateRsaTestKeypair} mints a throwaway RS256 keypair + the PUBLIC
 *    JWK (with a fixed `kid`) Oathkeeper would publish.
 *  - {@link startJwksServer} hosts that JWK over real HTTP at
 *    `/.well-known/jwks.json`, so `createJwtAuthInterceptor({ jwksUri })` takes
 *    its production `jose.createRemoteJWKSet` branch (NOT the `publicKey`
 *    shortcut — that would be a different code path, a fidelity gap).
 *  - {@link mintOathkeeperJwt} signs a JWT byte-shaped like the mutator's output
 *    (RS256, header `kid`, claims `sub`/`name`/`roles`/`iss`/`aud`/`exp`).
 *
 * The single load-bearing invariant: the minted JWT's header `kid` MUST equal the
 * published JWK `kid`, or `createRemoteJWKSet` fails key selection (the classic
 * JWKS error). Both default to {@link TEST_KID}.
 *
 * @module tests/helpers/jwks
 */

import { createServer, type Server as HttpServer } from "node:http";
import { type CryptoKey, exportJWK, generateKeyPair, type JWK, SignJWT } from "jose";

/** The `kid` shared by the published JWK and every minted token's header. */
export const TEST_KID = "test-key-1";

/** A generated RSA test keypair + the public JWK Oathkeeper would publish. */
export interface RsaTestKeypair {
    /** Private key used to SIGN tokens (simulating Oathkeeper's signing key). */
    readonly privateKey: CryptoKey;
    /** Public JWK served at the JWKS endpoint (carries `kid`/`alg`/`use`). */
    readonly publicJwk: JWK;
}

/** A running in-process JWKS server. */
export interface JwksServer {
    /** The `jwksUri` to pass to `buildServer({ jwksUri })`. */
    readonly url: string;
    /** Stop the server and drop any keep-alive sockets so the test process exits. */
    close(): Promise<void>;
}

/** Claims for {@link mintOathkeeperJwt} (mirrors the Oathkeeper `id_token` mutator). */
export interface MintOptions {
    /** Subject (`sub`) — the Kratos identity id in production. */
    readonly sub: string;
    /** Display name (`name`) — projected to a top-level claim by the mutator. */
    readonly name?: string;
    /** Roles (`roles`) — a JSON string array, the per-method authz input. */
    readonly roles?: readonly string[];
    /** Issuer (`iss`) — must equal the gateway's expected issuer (`JWT_ISSUER`). */
    readonly issuer: string;
    /** Audience (`aud`) — must equal the gateway's expected audience. */
    readonly audience: string;
    /** Lifetime; passed to `setExpirationTime`. Defaults to `"5m"`. */
    readonly ttl?: string | number;
    /** Header `kid`; defaults to {@link TEST_KID}. Override to test a `kid` mismatch. */
    readonly kid?: string;
}

/**
 * Generate a throwaway RS256 keypair and the public JWK to publish.
 *
 * The public key is exported to a JWK and tagged with `kid`/`alg`/`use` exactly
 * as a JWKS endpoint serves it. `extractable: true` keeps `exportJWK` reliable
 * across runtimes.
 */
export async function generateRsaTestKeypair(kid: string = TEST_KID): Promise<RsaTestKeypair> {
    const { privateKey, publicKey } = await generateKeyPair("RS256", { extractable: true });
    const publicJwk: JWK = { ...(await exportJWK(publicKey)), kid, alg: "RS256", use: "sig" };
    return { privateKey, publicJwk };
}

/**
 * Start an ephemeral `node:http` JWKS server on `127.0.0.1:0`.
 *
 * It replies `200 {"keys":[publicJwk]}` to `/.well-known/jwks.json` (404
 * otherwise). The returned `close()` calls `closeAllConnections()` so undici's
 * keep-alive socket (opened by `createRemoteJWKSet`) does not keep the test
 * process alive; the listener is also `unref()`-ed as a belt-and-braces measure.
 */
export async function startJwksServer(publicJwk: JWK): Promise<JwksServer> {
    const body = JSON.stringify({ keys: [publicJwk] });
    const server: HttpServer = createServer((req, res) => {
        if (req.url === "/.well-known/jwks.json") {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(body);
            return;
        }
        res.writeHead(404);
        res.end();
    });

    await new Promise<void>((resolve) => {
        server.listen(0, "127.0.0.1", () => resolve());
    });
    server.unref();

    const address = server.address();
    if (address === null || typeof address === "string") {
        throw new Error("JWKS server did not bind to a TCP port");
    }
    const url = `http://127.0.0.1:${address.port}/.well-known/jwks.json`;

    return {
        url,
        close() {
            return new Promise<void>((resolve, reject) => {
                server.closeAllConnections();
                server.close((err) => (err ? reject(err) : resolve()));
            });
        },
    };
}

/**
 * Mint an RS256 JWT byte-shaped like Oathkeeper's `id_token` mutator output.
 *
 * The header `kid` defaults to {@link TEST_KID} so it matches the published JWK;
 * `name`/`roles` are projected to top-level claims (what `claimsMapping` reads).
 */
export function mintOathkeeperJwt(privateKey: CryptoKey, options: MintOptions): Promise<string> {
    const payload: Record<string, unknown> = {};
    if (options.name !== undefined) payload.name = options.name;
    if (options.roles !== undefined) payload.roles = options.roles;

    return new SignJWT(payload)
        .setProtectedHeader({ alg: "RS256", kid: options.kid ?? TEST_KID })
        .setSubject(options.sub)
        .setIssuer(options.issuer)
        .setAudience(options.audience)
        .setIssuedAt()
        .setExpirationTime(options.ttl ?? "5m")
        .sign(privateKey);
}
