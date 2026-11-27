// v0.37.3: ogni modulo che usa `ledger`/`STATE` deve importarli (regressione: ReferenceError in opfs.js v0.37.1–0.37.2).
import { readFileSync, readdirSync } from 'node:fs';
import assert from 'node:assert/strict';
const dir = new URL('./', import.meta.url);
for (const f of readdirSync(dir).filter((n) => n.endsWith('.js') && n !== 'storage.js')) {
  const src = readFileSync(new URL(f, dir), 'utf8');
  for (const id of ['ledger', 'STATE']) {
    if (new RegExp(`\\b${id}\\.`).test(src)) assert.ok(new RegExp(`import\\s*\\{[^}]*\\b${id}\\b[^}]*\\}\\s*from\\s*'\\./storage\\.js`).test(src), `${f}: usa ${id} senza importarlo`);
  }
}
console.log('imports ok');
