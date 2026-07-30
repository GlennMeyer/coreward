/**
 * Print the current admin key.
 *
 *   npm run admin-key
 *
 * Reads the last line of `admin-key.local`, which `rotate-key` appends to. This
 * exists because the key used to be printed once and stored nowhere, so the only
 * way to recover it after the terminal scrolled was another rotation — which
 * revokes every browser that was working. The file is gitignored and local; the
 * secrecy that matters is from the public repo and its public Actions logs.
 */
import { readFileSync } from 'node:fs';

const path = new URL('../admin-key.local', import.meta.url);
let lines: string[];
try {
  lines = readFileSync(path, 'utf8').trim().split('\n').filter(Boolean);
} catch {
  console.error(
    '\n  No admin-key.local yet — it is written by `npm run rotate-key`.\n'
    + '  If a key is already deployed, it cannot be recovered from the repo\n'
    + '  (only its hash is committed). Rotate to get a fresh one.\n',
  );
  process.exit(1);
}

const last = lines[lines.length - 1]!;
const [when, key] = last.split(/\s+/);
const line = '─'.repeat(58);
console.log(`\n${line}`);
console.log(`  CURRENT ADMIN KEY   (rotated ${when?.slice(0, 10)})`);
console.log(line);
console.log(`\n  ?key=${key}\n`);
if (lines.length > 1) console.log(`  ${lines.length - 1} older key(s) above it in admin-key.local — all revoked.`);
console.log(`${line}\n`);
