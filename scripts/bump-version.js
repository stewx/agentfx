#!/usr/bin/env node
/**
 * Cuts a release: asks what kind of version this is and what to say about it,
 * writes the changelog entry, then bumps, commits and tags. Run `npm run bump`.
 *
 * It also runs without a prompt in sight, for scripted use:
 *
 *   npm run bump -- patch -m "Fixed the thing"
 *   npm run bump -- 1.0.0 -m "Added X" -m "Removed Y"
 *   npm run bump -- minor --dry-run     prints the changelog entry, writes nothing
 *
 * The bump, commit and tag are all done here rather than by `npm version`,
 * which cannot work for this: it commits before the changelog has been written,
 * and it refuses to run against the dirty tree that writing one would leave.
 * (Spawning it is also awkward — Node will not exec npm.cmd without a shell.)
 *
 * The tag is what .github/workflows/release.yml publishes from, and it refuses
 * to ship if the tag and package.json disagree, so the checks here (clean tree,
 * unused tag, version only moving forwards) all exist to avoid a tag that has to
 * be deleted and rewritten later.
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const pkgFile = path.join(root, 'package.json');
const changelogFile = path.join(root, 'CHANGELOG.md');

const RELEASE_TYPES = [
  'major', 'minor', 'patch', 'premajor', 'preminor', 'prepatch', 'prerelease'
];
// Deliberately stricter than semver allows: no build metadata, and a numeric
// prerelease tail only. npm tags do carry `+build`, but git tag names cannot,
// and `prerelease` can only increment a tail it can count.
const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

const CHANGELOG_PREAMBLE = `# Changelog

All notable changes to agentfx, newest first. Versions follow [semver][].

[semver]: https://semver.org/spec/v2.0.0.html
`;

function die(message) {
  console.error(`\nbump: ${message}`);
  process.exit(1);
}

function parse(version) {
  const match = SEMVER.exec(version);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    pre: match[4] ? match[4].split('.') : null
  };
}

function format({ major, minor, patch, pre }) {
  return `${major}.${minor}.${patch}${pre ? `-${pre.join('.')}` : ''}`;
}

/**
 * npm's own bump rules, reimplemented so the menu can show what each choice
 * lands on and so the exact version — not the release type — is what gets
 * handed to npm.
 */
function bump(current, type, preid) {
  const v = { ...current };
  const tail = preid ? [preid, 0] : [0];

  switch (type) {
    case 'major':
      // 1.2.3-rc.0 -> 1.0.0 is wrong; a prerelease of 1.0.0 releases as 1.0.0.
      if (!(v.pre && v.minor === 0 && v.patch === 0)) v.major += 1;
      v.minor = 0;
      v.patch = 0;
      break;
    case 'minor':
      if (!(v.pre && v.patch === 0)) v.minor += 1;
      v.patch = 0;
      break;
    case 'patch':
      if (!v.pre) v.patch += 1;
      break;
    case 'premajor':
      v.major += 1;
      v.minor = 0;
      v.patch = 0;
      v.pre = tail;
      return v;
    case 'preminor':
      v.minor += 1;
      v.patch = 0;
      v.pre = tail;
      return v;
    case 'prepatch':
      v.patch += 1;
      v.pre = tail;
      return v;
    case 'prerelease':
      if (!v.pre) {
        v.patch += 1;
        v.pre = tail;
      } else if (preid && v.pre[0] !== preid) {
        v.pre = tail;
      } else {
        const last = v.pre.length - 1;
        // A non-numeric tail (`1.0.0-rc`) has nothing to count from, so start one.
        if (/^\d+$/.test(v.pre[last])) v.pre = [...v.pre.slice(0, last), Number(v.pre[last]) + 1];
        else v.pre = [...v.pre, 0];
      }
      return v;
  }

  v.pre = null;
  return v;
}

