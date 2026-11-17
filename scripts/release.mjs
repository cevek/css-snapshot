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

const VERSION_FILES = ['package.json', 'package-lock.json'];
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
const testedHead = out('git', 'rev-parse', 'HEAD');

step('typecheck', 'npm', 'run', '--silent', 'typecheck');
step('tests: build + unit + browser + e2e', 'npm', 'run', '--silent', 'test:all');

if (dryRun) {
  step('npm publish --dry-run', 'npm', 'publish', '--dry-run', '--access', 'public');
  console.log('\nrelease: dry run passed — nothing was changed.');
  process.exit(0);
}

// The suite ran on `testedHead` with a clean tree: anything that moved since is not what
// was tested, and would also leak into the release commit.
if (out('git', 'rev-parse', 'HEAD') !== testedHead || out('git', 'status', '--porcelain')) {
  fail('the tree changed while the tests ran — nothing was released; re-run');
}

// Publish BEFORE committing or tagging: a rejected publish then rolls back to the clean
// tree it started from, and the same command can simply be re-run.
step(`version ${bump} (package.json only)`, 'npm', 'version', bump, '--no-git-tag-version');
const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const bumped = VERSION_FILES.map((f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8'));
const recovery = [
  `  git commit -m "Release ${version}" -- ${VERSION_FILES.join(' ')}   (if not done)`,
  `  git tag -a v${version} -m v${version}   (if not done)`,
  '  git push --follow-tags origin main',
  `  gh release create v${version} --title v${version} --generate-notes --verify-tag`,
].join('\n');

/** 'yes' | 'no' | 'unknown' — whether the registry has this version. */
function published() {
  try {
    return out('npm', 'view', `css-snapshot@${version}`, 'version') === version ? 'yes' : 'no';
  } catch (e) {
    return /E404|404 Not Found/.test(String(e.stderr ?? e)) ? 'no' : 'unknown';
  }
}

try {
  console.log(`\n▸ npm publish ${version}`);
  execFileSync('npm', ['publish', '--access', 'public'], { stdio: 'inherit' });
} catch {
  // A failed client is not proof the registry refused: the upload may have landed.
  const state = published();
  if (state === 'yes') {
    console.log(`\nrelease: npm publish reported a failure, but css-snapshot@${version} is on the registry — finishing.`);
  } else if (state === 'no') {
    const ours = VERSION_FILES.every((f, i) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8') === bumped[i]);
    if (ours) execFileSync('git', ['checkout', '--', ...VERSION_FILES]);
    fail(`npm publish failed and ${version} is not on the registry — ${ours ? 'version bump rolled back' : 'package.json changed meanwhile, left as is'}; nothing was released, re-run when fixed`);
  } else {
    fail(`npm publish failed and the registry cannot be queried — the bump to ${version} is left in place. `
      + `Check \`npm view css-snapshot@${version}\`: if it is there, finish by hand:\n${recovery}\n`
      + `if not, \`git checkout -- ${VERSION_FILES.join(' ')}\` and re-run.`);
  }
}
// Published: from here a failure is finished by hand, never by re-running (that would bump again).
const finish = (title, cmd, ...a) => {
  console.log(`\n▸ ${title}`);
  try {
    execFileSync(cmd, a, { stdio: 'inherit' });
  } catch {
    fail(`css-snapshot@${version} IS PUBLISHED, but "${title}" failed. Do NOT re-run release; finish by hand:\n${recovery}`);
  }
};
finish('commit', 'git', 'commit', '-m', `Release ${version}`, '--', ...VERSION_FILES);
finish('tag', 'git', 'tag', '-a', `v${version}`, '-m', `v${version}`);
finish('push commit + tag', 'git', 'push', '--follow-tags', 'origin', 'main');
finish('GitHub release', 'gh', 'release', 'create', `v${version}`, '--title', `v${version}`, '--generate-notes', '--verify-tag');
console.log(`\nrelease: css-snapshot@${version} is out — https://www.npmjs.com/package/css-snapshot`);
