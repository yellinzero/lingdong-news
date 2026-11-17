import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync, mkdirSync, writeFileSync, readFileSync, renameSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {documentationChange, onlyDocumentation} from './ci-changes.mjs';

test('README, guides and demo images use documentation checks', () => {
  assert.equal(onlyDocumentation(['README.md', 'README.en.md', 'docs/en/usage.md',
    'docs/assets/demo/cover.en.png', 'source-adapters/README.en.md']), true);
});

test('code, dependencies, release versions and CI changes retain complete checks', () => {
  for (const file of ['src/main.ts', 'src-tauri/src/lib.rs', 'pnpm-lock.yaml',
    'package.json', 'VERSION', '.github/workflows/desktop.yml', 'scripts/ci-changes.mjs',
    'source-adapters/packages/example/adapter.js']) {
    assert.equal(onlyDocumentation(['README.md', file]), false, file);
  }
  assert.equal(onlyDocumentation([]), false);
});

test('missing, new-branch and unavailable history retain complete checks', () => {
  const sha = 'a'.repeat(40);
  assert.equal(documentationChange(undefined, sha), false);
  assert.equal(documentationChange('0'.repeat(40), sha), false);
  assert.equal(documentationChange('HEAD~1', sha), false);
  assert.equal(documentationChange(sha, 'b'.repeat(40), tmpdir()), false);
});

test('git comparison handles unusual docs paths and runtime renames or deletions', t => {
  const dir = mkdtempSync(join(tmpdir(), 'lingdong-ci-'));
  t.after(() => rmSync(dir, {recursive: true, force: true}));
  const git = (...args) => execFileSync('git', args, {cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']}).trim();
  git('init'); git('config', 'user.name', 'CI fixture'); git('config', 'user.email', 'ci@example.invalid');
  mkdirSync(join(dir, 'src')); mkdirSync(join(dir, 'docs'));
  writeFileSync(join(dir, 'src/main.ts'), 'runtime');
  writeFileSync(join(dir, 'README.md'), 'readme');
  const commit = () => {git('add', '.'); git('commit', '-m', 'fixture'); return git('rev-parse', 'HEAD');};
  const base = commit();
  writeFileSync(join(dir, 'docs/中文 demo\nnotes.md'), 'documentation');
  const docs = commit();
  assert.equal(documentationChange(base, docs, dir), true);
  const output = join(dir, '.git/ci-output');
  execFileSync(process.execPath, [fileURLToPath(new URL('./ci-changes.mjs', import.meta.url))], {
    cwd: dir, stdio: 'pipe', env: {...process.env, GITHUB_EVENT_NAME: 'workflow_dispatch',
      CI_BASE_SHA: base, CI_HEAD_SHA: docs, GITHUB_OUTPUT: output},
  });
  assert.equal(readFileSync(output, 'utf8'), 'docs_only=false\n');
  renameSync(join(dir, 'src/main.ts'), join(dir, 'docs/main.ts'));
  const moved = commit();
  assert.equal(documentationChange(docs, moved, dir), false);
  assert.equal(documentationChange(moved, docs, dir), false);
  assert.equal(documentationChange(docs, docs, dir), false);
});
