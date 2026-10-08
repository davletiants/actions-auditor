import compromisedList from '../../data/compromised.json' with { type: 'json' }
import { globMatch, type Config } from '../config.js'
import type { RefResolution, Resolver } from '../resolve/resolver.js'
import { actionName, FULL_SHA, parseActionRef, type ActionRef } from '../scan/reference.js'
import type { Finding, Fix, RuleId, UsesSite } from '../types.js'
import { rewriteLine } from './fix.js'

export interface CompromisedEntry {
  action: string
  sha: string
  advisory: string
  note?: string
}

export const BUILTIN_COMPROMISED: CompromisedEntry[] = compromisedList

export interface AuditContext {
  resolver: Resolver
  config: Config
  compromised?: CompromisedEntry[]
}

type RepoRef = Extract<ActionRef, { kind: 'repo' }>

export async function auditSites(sites: UsesSite[], ctx: AuditContext): Promise<Finding[]> {
  // Sequential on purpose: lookups are memoized, and bursts of parallel calls trip secondary rate limits.
  const findings: Finding[] = []
  for (const site of sites) findings.push(...(await auditSite(site, ctx)))
  return findings
}

export async function auditSite(site: UsesSite, ctx: AuditContext): Promise<Finding[]> {
  const findings: Finding[] = []
  const add = (rule: RuleId, message: string, fix?: Fix) => {
    const level = ctx.config.severity[rule]
    if (level === 'off') return
    findings.push({ rule, severity: level, file: site.file, line: site.line, uses: site.value, message, fix })
  }

  const ref = parseActionRef(site.value)
  switch (ref.kind) {
    case 'local':
      return findings
    case 'invalid':
      add('invalid-uses', `\`${ref.raw}\`: ${ref.reason}.`)
      return findings
    case 'docker':
      if (!ref.digest) {
        add(
          'unpinned-docker',
          `\`${ref.raw}\` uses a mutable image tag. Pin it by digest (\`docker://image@sha256:...\`); ` +
            'get the digest with `docker buildx imagetools inspect <image>`.',
        )
      }
      return findings
  }

  await auditRepoRef(site, ref, ctx, add)
  return findings
}

