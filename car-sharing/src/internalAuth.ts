/**
 * Service-to-service identity — per-service signed tokens.
 *
 * fleet, billing and the trips RPCs RecordTrip/EndTrip are `internal` in proto:
 * they accept no end-user JWT, only a SERVICE token in `x-internal-token`. Each
 * calling service proves who it is with its OWN key pair:
 *
 *  - the caller signs a short-lived RS256 JWT per call (`iss` = its identity,
 *    `aud` = {@link INTERNAL_AUDIENCE}, 60 s expiry)
 *    and attaches it with a client interceptor;
 *  - the caller publishes the matching PUBLIC key as a JWKS document over a tiny
 *    HTTP endpoint ({@link startJwksServer});
 *  - every receiving role verifies the token with `signedTokenTrust`, which
 *    picks the keyset by the token's claimed `iss` and pins verification to that
 *    issuer. A key leaked from one service therefore forges only that service,
 *    never another one — unlike a shared secret.
 *
 * Who signs: only processes that CALL internal methods. The trips role signs
 * its StartTrip pre-check (`ctx.call` to FleetService/GetVehicle, in-process in
 * the monolith and over gRPC when split); the Temporal worker signs every
 * activity call. fleet and billing call nobody, so they hold no key and run no
 * JWKS endpoint — they only verify.
 *
 * Keys: ONE key pair per identity, read from a PKCS#8 PEM file named by
 * `INTERNAL_SIGNING_KEY_FILE` — a Kubernetes Secret, or the compose keygen
 * volume — so every replica of an identity and every restart sign with the
 * same key, and the `kid` (the key's JWK thumbprint) never changes under a
 * verifier's cached keyset. Without the variable (tests, a local single
 * process) an ephemeral key pair is generated instead; that is only safe when
 * the identity runs as one process whose verifiers restart with it. In
 * production key issuance, rotation and JWKS publication belong to the
 * platform (SPIRE, the IdP, or the mesh); the verifying side —
 * `signedTokenTrust` with per-issuer JWKS URLs — stays the same.
 *
 * Configuration (env):
 *  - `INTERNAL_SIGNING_KEY_FILE` — this identity's private key file. Set but
 *    unreadable, empty, or not an RSA key → the process refuses to start.
 *  - `INTERNAL_JWKS_PORT` — port a signing process serves its JWKS on.
 *    Defaults per identity ({@link DEFAULT_JWKS_PORT}) so a monolith and a
 *    worker on one host do not collide.
 *  - `INTERNAL_ISSUER_TRIPS_JWKS` / `INTERNAL_ISSUER_WORKER_JWKS` — the JWKS URL
 *    a verifying role trusts for each issuer. Unset → that identity's default
 *    localhost endpoint; set to an empty string → that issuer is not trusted at
 *    all (for deployments where it does not exist).
 *
 * @module internalAuth
 */

