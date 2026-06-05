// Runtime wrapper for the `derive-version` composite action: the only impure
// part. It reads `git` and the action inputs, calls the pure core in
// version.mjs, then writes step outputs and a release-notes file. Creating the
// tag + GitHub Release is left to action.yml (a couple of `git`/`gh` lines), so
// everything decision-shaped stays in the unit-tested core.
//
// Inputs arrive as env (set by action.yml from the composite inputs):
//   INPUT_INITIAL_VERSION  baseline seed for the first release      (e.g. 0.1.0)
//   INPUT_TAG_PREFIX       tag prefix that identifies our versions  (e.g. v)
// Outputs are written to $GITHUB_OUTPUT:
//   version, previous-tag, tag, bump, released, via-release-as, build-identity,
//   notes-file

import { execFileSync } from 'node:child_process';
import { appendFileSync, writeFileSync } from 'node:fs';
import {
  compareVersions,
  decideNextVersion,
  parseVersion,
  renderReleaseNotes,
} from './version.mjs';

const RS = '\x1e'; // record separator between commits
const FS = '\x1f'; // field separator within a commit

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The highest strict `<prefix>MAJOR.MINOR.PATCH` tag, or null if there are none.
 * The fnmatch glob `git tag --list` accepts is looser than our parser — it would
 * also match e.g. `v1.2.3.4` or `v1.2.3-rc.1`, which `parseVersion` then rejects
 * with a throw — so we filter to exact triples and pick the max with our own
 * `compareVersions` rather than trusting git's `-v:refname` order. (Deferring to
 * the same external sort that let the junk tag in is exactly what we don't want;
 * the pure core owns the ordering everything else relies on.)
 */
function latestVersionTag(prefix) {
  const strict = new RegExp(`^${escapeRegExp(prefix)}\\d+\\.\\d+\\.\\d+$`);
  let best = null;
  for (const tag of git('tag', '--list', `${prefix}*`)
    .split('\n')
    .filter((t) => strict.test(t))) {
    const v = parseVersion(tag.slice(prefix.length));
    if (!best || compareVersions(v, best.v) > 0) best = { tag, v };
  }
  return best?.tag ?? null;
}

/**
 * Commits in `range` (or all of history when range is null), parsed into
 * {subject, body, shortSha}. Uses NUL-free control separators so multi-line
 * bodies survive intact.
 */
function commitsSince(range) {
  const fmt = `%h${FS}%s${FS}%b${RS}`;
  const args = ['log', `--format=${fmt}`];
  if (range) args.push(range);
  const raw = execFileSync('git', args, { encoding: 'utf8' });
  return raw
    .split(RS)
    .map((rec) => rec.replace(/^\n/, ''))
    .filter((rec) => rec.trim().length > 0)
    .map((rec) => {
      const [shortSha = '', subject = '', body = ''] = rec.split(FS);
      return { shortSha, subject, body };
    });
}

function setOutput(key, value) {
  const file = process.env.GITHUB_OUTPUT;
  const line = `${key}=${value}\n`;
  if (file) appendFileSync(file, line);
  else process.stdout.write(line); // local runs: echo to stdout
}

function main() {
  const initialVersion = (process.env.INPUT_INITIAL_VERSION || '0.1.0').trim();
  const prefix = (process.env.INPUT_TAG_PREFIX ?? 'v').trim();

  const previousTag = latestVersionTag(prefix);
  const currentVersion = previousTag ? previousTag.slice(prefix.length) : null;
  // No backfill: only consider commits since the last tag. On the first run
  // (no tag) we still scan all history so a Release-As can raise the seed, but
  // the core ignores those commits for bump purposes. No `--first-parent`: the
  // repo squash-merges, so `<tag>..HEAD` is already the linear conventional
  // sequence — revisit only if true merge commits start landing on `main`.
  const commits = commitsSince(previousTag ? `${previousTag}..HEAD` : null);

  const decision = decideNextVersion({ currentVersion, initialVersion, commits });
  const tag = `${prefix}${decision.version}`;

  // The seed release backfills the version baseline, not the changelog: rendering
  // all-of-history here would list every past feat/fix under `0.1.0` even though
  // none drove that number (bump is `none`). Keep the seed's notes a placeholder.
  const notes = decision.seeded ? '_Initial release._' : renderReleaseNotes(commits);
  const notesFile = `${process.env.RUNNER_TEMP || '.'}/derive-version-notes.md`;
  writeFileSync(notesFile, notes);

  setOutput('version', decision.version);
  setOutput('previous-tag', decision.previous ? `${prefix}${decision.previous}` : '');
  setOutput('tag', tag);
  setOutput('bump', decision.bump);
  setOutput('released', String(decision.released));
  setOutput('via-release-as', String(decision.viaReleaseAs));
  setOutput('notes-file', notesFile);

  // Always-available build identity: the nearest tag plus distance + sha.
  // Computed before any tag is pushed, so PR previews read e.g.
  // `v0.1.0-3-gabc1234`; on main the release step re-stamps it post-tag. NOTE:
  // `describe` finds the topologically *nearest* tag, which can differ from the
  // *highest*-version tag latestVersionTag() uses as the bump floor in a
  // non-linear history — this string is descriptive only. The `--match` glob is
  // loose like latestVersionTag's, but describe never parses the match, so a
  // stray tag can't crash here (at worst it reads oddly).
  const buildIdentity = git('describe', '--tags', '--always', '--dirty', `--match=${prefix}[0-9]*`);
  setOutput('build-identity', buildIdentity);

  const summary = decision.released
    ? `${decision.seeded ? 'seed' : decision.bump}${decision.viaReleaseAs ? ' (Release-As)' : ''} → ${tag}`
    : `no release (previous ${previousTag ?? 'none'})`;
  process.stdout.write(`derive-version: ${summary}\n`);
}

main();
