import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

const webDir = resolve(import.meta.dirname, '..', 'web');

function javascriptFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return javascriptFiles(path);
    return entry.isFile() && entry.name.endsWith('.js') ? [path] : [];
  });
}

test('tous les modules JavaScript du site ont une syntaxe valide', () => {
  const files = javascriptFiles(webDir);
  assert.ok(files.length > 0, 'aucun fichier JavaScript trouvé');
  for (const file of files) {
    const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    assert.equal(result.status, 0, `${file}\n${result.stderr || result.error?.message || ''}`);
  }
});