import type { KeyObject } from "node:crypto";
import { createPrivateKey, createPublicKey } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Server as HttpServer } from "node:http";
import { createServer as createHttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { Interceptor, Transport } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import type { InternalTrustSource, SignedTokenTrustOptions } from "@connectum/auth";
import { signedTokenTrust } from "@connectum/auth";
import type { JWK } from "jose";
import { calculateJwkThumbprint, exportJWK, generateKeyPair, SignJWT } from "jose";

/** Audience every internal service token is minted for and verified against. */
export const INTERNAL_AUDIENCE = "car-sharing-internal";

/** Request header carrying the service token (`signedTokenTrust`'s default). */
export const INTERNAL_TOKEN_HEADER = "x-internal-token";

/** Path the JWKS document is served on (the conventional well-known location). */
export const JWKS_PATH = "/.well-known/jwks.json";

/** Signature algorithm of every service token; verification accepts only this one. */
const SIGNING_ALG = "RS256";

/**
 * Token lifetime in seconds. Short on purpose: a token copied from a request is
 * useless a minute later, and a fresh one is signed for every call anyway.
 */
const TOKEN_TTL_SECONDS = 60;

/** The service identities that sign internal calls. */
export const InternalIdentity = {
    trips: "trips",
    worker: "worker",
} as const;

export type InternalIdentity = (typeof InternalIdentity)[keyof typeof InternalIdentity];

/**
 * Default JWKS port per identity. Distinct so that `pnpm start` (monolith,
 * signs as trips) and `pnpm worker` can run side by side on one machine with no
 * env at all.
 */
export const DEFAULT_JWKS_PORT: Readonly<Record<InternalIdentity, number>> = {
    [InternalIdentity.trips]: 9101,
    [InternalIdentity.worker]: 9102,
};

/** Env var holding the trusted JWKS URL of each issuer. */
const ISSUER_JWKS_ENV: Readonly<Record<InternalIdentity, string>> = {
    [InternalIdentity.trips]: "INTERNAL_ISSUER_TRIPS_JWKS",
    [InternalIdentity.worker]: "INTERNAL_ISSUER_WORKER_JWKS",
};

/** Issuer map accepted by `signedTokenTrust`, keyed by the `iss` value. */
export type InternalIssuers = SignedTokenTrustOptions["issuers"];

/** One service's signing identity: its key pair and the means to use it. */
export interface InternalSigner {
    /** The identity this process signs as — the token's `iss`, `sub` and only role. */
    readonly identity: InternalIdentity;
    /** Key id placed in every token header and on the published JWK. */
    readonly kid: string;
    /** The public key as a JWK (with `kid`, `alg`, `use`), as the JWKS endpoint serves it. */
    readonly publicJwk: JWK;
    /** Mint a fresh service token. */
    sign(): Promise<string>;
    /** Client interceptor that attaches a fresh token to every outgoing request. */
    readonly interceptor: Interceptor;
}

/** Options for {@link createInternalSigner}. */
export interface InternalSignerOptions {
    /**
     * PEM file holding this identity's RS256 private key (PKCS#8). When given,
     * every process of the identity — all replicas, and the same process after
     * a restart — signs with the same key, so verifiers never meet an unknown
     * key. When absent, a fresh in-memory key pair is generated (tests and
     * local single-process runs). See {@link signingKeyFileFromEnv}.
     */
    readonly keyFile?: string | undefined;
}

/** Smallest RSA modulus accepted; jose refuses to sign RS256 with less. */
const MIN_RSA_MODULUS_BITS = 2048;

/** PEM label of an unencrypted PKCS#8 private key. */
const PKCS8_PEM_HEADER = "-----BEGIN PRIVATE KEY-----";

/**
 * Load an RS256 private key from a PKCS#8 PEM file.
 *
 * Every failure is an Error naming the file and the reason, raised at start-up:
 * a configured key that cannot be used must stop the process, because quietly
 * signing with some other key would make every verifier reject its calls.
 *
 * @param keyFile - Path to the PEM file.
 */
async function loadSigningKey(keyFile: string): Promise<KeyObject> {
    let pem: string;
    try {
        pem = await readFile(keyFile, "utf8");
    } catch (err) {
        throw new Error(`INTERNAL_SIGNING_KEY_FILE: cannot read "${keyFile}": ${(err as Error).message}`, { cause: err });
    }
    if (!pem.includes(PKCS8_PEM_HEADER)) {
        throw new Error(`INTERNAL_SIGNING_KEY_FILE: "${keyFile}" is not an unencrypted PKCS#8 PEM private key (expected a "${PKCS8_PEM_HEADER}" block).`);
    }
    let key: KeyObject;
    try {
        key = createPrivateKey({ key: pem, format: "pem" });
    } catch (err) {
        throw new Error(`INTERNAL_SIGNING_KEY_FILE: "${keyFile}" does not parse as a private key: ${(err as Error).message}`, { cause: err });
    }
    if (key.asymmetricKeyType !== "rsa") {
        throw new Error(`INTERNAL_SIGNING_KEY_FILE: "${keyFile}" holds a ${key.asymmetricKeyType ?? "unknown"} key; service tokens are RS256 and need an RSA key.`);
    }
    const bits = key.asymmetricKeyDetails?.modulusLength ?? 0;
    if (bits < MIN_RSA_MODULUS_BITS) {
        throw new Error(`INTERNAL_SIGNING_KEY_FILE: "${keyFile}" is a ${bits}-bit RSA key; RS256 needs at least ${MIN_RSA_MODULUS_BITS} bits.`);
    }
    return key;
}

/**
 * The signing-key file this process is configured with:
 * `INTERNAL_SIGNING_KEY_FILE`, or `undefined` when the variable is not set
 * (an ephemeral key is then generated).
 *
 * @param env - Environment to read (defaults to `process.env`).
 * @throws When the variable is set but empty — an operator who set it meant a
 *   file, and falling back to an ephemeral key would hide the mistake.
 */
export function signingKeyFileFromEnv(env: NodeJS.ProcessEnv = process.env): string | undefined {
    const raw = env.INTERNAL_SIGNING_KEY_FILE;
    if (raw === undefined) return undefined;
    const path = raw.trim();
    if (path === "") {
        throw new Error("INTERNAL_SIGNING_KEY_FILE is set but empty — point it at the identity's PKCS#8 key file, or unset it to use an ephemeral key.");
    }
    return path;
}

/**
 * Create this process's signing identity.
 *
 * With `keyFile`, the key comes from that file (see {@link InternalSignerOptions});
 * otherwise a fresh RS256 key pair is generated, its private half
 * non-extractable. Either way the published `kid` is the RFC 7638 JWK
 * thumbprint of the public key, so the same key always has the same `kid` and
 * a verifier's cached keyset stays valid across restarts and replicas.
 *
 * @param identity - The service identity to sign as.
 * @param options - {@link InternalSignerOptions}.
 */
export async function createInternalSigner(identity: InternalIdentity, options: InternalSignerOptions = {}): Promise<InternalSigner> {
    let privateKey: CryptoKey | KeyObject;
    let publicBase: JWK;
    if (options.keyFile !== undefined) {
        const key = await loadSigningKey(options.keyFile);
        privateKey = key;
        publicBase = createPublicKey(key).export({ format: "jwk" }) as JWK;
    } else {
        const pair = await generateKeyPair(SIGNING_ALG);
        privateKey = pair.privateKey;
        publicBase = await exportJWK(pair.publicKey);
    }
    // Only the public members feed the thumbprint and the published JWK.
    const kid = await calculateJwkThumbprint({ kty: publicBase.kty, n: publicBase.n, e: publicBase.e });
    const publicJwk: JWK = { kty: publicBase.kty, n: publicBase.n, e: publicBase.e, kid, alg: SIGNING_ALG, use: "sig" };

    // No `roles` claim: the receiver derives the caller's role from the verified
    // issuer, so a token can never claim more than its signing key proves.
    const sign = (): Promise<string> =>
        new SignJWT({})
            .setProtectedHeader({ alg: SIGNING_ALG, kid, typ: "JWT" })
            .setIssuer(identity)
            .setSubject(identity)
            .setAudience(INTERNAL_AUDIENCE)
            .setIssuedAt()
            .setExpirationTime(`${TOKEN_TTL_SECONDS}s`)
            .sign(privateKey);

    // `set`, not `append`: whatever token a caller may already have put on the
    // request, the one that goes out is this process's own.
    const interceptor: Interceptor = (next) => async (req) => {
        req.header.set(INTERNAL_TOKEN_HEADER, await sign());
        return next(req);
    };

    return { identity, kid, publicJwk, sign, interceptor };
}

/**
 * A gRPC transport whose every request carries the signer's service token.
 *
 * The single place a signed network transport is built, shared by the trips
 * role's remote resolver and the worker's catalog client, so the two cannot
 * drift apart.
 *
 * @param baseUrl - Peer base URL (`http://host:port`).
 * @param signer - Identity to sign as.
 */
export function createSignedTransport(baseUrl: string, signer: InternalSigner): Transport {
    return createGrpcTransport({ baseUrl, interceptors: [signer.interceptor] });
}

/** A running JWKS endpoint. */
export interface JwksServer {
    /** The JWKS URL a verifier on the same host can use. */
    readonly url: string;
    /** The bound port (useful when started on port 0). */
    readonly port: number;
    /** Stop serving and drop open keep-alive connections. */
    close(): Promise<void>;
}

/** Options for {@link startJwksServer}. */
export interface StartJwksServerOptions {
    /** The signer whose public key is published. */
    readonly signer: InternalSigner;
    /** Port to listen on (0 = any free port). */
    readonly port: number;
    /**
     * Interface to bind. Defaults to `0.0.0.0`, because in compose and
     * Kubernetes the verifiers fetch the keys from OTHER containers.
     */
    readonly host?: string;
}

/**
 * Serve the signer's public key as a JWKS document on `GET` {@link JWKS_PATH}.
 *
 * Only the public half is ever written to the response. Everything else is 404
 * (or 405 for another method on the JWKS path), so the endpoint exposes nothing
 * besides the key set.
 *
 * @param options - {@link StartJwksServerOptions}.
 */
export async function startJwksServer(options: StartJwksServerOptions): Promise<JwksServer> {
    const host = options.host ?? "0.0.0.0";
    const body = JSON.stringify({ keys: [options.signer.publicJwk] });

    const server: HttpServer = createHttpServer((req, res) => {
        const path = (req.url ?? "").split("?")[0];
        if (path !== JWKS_PATH) {
            res.writeHead(404).end();
            return;
        }
        if (req.method !== "GET" && req.method !== "HEAD") {
            res.writeHead(405, { allow: "GET, HEAD" }).end();
            return;
        }
        res.writeHead(200, { "content-type": "application/json" }).end(req.method === "HEAD" ? undefined : body);
    });

    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(options.port, host, () => {
            server.off("error", reject);
            resolve();
        });
    });

    const { port } = server.address() as AddressInfo;
    const urlHost = host === "0.0.0.0" ? "localhost" : host;

    return {
        url: `http://${urlHost}:${port}${JWKS_PATH}`,
        port,
        close: () =>
            new Promise<void>((resolve, reject) => {
                // A verifier keeps its JWKS connection alive; without dropping
                // it, close() would wait for that idle socket to time out.
                server.closeAllConnections();
                server.close((err) => (err ? reject(err) : resolve()));
            }),
    };
}

