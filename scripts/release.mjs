#!/usr/bin/env node
// One-command release: `npm run release -- [patch|minor|major|<x.y.z>] [--dry-run]`.
// Gates on a clean, up-to-date main and the full test suite, then bumps, publishes to npm,
// pushes the tag and creates the GitHub release. --dry-run runs every gate and
// `npm publish --dry-run`, and changes nothing.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const bump = args.find((a) => !a.startsWith('--')) ?? 'patch';
if (!/^(patch|minor|major|\d+\.\d+\.\d+(-[\w.]+)?)$/.test(bump)) fail(`unknown bump "${bump}" (patch | minor | major | x.y.z)`);

function fail(msg) {
  console.error(`\nrelease: ${msg}`);
  process.exit(1);
}
function out(cmd, ...a) {
  return execFileSync(cmd, a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
function step(title, cmd, ...a) {
  console.log(`\n▸ ${title}`);
  try {
    execFileSync(cmd, a, { stdio: 'inherit' });
  } catch {
    fail(`${title} failed`);
  }
}

const branch = out('git', 'rev-parse', '--abbrev-ref', 'HEAD');
if (branch !== 'main') fail(`on "${branch}", releases go from main`);
if (out('git', 'status', '--porcelain')) fail('the working tree is not clean');
step('fetch origin', 'git', 'fetch', '--quiet', 'origin', 'main');
if (out('git', 'rev-parse', 'HEAD') !== out('git', 'rev-parse', 'origin/main')) fail('main differs from origin/main — pull or push first');
try {
  console.log(`\n▸ npm user: ${out('npm', 'whoami')}`);
} catch {
  fail('not logged in to npm — run `npm login` once');
}
try {
  out('gh', 'auth', 'status');
} catch {
  fail('gh is not logged in — run `gh auth login` once');
}

step('typecheck', 'npm', 'run', '--silent', 'typecheck');
step('tests: build + unit + browser + e2e', 'npm', 'run', '--silent', 'test:all');

if (dryRun) {
  step('npm publish --dry-run', 'npm', 'publish', '--dry-run', '--access', 'public');
  console.log('\nrelease: dry run passed — nothing was changed.');
  process.exit(0);
}

step(`version ${bump}`, 'npm', 'version', bump, '-m', 'Release %s');
const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
step('npm publish', 'npm', 'publish', '--access', 'public');
step('push commit + tag', 'git', 'push', '--follow-tags', 'origin', 'main');
step('GitHub release', 'gh', 'release', 'create', `v${version}`, '--title', `v${version}`, '--generate-notes', '--verify-tag');
console.log(`\nrelease: css-snapshot@${version} is out — https://www.npmjs.com/package/css-snapshot`);
