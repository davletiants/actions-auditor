import { parse } from 'yaml'
import type { Severity } from './types.ts'

export type RuleLevel = Severity | 'off'

export interface Config {
  /** `owner/repo[/path]` globs exempt from the pinning requirement (still checked against deny lists). */
  allow: string[]
  /** `owner/repo[/path]` globs or `owner/repo@sha` entries that always fail. */
  deny: string[]
  severity: Record<RuleId, RuleLevel>
}

export const DEFAULT_SEVERITY = {
  'unpinned-ref': 'error', // @v4 / @v4.1.0 tag reference
  'branch-ref': 'error', // @main / @master branch reference
  'ambiguous-ref': 'error', // ref name exists as both a tag and a branch
  'short-sha': 'error', // @a1b2c3d abbreviated SHA
  'unresolvable-ref': 'error', // repo or ref does not exist / is not accessible
  'unknown-commit': 'error', // pinned SHA does not exist in the repo
  'imposter-commit': 'error', // pinned SHA exists only in the fork network, not upstream
  'comment-drift': 'warning', // `@sha # v1.2.3` comment does not match what v1.2.3 resolves to
  'unpinned-docker': 'error', // docker://image without @sha256 digest
  'fork-target': 'warning', // referenced repo is itself a fork
  'renamed-repo': 'warning', // referenced repo was renamed / transferred (repo-jacking risk)
  'archived-repo': 'warning', // referenced repo is archived, no security fixes will land
  denied: 'error', // matches user deny-list
  compromised: 'error', // matches built-in list of known-malicious commits
  'invalid-uses': 'error', // syntactically unusable `uses:` value
} satisfies Record<string, RuleLevel>

export type RuleId = keyof typeof DEFAULT_SEVERITY

export function parseConfig(text: string | null | undefined): Config {
  const config: Config = { allow: [], deny: [], severity: { ...DEFAULT_SEVERITY } }
  if (!text) return config
  const raw = (parse(text) ?? {}) as Record<string, unknown>
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('config must be a YAML mapping')

  config.allow = stringList(raw.allow, 'allow')
  config.deny = stringList(raw.deny, 'deny')
  if (raw.severity !== undefined) {
    if (typeof raw.severity !== 'object' || raw.severity === null) throw new Error('`severity` must be a mapping')
    for (const [rule, level] of Object.entries(raw.severity)) {
      if (!(rule in DEFAULT_SEVERITY)) throw new Error(`unknown rule in severity: ${rule}`)
      if (level !== 'error' && level !== 'warning' && level !== 'off') {
        throw new Error(`severity for ${rule} must be error | warning | off`)
      }
      config.severity[rule as RuleId] = level
    }
  }
  return config
}

function stringList(value: unknown, field: string): string[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value) || !value.every((v) => typeof v === 'string')) {
    throw new Error(`\`${field}\` must be a list of strings`)
  }
  return value
}

/** Minimal glob: `*` matches within one path segment, `**` across segments. Case-insensitive like GitHub names. */
export function globMatch(pattern: string, value: string): boolean {
  const re = pattern
    .split('**')
    .map((part) =>
      part
        .split('*')
        .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
        .join('[^/]*'),
    )
    .join('.*')
  return new RegExp(`^${re}$`, 'i').test(value)
}