/**
 * The port this process serves its JWKS on: `INTERNAL_JWKS_PORT`, else the
 * identity's default.
 *
 * @param identity - The identity this process signs as.
 * @param env - Environment to read (defaults to `process.env`).
 */
export function internalJwksPort(identity: InternalIdentity, env: NodeJS.ProcessEnv = process.env): number {
    const raw = env.INTERNAL_JWKS_PORT?.trim();
    if (raw === undefined || raw === "") return DEFAULT_JWKS_PORT[identity];
    const port = Number(raw);
    if (!Number.isInteger(port) || port < 0 || port > 65_535) {
        throw new Error(`INTERNAL_JWKS_PORT must be a TCP port number, got "${raw}".`);
    }
    return port;
}

/**
 * Verification settings for one trusted issuer: its JWKS URL, this app's
 * internal audience and RS256 only. No claims are mapped to roles — see
 * {@link issuerBoundTrust}.
 *
 * @param jwksUri - The issuer's JWKS URL (its own keys only).
 */
export function internalIssuer(jwksUri: string): InternalIssuers[string] {
    return {
        jwksUri,
        audience: INTERNAL_AUDIENCE,
        algorithms: [SIGNING_ALG],
    };
}

/**
 * The trust source for internal methods: `signedTokenTrust`, with the caller's
 * role taken from the VERIFIED issuer instead of from any claim in the token.
 *
 * `signedTokenTrust` checks the signature against the claimed issuer's own
 * keyset and pins `iss` to that issuer, but it would copy a `roles` claim
 * verbatim. If roles came from the token, the holder of the `trips` key could
 * sign `roles: ["worker"]` and call worker-only methods — the very forgery that
 * one key per service is meant to rule out. The verified `iss` is the identity
 * the key proves, so it becomes the only role.
 *
 * @param issuers - Trusted issuers, keyed by identity (see {@link internalIssuersFromEnv}).
 */
