import { parse } from 'yaml'
import type { RuleId, Severity } from './types.js'

export type RuleLevel = Severity | 'off'

export interface Config {
  /** `owner/repo[/path]` globs exempt from the pinning requirement (still checked against deny lists). */
  allow: string[]
  /** `owner/repo[/path]` globs or `owner/repo@sha` entries that always fail. */
  deny: string[]
  severity: Record<RuleId, RuleLevel>
}

export const DEFAULT_SEVERITY: Record<RuleId, RuleLevel> = {
  'unpinned-ref': 'error',
  'branch-ref': 'error',
  'ambiguous-ref': 'error',
  'short-sha': 'error',
  'unresolvable-ref': 'error',
  'unknown-commit': 'error',
  'imposter-commit': 'error',
  'comment-drift': 'warning',
  'unpinned-docker': 'error',
  'fork-target': 'warning',
  'renamed-repo': 'warning',
  'archived-repo': 'warning',
  denied: 'error',
  compromised: 'error',
  'invalid-uses': 'error',
}

export function defaultConfig(): Config {
  return { allow: [], deny: [], severity: { ...DEFAULT_SEVERITY } }
}

export function parseConfig(text: string | null | undefined): Config {
  const config = defaultConfig()
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
