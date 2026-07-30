/**
 * Rotate the admin key.
 *
 *   npm run rotate-key
 *
 * Generates a fresh UUIDv4, writes its SHA-256 into `src/ui/adminKey.ts`, and
 * prints the key. Only the hash is ever committed, so the repository and the
 * shipped bundle contain no way to recover it.
 *
 * ## It is also written to `admin-key.local`
 *
 * It used to be printed once and stored nowhere, which sounds rigorous and is
 * actually just a way to lose it: the terminal scrolls, the key is gone, and the
 * only way back in is another rotation — which revokes every browser that was
 * working a minute ago. "Unrecoverable" is a property worth having against the
 * *repository*, not against the person who owns the dungeon.
 *
 * So it appends to `admin-key.local`, which `.gitignore` covers twice over and
 * `npm run admin-key` reads back. The file never leaves your machine; the threat
 * model this protects against is a public repo and public Actions logs, and a
 * local gitignored file is on the safe side of both.
 *
 * ## This runs locally, never in CI
 *
 * The repository is public, which makes Actions logs public. A key generated in
 * CI would be printed straight into a log anybody can read — strictly worse
 * than never rotating at all. The deploy workflow does not call this and must
 * not: rotate on your machine, keep the key, then push.
 */
import { randomUUID, createHash } from 'node:crypto';
import { appendFileSync, chmodSync, writeFileSync } from 'node:fs';

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

// Newest last, with a date, so the tail of the file is always the live key and
// the history above it explains any browser that suddenly stopped working.
const keyFile = new URL('../admin-key.local', import.meta.url);
appendFileSync(keyFile, `${new Date().toISOString()}  ${key}\n`);
try {
  chmodSync(keyFile, 0o600);
} catch {
  // Best effort — Windows and some mounts do not implement it, and a readable
  // file is still better than a lost key.
}

const line = '─'.repeat(58);
console.log(`\n${line}`);
console.log('  NEW ADMIN KEY');
console.log(line);
console.log(`\n  ?key=${key}\n`);
console.log(`${line}`);
console.log('  Saved to admin-key.local (gitignored). Read it back any time');
console.log('  with `npm run admin-key`. Commit src/ui/adminKey.ts — the');
console.log('  previous key dies the moment this deploys.');
console.log(`${line}\n`);
