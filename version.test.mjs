import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyBump,
  bumpForCategory,
  classifyCommit,
  compareVersions,
  decideNextVersion,
  formatVersion,
  parseReleaseAs,
  parseVersion,
  renderReleaseNotes,
} from './version.mjs';

/** Tiny helper so tests read as conventional-commit messages. */
const c = (subject, body = '') => ({ subject, body });

/** Assert every key in `expected` deep-equals the same key in `actual` (partial match). */
const matchObject = (actual, expected) => {
  for (const [k, v] of Object.entries(expected)) assert.deepEqual(actual[k], v);
};

describe('parseVersion / formatVersion', () => {
  it('parses a plain triple', () => {
    assert.deepEqual(parseVersion('1.2.3'), { major: 1, minor: 2, patch: 3 });
  });
  it('tolerates a leading v and whitespace', () => {
    assert.deepEqual(parseVersion('  v0.7.0 '), { major: 0, minor: 7, patch: 0 });
  });
  it('round-trips through formatVersion (no prefix)', () => {
    assert.equal(formatVersion(parseVersion('v3.4.5')), '3.4.5');
  });
  it('rejects prerelease / non-triple input', () => {
    assert.throws(() => parseVersion('1.2.3-rc.1'));
    assert.throws(() => parseVersion('1.2'));
    assert.throws(() => parseVersion('latest'));
  });
});

describe('compareVersions', () => {
  it('orders by major, then minor, then patch', () => {
    assert.ok(compareVersions(parseVersion('1.0.0'), parseVersion('0.9.9')) > 0);
    assert.ok(compareVersions(parseVersion('0.2.0'), parseVersion('0.2.1')) < 0);
    assert.equal(compareVersions(parseVersion('2.3.4'), parseVersion('2.3.4')), 0);
  });
});

describe('applyBump', () => {
  it('resets lower components on a bump', () => {
    const v = parseVersion('1.4.7');
    assert.equal(formatVersion(applyBump(v, 'major')), '2.0.0');
    assert.equal(formatVersion(applyBump(v, 'minor')), '1.5.0');
    assert.equal(formatVersion(applyBump(v, 'patch')), '1.4.8');
    assert.equal(formatVersion(applyBump(v, 'none')), '1.4.7');
  });
});

describe('classifyCommit', () => {
  it('reads the leading conventional type', () => {
    assert.equal(classifyCommit(c('feat(engine): add cricket song')), 'feat');
    assert.equal(classifyCommit(c('fix(ai): stop double-play')), 'fix');
    assert.equal(classifyCommit(c('perf(engine): faster reduce')), 'fix');
    assert.equal(classifyCommit(c('docs(engine): record ruling')), 'none');
    assert.equal(classifyCommit(c('chore: bump deps')), 'none');
  });
  it('treats a non-conventional subject as none', () => {
    assert.equal(classifyCommit(c('Merge branch main')), 'none');
  });
  it('detects the breaking bang in the subject', () => {
    assert.equal(classifyCommit(c('feat(engine)!: new request model')), 'breaking');
    assert.equal(classifyCommit(c('refactor!: drop legacy seam')), 'breaking');
  });
  it('detects a BREAKING CHANGE footer in the body', () => {
    assert.equal(
      classifyCommit(c('feat: rework deck', 'BREAKING CHANGE: deck.tsv ids changed')),
      'breaking',
    );
    assert.equal(
      classifyCommit(c('fix: tweak', 'BREAKING-CHANGE: hyphenated spelling too')),
      'breaking',
    );
  });
});

describe('bumpForCategory (mode derived from current major)', () => {
  it('in 0.x: breaking AND feat both bump minor, fix bumps patch', () => {
    assert.equal(bumpForCategory('breaking', 0), 'minor');
    assert.equal(bumpForCategory('feat', 0), 'minor');
    assert.equal(bumpForCategory('fix', 0), 'patch');
    assert.equal(bumpForCategory('none', 0), 'none');
  });
  it('at >=1.x: breaking bumps major, feat minor, fix patch', () => {
    assert.equal(bumpForCategory('breaking', 1), 'major');
    assert.equal(bumpForCategory('feat', 1), 'minor');
    assert.equal(bumpForCategory('fix', 2), 'patch');
  });
});

