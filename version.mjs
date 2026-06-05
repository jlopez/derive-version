// Pure, dependency-free version-derivation logic for the `derive-version`
// composite action. No I/O, no git, no environment — every function here takes
// plain data and returns plain data, so the semantics are exhaustively
// unit-testable (see version.test.mjs). The action's runtime wrapper
// (derive-version.mjs) does the impure work: it reads `git log`, calls
// decideNextVersion(), then writes outputs / creates the tag + Release.
//
// Scheme (agreed in design):
//   - The version is DERIVED, never stored: the latest git tag is the floor and
//     only commits since that tag are considered. History is never replayed, so
//     the first run SEEDS a baseline (initialVersion) rather than backfilling.
//   - The bump size comes from conventional-commit types since the last tag.
//   - The bump *mode* is derived from the current major, not configured:
//       major === 0 : breaking -> minor, feat -> minor, fix -> patch
//       major >= 1  : breaking -> major, feat -> minor, fix -> patch
//     so the 0.x "everything-can-break" behavior switches off automatically the
//     moment you reach 1.0.0 — no flag to flip.
//   - A `Release-As: X.Y.Z` commit footer forces an exact version, honored only
//     when it exceeds the current version (monotonicity) and self-expiring once
//     tagged (it falls out of every future since-last-tag window). It is itself a
//     release trigger, even with no feat/fix in the batch.

/** Bump precedence, lowest to highest. */
const BUMP_RANK = { none: 0, patch: 1, minor: 2, major: 3 };

/**
 * Parse a `MAJOR.MINOR.PATCH` string (an optional leading `v` is tolerated) into
 * a {major, minor, patch} record. Throws on anything that isn't a plain triple —
 * we deliberately don't accept prerelease/build metadata in this scheme.
 * @param {string} input
 * @returns {{major: number, minor: number, patch: number}}
 */
export function parseVersion(input) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(input).trim());
  if (!m) throw new Error(`Not a MAJOR.MINOR.PATCH version: "${input}"`);
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

/** Render a version record back to `MAJOR.MINOR.PATCH` (no prefix). */
export function formatVersion(v) {
  return `${v.major}.${v.minor}.${v.patch}`;
}

/**
 * Compare two version records. Returns <0 if a<b, 0 if equal, >0 if a>b.
 */
export function compareVersions(a, b) {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

/**
 * Apply a bump to a version, returning a new record. `none` returns an equal
 * record (callers treat that as "no release").
 * @param {{major:number,minor:number,patch:number}} v
 * @param {'major'|'minor'|'patch'|'none'} bump
 */
export function applyBump(v, bump) {
  switch (bump) {
    case 'major':
      return { major: v.major + 1, minor: 0, patch: 0 };
    case 'minor':
      return { major: v.major, minor: v.minor + 1, patch: 0 };
    case 'patch':
      return { major: v.major, minor: v.minor, patch: v.patch + 1 };
    default:
      return { ...v };
  }
}

/**
 * Classify a single commit into the conventional-commit category that drives a
 * version bump, independent of the current major. Returns one of
 * `'breaking' | 'feat' | 'fix' | 'none'`.
 *
 * A commit is breaking if its subject uses the `type!:` / `type(scope)!:` bang,
 * or any line of its body is a `BREAKING CHANGE:` / `BREAKING-CHANGE:` footer.
 * Otherwise the leading conventional type decides: `feat` -> feat; `fix`/`perf`
 * -> fix; everything else (docs, chore, refactor, test, ci, build, style, …, or
 * a non-conventional subject) -> none.
 * @param {{subject?: string, body?: string}} commit
 * @returns {'breaking'|'feat'|'fix'|'none'}
 */
export function classifyCommit(commit) {
  const subject = (commit.subject ?? '').trim();
  const body = commit.body ?? '';

  const header = /^(\w+)(?:\(([^)]*)\))?(!)?:/.exec(subject);
  const bang = header?.[3] === '!';
  const breakingFooter = /^BREAKING[ -]CHANGE:/im.test(body);
  if (bang || breakingFooter) return 'breaking';

  const type = header?.[1]?.toLowerCase();
  if (type === 'feat') return 'feat';
  if (type === 'fix' || type === 'perf') return 'fix';
  return 'none';
}

/**
 * Map a commit category to a concrete bump given the current major. This is
 * where the 0.x vs >=1.x behavior lives.
 * @param {'breaking'|'feat'|'fix'|'none'} category
 * @param {number} currentMajor
 * @returns {'major'|'minor'|'patch'|'none'}
 */
export function bumpForCategory(category, currentMajor) {
  if (category === 'none') return 'none';
  if (category === 'fix') return 'patch';
  // feat:
  if (category === 'feat') return 'minor';
  // breaking:
  return currentMajor === 0 ? 'minor' : 'major';
}

