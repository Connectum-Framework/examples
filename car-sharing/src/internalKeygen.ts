/**
 * Service-token key generator — one RS256 private key per identity.
 *
 *   node src/internalKeygen.ts <dir> <identity>...
 *   node src/internalKeygen.ts ./keys trips worker
 *
 * Writes `<dir>/<identity>.pem` (PKCS#8, 2048-bit RSA, file mode 0400, directory
 * mode 0700) for every listed identity that does not have a key yet, and leaves
 * an existing key untouched. That makes it safe to run on every start-up: the
 * compose `internal-keygen` service runs it before the signers start, and a
 * key, once written, survives restarts — which is the point, because a
 * changed key would invalidate every verifier's cached keyset. The same
 * command produces the file a Kubernetes Secret is created from (see README).
 *
 * The file is created with an exclusive flag, so two concurrent runs cannot
 * both write the same key: the loser fails instead of overwriting.
 *
 * @module internalKeygen
 */

import { generateKeyPairSync } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { InternalIdentity } from "#internalAuth.ts";

/** RSA modulus for new keys — RS256's minimum, as the verifier expects. */
const MODULUS_BITS = 2048;

const [dir, ...identities] = process.argv.slice(2);
const known: readonly string[] = Object.values(InternalIdentity);

if (dir === undefined || identities.length === 0) {
    console.error(`usage: node src/internalKeygen.ts <dir> <identity>...   (identities: ${known.join(", ")})`);
    process.exit(2);
}
const unknown = identities.filter((id) => !known.includes(id));
if (unknown.length > 0) {
    console.error(`unknown identity: ${unknown.join(", ")} (expected one of: ${known.join(", ")})`);
    process.exit(2);
}

await mkdir(dir, { recursive: true, mode: 0o700 });
for (const identity of identities) {
    const file = join(dir, `${identity}.pem`);
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: MODULUS_BITS });
    const pem = privateKey.export({ type: "pkcs8", format: "pem" });
    try {
        await writeFile(file, pem, { flag: "wx", mode: 0o400 });
        console.log(`internal-keygen: wrote ${file}`);
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
        console.log(`internal-keygen: kept existing ${file}`);
    }
}