describe('parseReleaseAs', () => {
  it('returns null when no footer is present', () => {
    assert.equal(parseReleaseAs([c('feat: x'), c('fix: y', 'body only')]), null);
  });
  it('extracts a footer and tolerates v-prefix / case', () => {
    assert.equal(
      formatVersion(parseReleaseAs([c('chore: cut 1.0', 'Release-As: v1.0.0')])),
      '1.0.0',
    );
    assert.equal(formatVersion(parseReleaseAs([c('chore: cut', 'release-as: 2.1.0')])), '2.1.0');
  });
  it('takes the highest across multiple footers', () => {
    const found = parseReleaseAs([
      c('a', 'Release-As: 1.0.0'),
      c('b', 'Release-As: 1.2.0'),
      c('c', 'Release-As: 1.1.0'),
    ]);
    assert.equal(formatVersion(found), '1.2.0');
  });
  it('ignores a Release-As that is only mentioned mid-line, not as a footer', () => {
    assert.equal(parseReleaseAs([c('feat: mention Release-As: 9.9.9 in prose only')]), null);
  });
});

describe('decideNextVersion — seeding (first run, no prior tag)', () => {
  it('seeds the configured initial version and marks it released', () => {
    assert.deepEqual(
      decideNextVersion({
        currentVersion: null,
        initialVersion: '0.1.0',
        commits: [c('feat: anything')],
      }),
      {
        version: '0.1.0',
        previous: null,
        bump: 'none',
        released: true,
        viaReleaseAs: false,
        seeded: true,
      },
    );
  });
  it('does NOT backfill: a pile of feats still seeds at initial, not higher', () => {
    const many = Array.from({ length: 20 }, (_, i) => c(`feat: thing ${i}`));
    assert.equal(
      decideNextVersion({ currentVersion: null, initialVersion: '0.1.0', commits: many }).version,
      '0.1.0',
    );
  });
  it('lets a Release-As raise the seed above initial', () => {
    const r = decideNextVersion({
      currentVersion: null,
      initialVersion: '0.1.0',
      commits: [c('chore: launch', 'Release-As: 1.0.0')],
    });
    matchObject(r, { version: '1.0.0', seeded: true, viaReleaseAs: true, released: true });
  });
  it('ignores a Release-As below the seed', () => {
    const r = decideNextVersion({
      currentVersion: null,
      initialVersion: '0.5.0',
      commits: [c('chore', 'Release-As: 0.2.0')],
    });
    matchObject(r, { version: '0.5.0', viaReleaseAs: false });
  });
});

describe('decideNextVersion — 0.x development (breaking and feat both -> minor)', () => {
  it('feat bumps minor', () => {
    matchObject(
      decideNextVersion({
        currentVersion: '0.1.0',
        initialVersion: '0.1.0',
        commits: [c('feat: x')],
      }),
      {
        version: '0.2.0',
        bump: 'minor',
        released: true,
      },
    );
  });
  it('a breaking change also bumps only minor while in 0.x', () => {
    matchObject(
      decideNextVersion({
        currentVersion: '0.7.3',
        initialVersion: '0.1.0',
        commits: [c('feat!: rework')],
      }),
      {
        version: '0.8.0',
        bump: 'minor',
      },
    );
  });
  it('fix bumps patch', () => {
    assert.equal(
      decideNextVersion({
        currentVersion: '0.2.0',
        initialVersion: '0.1.0',
        commits: [c('fix: y')],
      }).version,
      '0.2.1',
    );
  });
  it('docs/chore-only batch is not released', () => {
    matchObject(
      decideNextVersion({
        currentVersion: '0.2.0',
        initialVersion: '0.1.0',
        commits: [c('docs: a'), c('chore: b')],
      }),
      {
        version: '0.2.0',
        bump: 'none',
        released: false,
      },
    );
  });
  it('takes the max bump across a mixed batch', () => {
    const r = decideNextVersion({
      currentVersion: '0.4.4',
      initialVersion: '0.1.0',
      commits: [c('fix: a'), c('feat: b'), c('docs: c')],
    });
    matchObject(r, { version: '0.5.0', bump: 'minor' });
  });
});

