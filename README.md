# actions-auditor

A pull-request gate that fails when someone adds a GitHub Action that isn't pinned to a full commit SHA. It also posts a one-click fix.

```diff
-      - uses: actions/checkout@v4
+      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4.4.0
```

## Why

Tags and branches are mutable. Whoever can push to `some/action` can move `v4` to new code, and that code runs in your CI with your secrets. This has already happened:

- **tj-actions/changed-files** (CVE-2025-30066): an attacker repointed nearly every tag to a commit that printed runner secrets into build logs.
- **reviewdog/action-setup** (CVE-2025-30154): the same attack through the `v1` tag.
- **Shai-Hulud**: a self-spreading npm worm that steals CI tokens and pushes malicious code into repositories it can reach.

A full 40-character commit SHA can't be repointed. Install this check early and unpinned references never get merged.

## Install

1. Copy [`examples/actions-auditor.yml`](examples/actions-auditor.yml) to `.github/workflows/actions-auditor.yml`. Replace `your-org/actions-auditor@<sha>` with this repo's release SHA.
2. In **Settings → Rules** (or branch protection), make the **`audit`** check required on your default branch.
3. Optional: add [`examples/dependabot.yml`](examples/dependabot.yml). Dependabot updates SHA pins and their `# vX.Y.Z` comments, so pinned actions keep getting updates.
4. Optional: if the repo already has unpinned actions, add [`examples/actions-auditor-scheduled.yml`](examples/actions-auditor-scheduled.yml), run it once from the Actions tab (*Run workflow*), and apply the patch from its job summary with `git apply --unidiff-zero`.

On each PR, the auditor checks the `uses:` lines the PR adds or changes:

- **Fails the check**, which blocks the merge if the check is required. GitHub's own notifications tell the author.
- **Annotates the line** in the "Files changed" tab.
- **Posts a review comment with a `suggestion` block.** The author clicks *Commit suggestion* and the check goes green on the next run.
- **Writes a job summary** with a `git apply`-ready patch. This is the fallback for PRs from forks, where the token can't comment.

There's no checkout step. Files are read through the API at the PR's head commit, so no untrusted PR code is checked out or run.

## What it checks

| Rule | Default | Meaning |
|---|---|---|
| `unpinned-ref` | error | `@v4`, `@v4.1.0`: a tag. **Auto-suggests** the SHA, with the most specific matching tag as a comment. |
| `branch-ref` | error | `@main`: a branch. No auto-fix, because the right commit is a judgment call. The message shows the branch head and the latest release SHA. |
| `ambiguous-ref` | error | The name is both a tag and a branch, so it's unclear what was meant. No auto-fix. |
| `short-sha` | error | `@abc1234`: an abbreviated SHA can collide. |
| `imposter-commit` | error | The SHA isn't on any branch or tag of the upstream repo. GitHub serves fork commits under the parent's name, so `actions/checkout@<sha>` can be attacker code pushed to a fork. |
| `unknown-commit` | error | The SHA doesn't exist in the repo. |
| `compromised` | error | The SHA is a known-malicious commit ([`data/compromised.json`](data/compromised.json)). Also catches a tag that *currently resolves* to one. |
| `unpinned-docker` | error | `docker://image:tag` has no `@sha256:` digest. |
| `unresolvable-ref` | error | The repo or ref doesn't exist, or the token can't read it. |
| `denied` | error | Matches your `deny` list. |
| `invalid-uses` | error | Malformed `uses:` value. |
| `comment-drift` | warning | `@<sha> # v4.1.0`, but `v4.1.0` is a different commit. Suggests the correct comment. |
| `fork-target` | warning | The referenced repo is itself a fork. Auto-suggestions are turned off for it. |
| `renamed-repo` | warning | The repo name redirects (repo-jacking risk). Auto-suggestions are turned off for it. |
| `archived-repo` | warning | The repo is archived, so no security fixes will arrive. |

It covers `jobs.<id>.steps[*].uses`, reusable workflows (`jobs.<id>.uses`), and composite actions (`runs.steps[*].uses` in any `action.yml`). YAML anchors and aliases are followed, so `uses: *ref` is checked like any other line. On pull requests, a `uses:` is checked when the PR edits it, adds an alias to it, or makes it run in a job that didn't run it before (for example by renaming or deleting anchors). Other events (schedule, push, `workflow_dispatch`) check every file, except `merge_group`, which passes because each pull request in a merge queue was already checked.

Allow-listed repos skip only the pinning rules. Whatever their tag or branch currently points at is still checked against the compromised list and `owner/repo@sha` deny entries. Deny entries match the resolved commit too, so a tag can't dodge a SHA entry.

## Inputs

| Input | Default | |
|---|---|---|
| `github-token` | `${{ github.token }}` | Needs `contents: read`, plus `pull-requests: write` for suggestions. Use a PAT or app token if you reference private actions in other repos. |
| `suggest` | `true` | Post review comments with suggested fixes. |
| `fail-on` | `error` | `error`, `warning`, or `never`. |
| `config-path` | `.github/actions-auditor.yml` | See [`examples/actions-auditor-config.yml`](examples/actions-auditor-config.yml). |

Outputs: `findings-count` and `findings-json`.

### Config

```yaml
# .github/actions-auditor.yml
allow: [my-org/*]           # exempt from pinning (deny + compromised checks still apply)
deny: [sketchy/*, foo/bar@<sha>]
severity: { comment-drift: error, archived-repo: off }
```

On PRs, the config is read from the **base** commit, so a PR can't loosen the rules it's judged by.

## Hardening the gate

A `pull_request` workflow runs the PR's own copy of the workflow file. A malicious PR could edit `actions-auditor.yml` to set `fail-on: never`. Deleting the workflow doesn't help an attacker: a required check that never reports keeps the PR blocked. Close the editing loophole with one of these:

- **Rulesets → Require workflows to pass** (org level). The auditor runs from a central repo the PR can't edit. This is the strongest option.
- **CODEOWNERS** on `/.github/` with *Require review from Code Owners*, so changes to workflows and to this config need a security owner's approval.

Also consider:

- the weekly full scan in [`examples/actions-auditor-scheduled.yml`](examples/actions-auditor-scheduled.yml)
- org-level **"Require actions to be pinned to a full-length commit SHA"** in Settings → Actions, which this check complements with suggestions, imposter detection, and comment checks

## Limitations

- Only *your* workflow files are checked. A third-party composite action you pin can still use unpinned actions internally.
- Docker images aren't auto-fixed, because resolving a digest needs registry access.
- On fork PRs, `GITHUB_TOKEN` is read-only. You get annotations and a patch instead of clickable suggestions.

## Development

```bash
npm ci
```
```bash
npm run all
```

`npm run all` typechecks, runs the tests (`node --test`, with an in-memory GitHub API fake), and bundles to `dist/` with `ncc`. `dist/` is committed, because GitHub runs it directly. CI fails if it's stale.
