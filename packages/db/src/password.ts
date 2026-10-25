import { hash, verify, type Algorithm } from '@node-rs/argon2';

/**
 * argon2id for passwords and PINs (AGENTS.md §2). Parameters follow the OWASP minimum
 * (19 MiB, 2 passes, 1 lane): ~30 ms on the reference server, cheap enough for 150 OPD/day
 * logins and unlocks, expensive enough for offline guessing. The PHC string records the
 * parameters, so raising them later keeps old hashes verifiable.
 */
const ARGON2ID = 2 as Algorithm;
const OPTIONS = { algorithm: ARGON2ID, memoryCost: 19_456, timeCost: 2, parallelism: 1 };

export function hashSecret(secret: string): Promise<string> {
  return hash(secret, OPTIONS);
}

/** False for a wrong secret and for a malformed/missing hash (never throws). */
export async function verifySecret(storedHash: string | null, secret: string): Promise<boolean> {
  if (!storedHash) {
    await burnHash(secret);
    return false;
  }
  try {
    return await verify(storedHash, secret);
  } catch {
    return false;
  }
}

let dummy: Promise<string> | undefined;

/**
 * Same work as a real verification, so "no such user" and "no password set" take as long as a
 * wrong password and do not reveal which usernames exist.
 */
export async function burnHash(secret: string): Promise<void> {
  dummy ??= hash('hmis-timing-equaliser', OPTIONS);
  try {
    await verify(await dummy, secret);
  } catch {
    // ignore
  }
}