describe('decideNextVersion — Release-As (the 1.0.0 promotion and beyond)', () => {
  it('promotes 0.x straight to 1.0.0 regardless of the bump in the batch', () => {
    const r = decideNextVersion({
      currentVersion: '0.7.0',
      initialVersion: '0.1.0',
      commits: [c('feat: x'), c('chore: cut', 'Release-As: 1.0.0')],
    });
    matchObject(r, { version: '1.0.0', viaReleaseAs: true, released: true });
  });
  it('a Release-As is its own release trigger with only chores present', () => {
    const r = decideNextVersion({
      currentVersion: '0.7.0',
      initialVersion: '0.1.0',
      commits: [c('chore: only', 'Release-As: 1.0.0')],
    });
    matchObject(r, { version: '1.0.0', released: true, viaReleaseAs: true });
  });
  it('ignores a Release-As at or below the current version (monotonic)', () => {
    const r = decideNextVersion({
      currentVersion: '1.2.0',
      initialVersion: '0.1.0',
      commits: [c('fix: a', 'Release-As: 1.1.0')],
    });
    matchObject(r, { version: '1.2.1', bump: 'patch', viaReleaseAs: false });
  });
  it('takes the computed bump when it exceeds the Release-As', () => {
    const r = decideNextVersion({
      currentVersion: '1.0.0',
      initialVersion: '0.1.0',
      commits: [c('feat!: big', 'Release-As: 1.0.1')],
    });
    matchObject(r, { version: '2.0.0', bump: 'major', viaReleaseAs: false });
  });
});

describe('decideNextVersion — >=1.x (breaking is now major, automatically)', () => {
  it('breaking bumps major once past 1.0.0, with no config change', () => {
    matchObject(
      decideNextVersion({
        currentVersion: '1.4.2',
        initialVersion: '0.1.0',
        commits: [c('feat!: x')],
      }),
      {
        version: '2.0.0',
        bump: 'major',
      },
    );
  });
  it('feat still bumps minor, fix still patch', () => {
    assert.equal(
      decideNextVersion({
        currentVersion: '1.4.2',
        initialVersion: '0.1.0',
        commits: [c('feat: x')],
      }).version,
      '1.5.0',
    );
    assert.equal(
      decideNextVersion({
        currentVersion: '1.4.2',
        initialVersion: '0.1.0',
        commits: [c('fix: x')],
      }).version,
      '1.4.3',
    );
  });
});

describe('renderReleaseNotes', () => {
  it('groups by category with scope-bearing subjects and short shas', () => {
    const notes = renderReleaseNotes([
      { subject: 'feat(engine): add cricket song', shortSha: 'aaa1111' },
      { subject: 'fix(ai): stop double-play', shortSha: 'bbb2222' },
      { subject: 'feat(ui)!: new table layout', shortSha: 'ccc3333' },
      { subject: 'docs(engine): note ruling', shortSha: 'ddd4444' },
    ]);
    assert.ok(notes.includes('### ⚠ Breaking changes'));
    assert.ok(notes.includes('- feat(ui)!: new table layout (ccc3333)'));
    assert.ok(notes.includes('### Features\n- feat(engine): add cricket song (aaa1111)'));
    assert.ok(notes.includes('### Fixes\n- fix(ai): stop double-play (bbb2222)'));
    assert.ok(!notes.includes('docs(engine)'));
  });
  it('falls back to a placeholder when nothing is user-facing', () => {
    assert.equal(renderReleaseNotes([{ subject: 'chore: deps' }]), '_No user-facing changes._');
  });
});