/** -1, 0 or 1. A prerelease sorts below the release it leads to. */
function compare(a, b) {
  for (const part of ['major', 'minor', 'patch']) {
    if (a[part] !== b[part]) return a[part] < b[part] ? -1 : 1;
  }
  if (!a.pre && !b.pre) return 0;
  if (!a.pre) return 1;
  if (!b.pre) return -1;

  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i += 1) {
    const [x, y] = [a.pre[i], b.pre[i]];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    const numeric = /^\d+$/.test(x) && /^\d+$/.test(y);
    if (numeric) return Number(x) < Number(y) ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

/**
 * An exact version from the command line or the custom menu choice. Only ever
 * forwards: npm refuses to republish a version, and tag order is what a reader
 * uses to tell which release came last.
 */
function explicitVersion(input, current) {
  const explicit = parse(input.trim().replace(/^v/, ''));
  if (!explicit) return { error: `"${input.trim()}" is not a version like 1.2.3.` };
  if (compare(explicit, current) <= 0) {
    return { error: `${format(explicit)} is not newer than the current ${format(current)}.` };
  }
  return { version: format(explicit) };
}

function git(...args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

/**
 * Rewrites the version in place — the first `count` occurrences, which are the
 * package's own — rather than re-serialising the file. A parse/stringify round
 * trip would reformat anything not already shaped like `JSON.stringify(…, 2)`,
 * turning a one-line release diff into a whole-file one.
 *
 * `verify` re-reads the result and is not optional: the occurrence count is an
 * assumption about file layout, and a wrong guess must fail loudly here rather
 * than ship a lockfile claiming the old version.
 */
function setVersion(file, next, count, verify) {
  let replaced = 0;
  const updated = fs.readFileSync(file, 'utf8').replace(
    /"version":\s*"[^"]*"/g,
    (match) => (replaced++ < count ? `"version": "${next}"` : match)
  );

  fs.writeFileSync(file, updated);
  if (!verify(JSON.parse(updated))) {
    throw new Error(`${path.basename(file)} still does not read as version ${next}.`);
  }
}

/** Local date, not the UTC one `toISOString` would give an evening release. */
function today() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function releaseNotes(version, entries) {
  return `## ${version} - ${today()}\n\n${entries.map((e) => `- ${e}`).join('\n')}\n\n`;
}

/**
 * The new entry goes above every existing one but below the preamble, so the
 * file reads newest-first and the header survives.
 */
function withRelease(notes) {
  if (!fs.existsSync(changelogFile)) return `${CHANGELOG_PREAMBLE}\n${notes}`;

  const lines = fs.readFileSync(changelogFile, 'utf8').split('\n');
  const at = lines.findIndex((line) => line.startsWith('## '));
  if (at === -1) return `${lines.join('\n').replace(/\s*$/, '')}\n\n${notes}`;

  const preamble = lines.slice(0, at).join('\n').replace(/\s*$/, '');
  const rest = lines.slice(at).join('\n');
  return preamble ? `${preamble}\n\n${notes}${rest}` : `${notes}${rest}`;
}

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const messages = args.flatMap((arg, i) => (
  arg === '-m' || arg === '--message' ? [args[i + 1]] : []
)).filter(Boolean);
const positional = args.filter((arg, i) => (
  !arg.startsWith('-') && args[i - 1] !== '-m' && args[i - 1] !== '--message'
));
const [type, preid] = positional;

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (question) => new Promise((resolve) => rl.question(question, resolve));

let answered = false;
const closeInput = () => {
  answered = true;
  rl.close();
};

// Ctrl-D (or Ctrl-C) at a prompt ends stdin while a question is still pending,
// which resolves nothing and would otherwise drain the event loop and exit 0 as
// though the release had been made.
rl.on('close', () => {
  if (!answered) die('cancelled, nothing written.');
});

/** Prompting is only possible on a terminal; scripted runs must pass arguments. */
function requireTTY(problem, fix) {
  if (!process.stdin.isTTY) die(`${problem}, and this is not an interactive terminal — ${fix}.`);
}

async function chooseVersion(current) {
  const choices = [
    { type: 'patch', label: 'patch      ', hint: 'bug fixes' },
    { type: 'minor', label: 'minor      ', hint: 'new features, nothing broken' },
    { type: 'major', label: 'major      ', hint: 'breaking changes' },
    { type: 'prerelease', label: 'prerelease ', hint: 'not for general use yet' }
  ];

  console.log(`\n  agentfx is at ${format(current)}. What kind of release is this?\n`);
  for (const [i, choice] of choices.entries()) {
    const preview = format(bump(current, choice.type, choice.type === 'prerelease' ? 'rc' : null));
    console.log(`    ${i + 1}) ${choice.label} ${preview.padEnd(14)} ${choice.hint}`);
  }
  console.log(`    ${choices.length + 1}) custom      an exact version\n`);

  for (;;) {
    const answer = (await ask('  Release type [1]: ')).trim() || '1';
    const index = Number(answer) - 1;

    if (choices[index]) {
      let id = null;
      if (choices[index].type === 'prerelease') {
        id = (await ask('  Prerelease id [rc]: ')).trim() || 'rc';
      }
      return format(bump(current, choices[index].type, id));
    }

    // A typo in the version re-asks for the version. Dropping back to the menu
    // would make the mistake cost the whole choice again.
    if (index === choices.length) {
      for (;;) {
        const { version, error } = explicitVersion(await ask('  Version: '), current);
        if (version) return version;
        console.log(`  ${error}`);
      }
    }

    console.log(`  Pick 1-${choices.length + 1}.`);
  }
}

async function askEntries(version) {
  console.log(`\n  What changed in ${version}? One entry per line, blank line when done.\n`);
  const entries = [];

  for (;;) {
    const line = (await ask('    - ')).trim();
    if (line) {
      entries.push(line);
      continue;
    }
    if (entries.length) return entries;
    console.log('  At least one entry, please — it becomes the changelog for this release.');
  }
}

async function main() {
  const current = parse(JSON.parse(fs.readFileSync(pkgFile, 'utf8')).version);
  if (!current) die('package.json has a version this script cannot parse.');

  // Checked before anything is asked: no point composing a changelog for a
  // release that cannot happen. npm checks the tree too, but only after
  // rewriting package.json, and without naming what is dirty.
  const dirty = git('status', '--porcelain');
  if (dirty && !dryRun) {
    die(`the working tree has uncommitted changes:\n${dirty}\n\nCommit or stash them first.`);
  }

  const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
  if (branch !== 'main') console.warn(`\nbump: warning — on branch ${branch}, not main.`);

  let next;
  if (!type) {
    requireTTY('no release type given', `pass ${RELEASE_TYPES.join('/')} or a version`);
    next = await chooseVersion(current);
  } else if (RELEASE_TYPES.includes(type)) {
    next = format(bump(current, type, preid));
  } else {
    const { version, error } = explicitVersion(type, current);
    if (error) die(error);
    next = version;
  }

  const tag = `v${next}`;
  if (git('tag', '--list', tag)) die(`tag ${tag} already exists.`);

  let entries = messages;
  if (!entries.length) {
    requireTTY('no changelog entries given', 'pass them with -m "…"');
    entries = await askEntries(next);
  }

  const notes = releaseNotes(next, entries);
  console.log(`\n  ${format(current)} -> ${next}, into CHANGELOG.md as:\n`);
  console.log(notes.trimEnd().split('\n').map((line) => `    ${line}`).join('\n'));

  if (dryRun) {
    console.log('\n  --dry-run: nothing written.');
    return;
  }

  if (process.stdin.isTTY) {
    const go = (await ask(`\n  Bump, commit and tag ${tag}? [Y/n] `)).trim().toLowerCase();
    if (go && !['y', 'yes'].includes(go)) die('cancelled, nothing written.');
  }
  closeInput();

  const lockFile = path.join(root, 'package-lock.json');
  const staged = ['package.json', 'CHANGELOG.md'];
  if (fs.existsSync(lockFile)) staged.push('package-lock.json');

  // The entries go in the tag annotation as well as the commit body, because
  // `gh release create --notes-from-tag` below reads its release notes there.
  const body = entries.map((e) => `- ${e}`).join('\n');

  try {
    setVersion(pkgFile, next, 1, (json) => json.version === next);
    // Root and `packages[""]`, in that order, are the lockfile's first two
    // version fields; every entry after them belongs to a dependency.
    if (fs.existsSync(lockFile)) {
      setVersion(lockFile, next, 2, (json) => (
        json.version === next && (!json.packages || json.packages[''].version === next)
      ));
    }
    fs.writeFileSync(changelogFile, withRelease(notes));

    git('add', '--', ...staged);
    git('commit', '-m', `Release ${tag}`, '-m', body);
    git('tag', '-a', tag, '-m', `Release ${tag}`, '-m', body);
  } catch (err) {
    // Only the tracked files, so a first release does not suggest checking out
    // a CHANGELOG.md that git has never seen.
    const undo = git('ls-files', '--', ...staged).split('\n').filter(Boolean);
    die(`${err.message}\n\nAny bump and changelog written are not committed. `
      + `Finish by hand, or undo with:\n  git checkout -- ${undo.join(' ')}`);
  }

  console.log(`\n  Committed and tagged ${tag}. To release:

    git push origin ${branch} --follow-tags
    gh release create ${tag} --notes-from-tag

  Publishing to npm happens when that release is published — see
  .github/workflows/release.yml.\n`);
}

main().then(closeInput, (err) => {
  closeInput();
  die(err.stack || String(err));
});