/**
 * Scan commits for `Release-As:` footers and return the highest valid one, or
 * null if there are none. A footer line looks like `Release-As: 1.2.0` (the
 * `v` prefix and surrounding whitespace are tolerated; matching is
 * case-insensitive). The *highest* wins so a batch can't accidentally regress.
 * @param {Array<{subject?: string, body?: string}>} commits
 * @returns {{major:number,minor:number,patch:number}|null}
 */
export function parseReleaseAs(commits) {
  let best = null;
  const re = /^Release-As:\s*v?(\d+\.\d+\.\d+)\s*$/gim;
  for (const c of commits) {
    const text = `${c.subject ?? ''}\n${c.body ?? ''}`;
    for (const m of text.matchAll(re)) {
      const candidate = parseVersion(m[1]);
      if (!best || compareVersions(candidate, best) > 0) best = candidate;
    }
  }
  return best;
}

/**
 * The headline decision. Given the current released version (null on the very
 * first run), the configured seed, and the commits since the last tag, return
 * the next version and whether a release is warranted.
 *
 * @param {object} args
 * @param {string|null} args.currentVersion  Latest released version (no prefix), or null if none yet.
 * @param {string} args.initialVersion        Baseline used to seed the first release (e.g. "0.1.0").
 * @param {Array<{subject?: string, body?: string}>} args.commits  Commits since the last tag.
 * @returns {{version: string, previous: string|null, bump: 'major'|'minor'|'patch'|'none', released: boolean, viaReleaseAs: boolean, seeded: boolean}}
 */
export function decideNextVersion({ currentVersion, initialVersion, commits = [] }) {
  const releaseAs = parseReleaseAs(commits);

  // First run ever: seed the baseline at HEAD. We do NOT replay history (no
  // backfill); an explicit Release-As may still raise the seed above initial.
  if (currentVersion == null) {
    const initial = parseVersion(initialVersion);
    let version = initial;
    let viaReleaseAs = false;
    if (releaseAs && compareVersions(releaseAs, initial) > 0) {
      version = releaseAs;
      viaReleaseAs = true;
    }
    return {
      version: formatVersion(version),
      previous: null,
      bump: 'none',
      released: true,
      viaReleaseAs,
      seeded: true,
    };
  }

  const current = parseVersion(currentVersion);

  // Highest bump implied by the conventional commits, mapped through the current
  // major's rules.
  let bump = 'none';
  for (const c of commits) {
    const candidate = bumpForCategory(classifyCommit(c), current.major);
    if (BUMP_RANK[candidate] > BUMP_RANK[bump]) bump = candidate;
  }
  let version = applyBump(current, bump);

  // Release-As overrides, but only upward (never regress below what's released).
  let viaReleaseAs = false;
  if (
    releaseAs &&
    compareVersions(releaseAs, current) > 0 &&
    compareVersions(releaseAs, version) >= 0
  ) {
    version = releaseAs;
    viaReleaseAs = true;
  }

  const released = bump !== 'none' || viaReleaseAs;
  return {
    version: formatVersion(version),
    previous: currentVersion,
    bump,
    released,
    viaReleaseAs,
    seeded: false,
  };
}

const NOTE_SECTIONS = [
  { key: 'breaking', heading: '### ⚠ Breaking changes' },
  { key: 'feat', heading: '### Features' },
  { key: 'fix', heading: '### Fixes' },
];

/**
 * Render grouped Markdown release notes from the commits in a release. A single
 * unified version still gets a per-area story: bullets are grouped by category
 * (breaking / features / fixes) and labelled with their conventional scope, so
 * "what changed where" survives even though there's one version number.
 * Commits that don't bump anything (docs, chore, …) are omitted.
 * @param {Array<{subject?: string, body?: string, shortSha?: string}>} commits
 * @returns {string}
 */
export function renderReleaseNotes(commits) {
  const buckets = { breaking: [], feat: [], fix: [] };
  for (const c of commits) {
    const category = classifyCommit(c);
    const bucket =
      category === 'breaking'
        ? 'breaking'
        : category === 'feat'
          ? 'feat'
          : category === 'fix'
            ? 'fix'
            : null;
    if (!bucket) continue;
    const subject = (c.subject ?? '').trim();
    const sha = c.shortSha ? ` (${c.shortSha})` : '';
    buckets[bucket].push(`- ${subject}${sha}`);
  }
  const sections = NOTE_SECTIONS.filter((s) => buckets[s.key].length > 0).map(
    (s) => `${s.heading}\n${buckets[s.key].join('\n')}`,
  );
  return sections.length > 0 ? sections.join('\n\n') : '_No user-facing changes._';
}
