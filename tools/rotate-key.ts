/**
 * Rotate the admin key.
 *
 *   npm run rotate-key
 *
 * Generates a fresh UUIDv4, writes its SHA-256 into `src/ui/adminKey.ts`, and
 * prints the key **once**. Only the hash is ever committed, so the repository
 * and the shipped bundle contain no way to recover it.
 *
 * ## This runs locally, never in CI
 *
 * The repository is public, which makes Actions logs public. A key generated in
 * CI would be printed straight into a log anybody can read — strictly worse
 * than never rotating at all. The deploy workflow does not call this and must
 * not: rotate on your machine, keep the key, then push.
 */
import { randomUUID, createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';

const key = randomUUID();
const hash = createHash('sha256').update(key).digest('hex');

const file = `/**
 * SHA-256 of the current admin key. Generated — do not edit by hand.
 *
 * Rotate with \`npm run rotate-key\`, which prints the new key once and writes
 * only this hash. The key itself is never committed and never reaches the
 * bundle, so reading either tells you a key exists and nothing more.
 *
 * Rotated: ${new Date().toISOString().slice(0, 10)}
 */
export const ADMIN_HASH = '${hash}';
`;

writeFileSync(new URL('../src/ui/adminKey.ts', import.meta.url), file);

const line = '─'.repeat(58);
console.log(`\n${line}`);
console.log('  NEW ADMIN KEY — shown once, not stored anywhere');
console.log(line);
console.log(`\n  ?key=${key}\n`);
console.log(`${line}`);
console.log('  Wrote the hash to src/ui/adminKey.ts. Commit that; keep the');
console.log('  key. The previous key stops working the moment this deploys.');
console.log(`${line}\n`);