async function auditRepoRef(
  site: UsesSite,
  ref: RepoRef,
  ctx: AuditContext,
  add: (rule: RuleId, message: string, fix?: Fix) => void,
) {
  const { resolver, config } = ctx
  const name = actionName(ref)
  const repoName = `${ref.owner}/${ref.repo}`
  const compromised = ctx.compromised ?? BUILTIN_COMPROMISED

  const checkCompromised = (sha: string, via?: string) => {
    const hit = compromised.find((c) => c.action.toLowerCase() === repoName.toLowerCase() && c.sha === sha)
    if (hit) {
      add(
        'compromised',
        `\`${repoName}@${sha}\`${via ? ` (resolved from \`${via}\`)` : ''} is a known-malicious commit. ` +
          `${hit.note ? `${hit.note}. ` : ''}See ${hit.advisory}. Rotate any secrets this workflow could access.`,
      )
    }
  }

  // `owner/repo` deny entries block the whole action. `owner/repo@ref` entries block one ref and are
  // matched against the literal ref *and* every commit it resolves to, so a tag can't dodge a SHA entry.
  const deniedRefs: Array<{ entry: string; ref: string }> = []
  for (const entry of config.deny) {
    const at = entry.lastIndexOf('@')
    const pattern = at === -1 ? entry : entry.slice(0, at)
    if (!globMatch(pattern, repoName) && !globMatch(pattern, name)) continue
    if (at === -1) add('denied', `\`${site.value}\` matches deny-list entry \`${entry}\`.`)
    else deniedRefs.push({ entry, ref: entry.slice(at + 1).toLowerCase() })
  }
  const reportedDenials = new Set<string>()
  const checkDeniedRef = (value: string, via?: string) => {
    for (const d of deniedRefs) {
      if (d.ref !== value.toLowerCase() || reportedDenials.has(d.entry)) continue
      reportedDenials.add(d.entry)
      add('denied', `\`${site.value}\`${via ? ` (resolves to \`${value}\`)` : ''} matches deny-list entry \`${d.entry}\`.`)
    }
  }
  /** A commit this reference runs, directly or through a tag/branch, must be neither compromised nor denied. */
  const checkCommit = (sha: string, via?: string) => {
    checkCompromised(sha, via)
    checkDeniedRef(sha, via)
  }

  checkDeniedRef(ref.ref)
  if (ref.isSha) checkCompromised(ref.ref)

  if (config.allow.some((p) => globMatch(p, repoName) || globMatch(p, name))) {
    // Allowed actions skip the pinning rules, but whatever their tag or branch points at right now
    // must still not be a known-malicious or denied commit.
    if (!ref.isSha && !ref.isShortSha) {
      for (const sha of resolvedShas(await resolver.resolveRef(ref.owner, ref.repo, ref.ref))) checkCommit(sha, ref.ref)
    }
    return
  }

  const info = await resolver.repo(ref.owner, ref.repo)
  if (!info) {
    add(
      'unresolvable-ref',
      `Repository \`${repoName}\` was not found. If it is private, give the auditor a token that can read it.`,
    )
    return
  }

  // Situations where "what the author meant" is no longer obvious: never auto-suggest.
  let trustworthyTarget = true
  if (info.fullName.toLowerCase() !== repoName.toLowerCase()) {
    trustworthyTarget = false
    add(
      'renamed-repo',
      `\`${repoName}\` redirects to \`${info.fullName}\`. The old name can be re-registered by anyone ` +
        `(repo-jacking); reference \`${info.fullName}\` directly.`,
    )
  }
  if (info.fork) {
    trustworthyTarget = false
    add('fork-target', `\`${repoName}\` is a fork. Make sure you meant this and not the upstream action.`)
  }
  if (info.archived) {
    add('archived-repo', `\`${repoName}\` is archived and will not receive security fixes.`)
  }

  if (ref.isSha) {
    await auditPinnedSha(site, ref, ctx, add)
    return
  }

  if (ref.isShortSha) {
    add('short-sha', `\`${site.value}\` uses an abbreviated SHA, which can collide. Use the full 40-character SHA.`)
    return
  }

  const resolved = await resolver.resolveRef(ref.owner, ref.repo, ref.ref)
  for (const sha of resolvedShas(resolved)) checkCommit(sha, ref.ref)
  switch (resolved.kind) {
    case 'tag': {
      let fix: Fix | undefined
      if (trustworthyTarget) {
        const tag = (await resolver.bestTagFor(ref.owner, ref.repo, resolved.sha, ref.ref)) ?? ref.ref
        fix = {
          oldLine: site.lineText,
          newLine: rewriteLine(site, `${name}@${resolved.sha}`, tag),
          description: `pin to ${resolved.sha} (${tag})`,
        }
      }
      add(
        'unpinned-ref',
        `\`${site.value}\` references tag \`${ref.ref}\`, which can be moved to point at different code. ` +
          `Pin to the full commit SHA${fix ? `: \`${name}@${resolved.sha}\`` : ''}.`,
        fix,
      )
      return
    }
    case 'branch': {
      let hint = `Its current head is \`${resolved.sha}\``
      const release = await resolver.latestReleaseTag(ref.owner, ref.repo)
      const releaseSha = release && (await resolver.tagCommit(ref.owner, ref.repo, release))
      if (release && releaseSha) hint += `; the latest release \`${release}\` is \`${releaseSha}\``
      add(
        'branch-ref',
        `\`${site.value}\` tracks branch \`${ref.ref}\`, so every push to it runs in your CI. ${hint}. ` +
          'Pick a reviewed commit and pin to its full SHA.',
      )
      return
    }
    case 'ambiguous':
      add(
        'ambiguous-ref',
        `\`${ref.ref}\` is both a tag (\`${resolved.tagSha}\`) and a branch (\`${resolved.branchSha}\`) in ` +
          `\`${repoName}\`; GitHub's choice may not be what you expect. Pin to a full SHA.`,
      )
      return
    case 'missing':
      add('unresolvable-ref', `\`${ref.ref}\` is not a tag or branch of \`${repoName}\`.`)
      return
  }
}

async function auditPinnedSha(
  site: UsesSite,
  ref: RepoRef,
  ctx: AuditContext,
  add: (rule: RuleId, message: string, fix?: Fix) => void,
) {
  const { resolver } = ctx
  const repoName = `${ref.owner}/${ref.repo}`
  const reach = await resolver.reachability(ref.owner, ref.repo, ref.ref)
  if (reach === 'missing') {
    add('unknown-commit', `Commit \`${ref.ref}\` does not exist in \`${repoName}\`.`)
    return
  }
  if (reach === 'imposter') {
    add(
      'imposter-commit',
      `Commit \`${ref.ref}\` is not on any branch or tag of \`${repoName}\`. GitHub serves commits from ` +
        'forks under the parent repo name, so this may be attacker code from a fork. Verify it before trusting it.',
    )
    return
  }

  const commentTag = versionFromComment(site.comment)
  if (!commentTag) return
  const tagSha = await resolver.tagCommit(ref.owner, ref.repo, commentTag)
  if (!tagSha || tagSha === ref.ref) return
  const actual = await resolver.bestTagFor(ref.owner, ref.repo, ref.ref)
  add(
    'comment-drift',
    `Comment says \`${commentTag}\`, but \`${commentTag}\` is \`${tagSha}\`, not \`${ref.ref}\`` +
      `${actual ? ` (which is \`${actual}\`)` : ''}. Misleading version comments hide what actually runs.`,
    actual
      ? {
          oldLine: site.lineText,
          newLine: rewriteLine(site, site.value, actual),
          description: `correct comment to ${actual}`,
        }
      : undefined,
  )
}

function resolvedShas(resolved: RefResolution): string[] {
  switch (resolved.kind) {
    case 'tag':
    case 'branch':
      return [resolved.sha]
    case 'ambiguous':
      return [resolved.tagSha, resolved.branchSha]
    case 'missing':
      return []
  }
}

/** Extracts a version from common pin comments: `# v4.2.2`, `# tag=v4.2.2`, `# pin@v4.2.2`, `# v4.2.2 (2024-01-01)`. */
export function versionFromComment(comment: string | undefined): string | undefined {
  const token = comment?.match(/^(?:tag=|pin@|ratchet:[^@\s]+@)?(\S+)/)?.[1]
  if (!token || FULL_SHA.test(token)) return undefined
  return /^v?\d/.test(token) ? token : undefined
}
