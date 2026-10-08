import * as core from '@actions/core'
import type { Octokit } from '../resolve/github.ts'
import type { Finding } from '../types.ts'
import { buildPatch, countBySeverity, stripTicks } from './format.ts'

const MARKER = 'actions-auditor'

export function annotate(findings: Finding[]) {
  for (const f of findings) {
    const props = { file: f.file, startLine: f.line, title: `actions-auditor: ${f.rule}` }
    const message = stripTicks(f.message) + (f.fix ? `\nSuggested: ${f.fix.newLine.trim()}` : '')
    if (f.severity === 'error') core.error(message, props)
    else core.warning(message, props)
  }
}

export async function writeSummary(findings: Finding[], opts: { scanned: number; mode: string; reviewNote?: string }) {
  const { errors, warnings } = countBySeverity(findings)
  const s = core.summary.addHeading('actions-auditor', 2)
  if (!findings.length) {
    s.addRaw(`✅ ${opts.scanned} \`uses:\` reference(s) checked (${opts.mode} mode). Everything is pinned.`, true)
    await s.write()
    return
  }
  s.addRaw(`**${errors} error(s), ${warnings} warning(s)** across ${opts.scanned} checked reference(s).`, true)
  s.addTable([
    [
      { data: 'Severity', header: true },
      { data: 'Location', header: true },
      { data: 'Rule', header: true },
      { data: 'Details', header: true },
    ],
    ...findings.map((f) => [
      f.severity === 'error' ? '❌ error' : '⚠️ warning',
      `<code>${escapeHtml(f.file)}:${f.line}</code>`,
      `<code>${f.rule}</code>`,
      escapeHtml(stripTicks(f.message)),
    ]),
  ])
  const patch = buildPatch(findings)
  if (patch) {
    s.addHeading('Fix', 3)
    s.addRaw('Save this as `pin.patch` and run `git apply --unidiff-zero pin.patch`:', true)
    s.addCodeBlock(patch, 'diff')
  }
  if (opts.reviewNote) s.addRaw(`<sub>${opts.reviewNote}</sub>`, true)
  s.addRaw(
    '\n<sub>Why: tags and branches are mutable. Whoever controls them controls what runs in your CI ' +
      '(see tj-actions/changed-files, CVE-2025-30066). A full commit SHA cannot be repointed.</sub>',
    true,
  )
  await s.write()
}

export interface PullTarget {
  owner: string
  repo: string
  pullNumber: number
  headSha: string
}

/**
 * Posts one review with an inline comment per offending line, using ```suggestion blocks
 * so the author can apply fixes with one click. Lines that already carry our comment are
 * skipped, so re-runs don't spam.
 */
export async function postReview(
  octokit: Octokit,
  target: PullTarget,
  findings: Finding[],
): Promise<'posted' | 'nothing-new' | 'forbidden' | 'rejected'> {
  const byLine = Map.groupBy(findings, (f) => `${f.file}:${f.line}`)

  const existing = new Set<string>()
  const prior = await octokit.paginate(octokit.rest.pulls.listReviewComments, {
    owner: target.owner,
    repo: target.repo,
    pull_number: target.pullNumber,
    per_page: 100,
  })
  for (const c of prior) {
    const m = c.body?.match(/<!-- actions-auditor:(.+?) -->/)
    if (m) existing.add(m[1])
  }

  const comments = []
  for (const [, group] of byLine) {
    const first = group[0]
    const markerKey = `${first.file}:${first.line}:${encodeURIComponent(first.uses)}:${group.map((g) => g.rule).join(',')}`
    if (existing.has(markerKey)) continue
    const fix = group.find((g) => g.fix)?.fix
    const body = [
      `<!-- ${MARKER}:${markerKey} -->`,
      ...group.map((g) => `${g.severity === 'error' ? '❌' : '⚠️'} **actions-auditor** \`${g.rule}\`: ${g.message}`),
      ...(fix ? ['', '```suggestion', fix.newLine, '```'] : []),
    ].join('\n')
    comments.push({ path: first.file, line: first.line, side: 'RIGHT' as const, body })
  }
  if (!comments.length) return 'nothing-new'

  try {
    await octokit.rest.pulls.createReview({
      owner: target.owner,
      repo: target.repo,
      pull_number: target.pullNumber,
      commit_id: target.headSha,
      event: 'COMMENT',
      body: `actions-auditor found ${comments.length} \`uses:\` line(s) that need attention.`,
      comments,
    })
    return 'posted'
  } catch (err) {
    const status = (err as { status?: number }).status
    if (status === 403) return 'forbidden'
    if (status === 422) return 'rejected'
    throw err
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\|/g, '&#124;')
}
