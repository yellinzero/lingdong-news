import {execFileSync} from 'node:child_process';
import {appendFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

export function onlyDocumentation(paths) {
  return paths.length > 0 && paths.every(path =>
    /^README(?:\.[\w-]+)?\.md$/.test(path) ||
    path.startsWith('docs/') ||
    /^source-adapters\/README(?:\.[\w-]+)?\.md$/.test(path));
}

export function documentationChange(base, head, cwd = process.cwd()) {
  const sha = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
  if (!sha.test(base ?? '') || !sha.test(head ?? '') || /^0+$/.test(base)) return false;
  try {
    // Treat renames as deletion + addition so moving runtime files into docs is checked.
    const paths = execFileSync('git', ['diff', '--no-renames', '--name-only', '-z', base, head],
      {cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']}).split('\0').filter(Boolean);
    return onlyDocumentation(paths);
  } catch {
    // Unknown history must retain the complete checks.
    return false;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const docsOnly = process.env.GITHUB_EVENT_NAME !== 'workflow_dispatch' &&
    documentationChange(process.env.CI_BASE_SHA, process.env.CI_HEAD_SHA);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `docs_only=${docsOnly}\n`);
  console.log(docsOnly ? 'Documentation-only change: check links and versions.' :
    'Run complete checks and desktop builds.');
}
