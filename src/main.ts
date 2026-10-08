import * as core from '@actions/core'
import * as github from '@actions/github'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { auditSites } from './checks/audit.js'
import { parseConfig } from './config.js'
import { OctokitGitApi, type Octokit } from './resolve/github.js'
import { Resolver } from './resolve/resolver.js'
import { annotate, postReview, writeSummary } from './report/actions.js'
import { countBySeverity } from './report/format.js'
import { addedLines, changedSites, isCommentable } from './scan/diff.js'
import { findAuditedFiles, isAuditedPath } from './scan/files.js'
import { findUses } from './scan/parse.js'
import type { UsesSite } from './types.js'

type Mode = 'changed' | 'all'
type FailOn = 'error' | 'warning' | 'never'

async function run() {
  const token = core.getInput('github-token', { required: true })
  let mode = oneOf<Mode>(core.getInput('mode') || 'changed', ['changed', 'all'], 'mode')
  const failOn = oneOf<FailOn>(core.getInput('fail-on') || 'error', ['error', 'warning', 'never'], 'fail-on')
  const suggest = (core.getInput('suggest') || 'true').toLowerCase() === 'true'
  const configPath = core.getInput('config-path') || '.github/actions-auditor.yml'

  const octokit = github.getOctokit(token)
  const { owner, repo } = github.context.repo
  const pr = github.context.payload.pull_request as
    | { number: number; base: { sha: string }; head: { sha: string } }
    | undefined
  if (mode === 'changed' && !pr) {
    core.info('Not a pull_request event; scanning all files instead of only changed lines.')
    mode = 'all'
  }

  // On PRs, read config from the *base* commit so a PR cannot loosen the rules it is judged by,
  // and read workflow files straight from the API at the PR head: no checkout of untrusted code needed.
  const configText = pr
    ? await fetchFile(octokit, owner, repo, configPath, pr.base.sha)
    : await readFile(path.join(workspace(), configPath), 'utf8').catch(() => null)
  const config = parseConfig(configText)

  const sites: UsesSite[] = []
  /** Lines touched by the PR, per file. `null` = whole file (patch too large to be returned). */
  const touched = new Map<string, Set<number> | null>()
  /** Each touched file's path in the base commit, or `null` if it wasn't an audited file there (new, or moved in). */
  const basePaths = new Map<string, string | null>()

  if (pr) {
    const files = await octokit.paginate(octokit.rest.pulls.listFiles, {
      owner,
      repo,
      pull_number: pr.number,
      per_page: 100,
    })
    for (const f of files) {
      if (f.status === 'removed' || !isAuditedPath(f.filename)) continue
      touched.set(f.filename, f.patch ? addedLines(f.patch) : null)
      const before = f.previous_filename ?? f.filename
      basePaths.set(f.filename, f.status !== 'added' && isAuditedPath(before) ? before : null)
    }
  }

  const sources: Array<{ file: string; text: string | null }> = []
  if (pr) {
    const paths = mode === 'changed' ? [...touched.keys()] : await listAuditedAt(octokit, owner, repo, pr.head.sha)
    for (const file of paths) sources.push({ file, text: await fetchFile(octokit, owner, repo, file, pr.head.sha) })
  } else {
    for (const file of await findAuditedFiles(workspace())) {
      sources.push({ file, text: await readFile(path.join(workspace(), file), 'utf8') })
    }
  }

  for (const { file, text } of sources) {
    if (text === null) continue
    const { sites: found, errors } = findUses(file, text)
    for (const e of errors) core.warning(`YAML parse problem: ${e}`, { file })
    if (pr && mode === 'changed') {
      // What the file already ran before this PR, so an edit that re-points an alias is still checked.
      const basePath = basePaths.get(file)
      const baseText = basePath ? await fetchFile(octokit, owner, repo, basePath, pr.base.sha) : null
      const baseValues = new Set(baseText ? findUses(file, baseText).sites.map((s) => s.value) : [])
      sites.push(...changedSites(found, touched.get(file), baseValues))
    } else {
      sites.push(...found)
    }
  }
  core.info(`Checking ${sites.length} uses: reference(s) in ${sources.length} file(s) (${mode} mode).`)

  const resolver = new Resolver(new OctokitGitApi(octokit))
  const findings = await auditSites(sites, { resolver, config })

  annotate(findings)
  core.setOutput('findings-count', findings.length)
  core.setOutput('findings-json', JSON.stringify(findings))

  let reviewNote: string | undefined
  if (pr && suggest && findings.length) {
    // Inline comments are only possible on lines that are part of the PR diff. When GitHub
    // omits a file's patch (large diffs) we can't know which lines those are, so skip it;
    // its findings still get annotations and the summary patch.
    const commentable = findings.filter((f) => isCommentable(touched, f.file, f.line))
    if (commentable.length) {
      try {
        const result = await postReview(
          octokit,
          { owner, repo, pullNumber: pr.number, headSha: pr.head.sha },
          commentable,
        )
        if (result === 'forbidden') {
          reviewNote =
            'Could not post suggestions (the token is read-only, as it is for PRs from forks). Use the patch above.'
        } else if (result === 'rejected') {
          reviewNote = 'GitHub rejected the inline suggestions (lines outside the diff). Use the patch above.'
        }
      } catch (err) {
        // Commenting is best-effort: never let it hide the summary or change the verdict.
        reviewNote = `Could not post suggestions: ${err instanceof Error ? err.message : String(err)}. Use the patch above.`
      }
      if (reviewNote) core.warning(reviewNote)
    }
  }

  await writeSummary(findings, { scanned: sites.length, mode, reviewNote })

  const { errors, warnings } = countBySeverity(findings)
  if ((failOn === 'error' && errors) || (failOn === 'warning' && errors + warnings)) {
    core.setFailed(
      `actions-auditor: ${errors} error(s), ${warnings} warning(s). Pin every action to a full commit SHA.`,
    )
  }
}

async function fetchFile(octokit: Octokit, owner: string, repo: string, file: string, ref: string) {
  try {
    const { data } = await octokit.rest.repos.getContent({ owner, repo, path: file, ref, mediaType: { format: 'raw' } })
    return data as unknown as string
  } catch (err) {
    if ((err as { status?: number }).status === 404) return null
    throw err
  }
}

async function listAuditedAt(octokit: Octokit, owner: string, repo: string, sha: string): Promise<string[]> {
  const { data } = await octokit.rest.git.getTree({ owner, repo, tree_sha: sha, recursive: 'true' })
  if (data.truncated) core.warning('Repository tree is too large to list fully; some files may not be scanned.')
  return data.tree.filter((e) => e.type === 'blob' && e.path && isAuditedPath(e.path)).map((e) => e.path!)
}

function workspace(): string {
  return process.env.GITHUB_WORKSPACE || process.cwd()
}

function oneOf<T extends string>(value: string, allowed: T[], name: string): T {
  if (!(allowed as string[]).includes(value)) throw new Error(`input \`${name}\` must be one of: ${allowed.join(', ')}`)
  return value as T
}

run().catch((err: unknown) => core.setFailed(err instanceof Error ? err.message : String(err)))
