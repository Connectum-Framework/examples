/**
 * Signing-key loading and the keygen CLI.
 *
 * The service-token design rests on one property: an identity signs with the
 * SAME key, under the SAME `kid`, in every replica and after every restart —
 * otherwise a verifier's cached keyset rejects the identity's tokens. These
 * tests pin that property at the source: a key file always yields the same
 * thumbprint `kid`, the keygen never replaces an existing key, and a
 * configured-but-unusable key file stops start-up instead of falling back to
 * an ephemeral key.
 *
 * Scratch files live under `node_modules/.cache` (ignored by git) and are
 * removed afterwards.
 *
 * @module tests/unit/internalAuth
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { after, before, describe, it } from "node:test";
import { calculateJwkThumbprint, createLocalJWKSet, jwtVerify } from "jose";
import { createInternalSigner, INTERNAL_AUDIENCE, InternalIdentity, signingKeyFileFromEnv, startJwksServer } from "#internalAuth.ts";

const PACKAGE_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const KEYGEN = join(PACKAGE_ROOT, "src", "internalKeygen.ts");

/** Write a PKCS#8 PEM of a fresh key of the given kind and return its path. */
async function writeKey(dir: string, name: string, kind: "rsa" | "ec"): Promise<string> {
    const { privateKey } = kind === "rsa" ? generateKeyPairSync("rsa", { modulusLength: 2048 }) : generateKeyPairSync("ec", { namedCurve: "P-256" });
    const file = join(dir, name);
    await writeFile(file, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o400 });
    return file;
}

describe("Internal signing key: file-backed identity", () => {
    let scratch: string;

    before(async () => {
        const cache = join(PACKAGE_ROOT, "node_modules", ".cache");
        await mkdir(cache, { recursive: true });
        scratch = await mkdtemp(join(cache, "internal-auth-test-"));
    });

    after(async () => {
        await rm(scratch, { recursive: true, force: true });
    });

    it("a PKCS#8 RSA file yields the same thumbprint kid on every load, and its tokens verify against the published JWKS", async () => {
        const file = await writeKey(scratch, "trips.pem", "rsa");
        const first = await createInternalSigner(InternalIdentity.trips, { keyFile: file });
        const second = await createInternalSigner(InternalIdentity.trips, { keyFile: file });

        assert.equal(first.kid, second.kid);
        assert.equal(first.kid, await calculateJwkThumbprint({ kty: "RSA", n: first.publicJwk.n, e: first.publicJwk.e }));
        // The published JWK is public-only.
        assert.equal("d" in first.publicJwk, false);

        // A token signed by one load verifies against the JWKS served by the
        // other — what a verifier sees when a replica restarts or another one
        // answers the JWKS fetch.
        const jwks = await startJwksServer({ signer: second, port: 0, host: "127.0.0.1" });
        try {
            const served = (await (await fetch(jwks.url)).json()) as { keys: Array<{ kid?: string }> };
            assert.deepEqual(
                served.keys.map((k) => k.kid),
                [first.kid],
            );
            const { payload, protectedHeader } = await jwtVerify(await first.sign(), createLocalJWKSet({ keys: [second.publicJwk] }), {
                issuer: InternalIdentity.trips,
                audience: INTERNAL_AUDIENCE,
                algorithms: ["RS256"],
            });
            assert.equal(protectedHeader.kid, first.kid);
            assert.equal(payload.sub, InternalIdentity.trips);
            // No roles claim: the receiver derives the role from the verified
            // issuer, so the token must not carry one that could be trusted.
            assert.equal(payload.roles, undefined);
        } finally {
            await jwks.close();
        }
    });

    it("without a key file each signer gets a fresh ephemeral key (different kid)", async () => {
        const a = await createInternalSigner(InternalIdentity.worker);
        const b = await createInternalSigner(InternalIdentity.worker);
        assert.notEqual(a.kid, b.kid);
    });

    it("a missing key file stops start-up with an error naming the file", async () => {
        const missing = join(scratch, "absent.pem");
        await assert.rejects(createInternalSigner(InternalIdentity.trips, { keyFile: missing }), (err: unknown) => err instanceof Error && err.message.includes("cannot read") && err.message.includes(missing));
    });

    it("a file that is not a PKCS#8 PEM stops start-up", async () => {
        const garbage = join(scratch, "garbage.pem");
        await writeFile(garbage, "this is not a key\n");
        await assert.rejects(createInternalSigner(InternalIdentity.trips, { keyFile: garbage }), /not an unencrypted PKCS#8 PEM private key/);

        const corrupt = join(scratch, "corrupt.pem");
        await writeFile(corrupt, "-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n");
        await assert.rejects(createInternalSigner(InternalIdentity.trips, { keyFile: corrupt }), /does not parse as a private key/);
    });

    it("a non-RSA key stops start-up", async () => {
        const ec = await writeKey(scratch, "ec.pem", "ec");
        await assert.rejects(createInternalSigner(InternalIdentity.trips, { keyFile: ec }), /need an RSA key/);
    });

    it("INTERNAL_SIGNING_KEY_FILE: unset means ephemeral, set-but-empty is an error, a path is trimmed", () => {
        assert.equal(signingKeyFileFromEnv({}), undefined);
        assert.throws(() => signingKeyFileFromEnv({ INTERNAL_SIGNING_KEY_FILE: "  " }), /set but empty/);
        assert.equal(signingKeyFileFromEnv({ INTERNAL_SIGNING_KEY_FILE: " /keys/trips.pem " }), "/keys/trips.pem");
    });

    it("the keygen writes owner-read-only keys and never replaces an existing one", async () => {
        const run = promisify(execFile);
        const dir = join(scratch, "keygen");
        await run(process.execPath, [KEYGEN, dir, "trips", "worker"], { cwd: PACKAGE_ROOT });
        const tripsPem = await readFile(join(dir, "trips.pem"), "utf8");
        assert.equal((await stat(join(dir, "trips.pem"))).mode & 0o777, 0o400);
        assert.equal((await stat(dir)).mode & 0o777, 0o700);

        // Second run: same file contents, so the kid (and every verifier's
        // cache) survives a re-run on restart.
        const { stdout } = await run(process.execPath, [KEYGEN, dir, "trips", "worker"], { cwd: PACKAGE_ROOT });
        assert.match(stdout, /kept existing .*trips\.pem/);
        assert.equal(await readFile(join(dir, "trips.pem"), "utf8"), tripsPem);

        const signer = await createInternalSigner(InternalIdentity.trips, { keyFile: join(dir, "trips.pem") });
        assert.equal(signer.identity, InternalIdentity.trips);
    });

    it("the keygen rejects an unknown identity", async () => {
        const run = promisify(execFile);
        await assert.rejects(run(process.execPath, [KEYGEN, join(scratch, "bad"), "billing"], { cwd: PACKAGE_ROOT }), /unknown identity: billing/);
    });
});
