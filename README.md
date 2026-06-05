# `derive-version`

A self-contained composite action that derives **one repo-wide semantic version**
from git tags + conventional commits. The version is **never stored in-tree** —
there is no version-bump commit, no `CHANGELOG.md`, no `package.json` edit. The
latest tag is the floor; only commits since it are considered. Optionally it
pushes the tag and creates a GitHub Release (the changelog lives there).

This action is dependency-free on purpose (just Node + git + `gh`), so it can be
lifted into its own repo verbatim — see [Extraction](#extraction).

## What it computes

- **Bump size** from the conventional-commit types since the last tag: `feat` →
  minor, `fix`/`perf` → patch, breaking (`type!:` or a `BREAKING CHANGE:` footer)
  → see below. The highest bump in the batch wins. `docs`/`chore`/etc. alone → no
  release.
- **Bump mode is derived from the current major**, not configured:
  - `0.x`: breaking **and** `feat` both bump **minor**, `fix` bumps patch (the
    "anything can change in 0.x" convention).
  - `≥1.x`: breaking bumps **major**, `feat` minor, `fix` patch — switches over
    automatically the moment you reach `1.0.0`.
- **`Release-As: X.Y.Z` footer** forces an exact version (e.g. the jump to
  `1.0.0`). Honored only when it exceeds the current version (monotonic), it is
  its own release trigger, and it self-expires once tagged (it leaves every future
  since-last-tag window).
- **First run** with no tag **seeds** `initial-version` at `HEAD` — it does _not_
  replay history (no backfill).
- **`build-identity`** is always available (`git describe`), e.g.
  `v1.2.0-3-gabc1234` on a PR, for stamping preview builds.

## Inputs

| input             | default               | meaning                                                     |
| ----------------- | --------------------- | ----------------------------------------------------------- |
| `initial-version` | `0.1.0`               | Baseline seeded as the first release when no tag exists.    |
| `tag-prefix`      | `v`                   | Prefix identifying this scheme's tags.                      |
| `create-release`  | `false`               | When `true` and a release is warranted, push tag + Release. |
| `floating-tags`   | `false`               | When `true`, also advance floating `vMAJOR` / `vMAJOR.MINOR` tags. |
| `github-token`    | `${{ github.token }}` | Token for creating the Release (`contents: write`).         |

> **`floating-tags`** is for repos that **distribute a GitHub Action**, where the
> convention is that consumers pin `@v1` and get the latest `1.x` (and `@v1.4` the
> latest `1.4.x`). With it on, each release force-moves those aliases to the new
> commit — gated by `create-release`, so PR dry-runs push nothing. Leave it off
> (the default) when you ship Docker images / apps and don't want floating
> pointers in your tag namespace.

## Outputs

`version`, `tag`, `previous-tag`, `bump`, `released`, `via-release-as`,
`build-identity`. See [`action.yml`](./action.yml) for exact descriptions.

## Caller requirements

```yaml
permissions:
  contents: write # only needed when create-release: true (push tag + Release)

steps:
  - uses: actions/checkout@v4
    with:
      fetch-depth: 0 # full history — bump computation reads back to the last tag
      fetch-tags: true
  - uses: jlopez/derive-version@v1
    id: ver
    with:
      create-release: ${{ github.ref == 'refs/heads/main' }}
  # ${{ steps.ver.outputs.version }} / .build-identity are now available
```

## Semantics live in a pure, tested core

All decision logic is in [`version.mjs`](./version.mjs) — pure functions, no I/O —
exhaustively unit-tested in [`version.test.mjs`](./version.test.mjs). The runtime
wrapper [`derive-version.mjs`](./derive-version.mjs) only does the impure work
(read `git`, write outputs); `action.yml` only adds the `git tag` + `gh release`.

## Extraction

This repo **is** the extracted home. The action was first built in-repo inside its
first consumer (`uses: ./.github/actions/derive-version`) so it could be iterated
and troubleshot in the same PR/CI run, then lifted here verbatim once a second
consumer appeared — `action.yml` is byte-identical to its in-repo origin; the move
was logistics, not a refactor.

Consume it as `jlopez/derive-version@v1`; pin `@v1` for the floating major (it
tracks the latest `1.x`), or `@vMAJOR.MINOR` / an exact `@vX.Y.Z` for a stricter
pin. The pure core is tested here with Node's built-in runner — `node --test
version.test.mjs`, no dependencies — and the action [dogfoods itself](.github/workflows/ci.yml)
to cut its own releases.