export function issuerBoundTrust(issuers: InternalIssuers): InternalTrustSource {
    const verify = signedTokenTrust({ issuers, header: INTERNAL_TOKEN_HEADER });
    return async (req) => {
        const context = await verify(req);
        if (context === null) return null;
        const issuer = context.claims.iss;
        if (typeof issuer !== "string") return null;
        return { ...context, subject: issuer, roles: [issuer] };
    };
}

/**
 * The issuers a verifying role trusts, read from env.
 *
 * For each identity: `INTERNAL_ISSUER_<ID>_JWKS` unset → its default localhost
 * JWKS URL (a local run needs no env); set to an empty string → that issuer is
 * not trusted at all; otherwise the given URL.
 *
 * @param env - Environment to read (defaults to `process.env`).
 * @throws When every issuer is disabled — a role that trusts no caller would
 *   reject every internal call, which is a configuration mistake worth failing
 *   on at start-up rather than at the first request.
 */
export function internalIssuersFromEnv(env: NodeJS.ProcessEnv = process.env): InternalIssuers {
    const issuers: Record<string, InternalIssuers[string]> = {};
    for (const identity of Object.values(InternalIdentity)) {
        const raw = env[ISSUER_JWKS_ENV[identity]];
        if (raw === undefined) {
            issuers[identity] = internalIssuer(`http://localhost:${DEFAULT_JWKS_PORT[identity]}${JWKS_PATH}`);
        } else if (raw.trim() !== "") {
            issuers[identity] = internalIssuer(raw.trim());
        }
    }
    if (Object.keys(issuers).length === 0) {
        throw new Error(
            `No internal token issuer is trusted: ${Object.values(ISSUER_JWKS_ENV).join(" and ")} are all empty. Leave one unset or point it at a JWKS URL.`,
        );
    }
    return issuers;
}
