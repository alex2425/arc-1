/**
 * Proves `.cfignore` cannot strip compiled output out of a direct `cf push`.
 *
 * `.cfignore` follows .gitignore matching: a pattern with no slash — or only a trailing one —
 * matches a NAME at ANY depth, not just at the project root. `dist/` mirrors `src/`, so a
 * root-intent entry like `public/` silently removes `dist/public/` from the upload. The app
 * then starts and dies on the first value import of that subtree
 * (`server/safe-http-client.js` → `public/read-only-client.js`, ERR_MODULE_NOT_FOUND) — a
 * failure the local build, the test suite and `cf push` itself all report as healthy.
 *
 * Root-only entries must therefore be anchored (`/public/`). The MTA path filters through
 * `mta.yaml`'s own `ignore:` list and is covered by mta-descriptor.test.ts instead.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '../../..');

/** Names .gitignore semantics would match at any depth — i.e. inside `dist/` too. */
function unanchoredNames(): string[] {
  return readFileSync(join(ROOT, '.cfignore'), 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#') && !line.startsWith('!'))
    .filter((line) => !line.startsWith('/'))
    .map((line) => line.replace(/\/$/, ''))
    .filter((line) => !line.includes('/') && !line.includes('*'));
}

/** Every path segment the compiler reproduces under `dist/`, plus the copied asset names. */
function compiledNames(): Set<string> {
  const names = new Set<string>();
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      names.add(entry.name);
      if (entry.isDirectory()) walk(join(dir, entry.name));
    }
  };
  walk(join(ROOT, 'src'));
  return names;
}

describe('.cfignore', () => {
  it('does not exclude any name the build reproduces under dist/', () => {
    const compiled = compiledNames();
    expect(unanchoredNames().filter((name) => compiled.has(name))).toEqual([]);
  });

  it('still anchors the source tree so dist/ stays the only shipped code', () => {
    const anchored = readFileSync(join(ROOT, '.cfignore'), 'utf8');
    for (const dir of ['/src/', '/tests/', '/public/', '/docs/', '/scripts/']) {
      expect(anchored).toContain(dir);
    }
  });
});
