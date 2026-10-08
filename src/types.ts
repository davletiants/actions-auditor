export type Severity = 'error' | 'warning'

export type RuleId =
  | 'unpinned-ref' // @v4 / @v4.1.0 tag reference
  | 'branch-ref' // @main / @master branch reference
  | 'ambiguous-ref' // ref name exists as both a tag and a branch
  | 'short-sha' // @a1b2c3d abbreviated SHA
  | 'unresolvable-ref' // repo or ref does not exist / is not accessible
  | 'unknown-commit' // pinned SHA does not exist in the repo
  | 'imposter-commit' // pinned SHA exists only in the fork network, not upstream
  | 'comment-drift' // `@sha # v1.2.3` comment does not match what v1.2.3 resolves to
  | 'unpinned-docker' // docker://image without @sha256 digest
  | 'fork-target' // referenced repo is itself a fork
  | 'renamed-repo' // referenced repo was renamed / transferred (repo-jacking risk)
  | 'archived-repo' // referenced repo is archived, no security fixes will land
  | 'denied' // matches user deny-list
  | 'compromised' // matches built-in list of known-malicious commits
  | 'invalid-uses' // syntactically unusable `uses:` value

/** A `uses:` occurrence located in a workflow or action metadata file. */
export interface UsesSite {
  file: string // repo-relative, forward slashes
  line: number // 1-based
  column: number // 1-based
  value: string // the uses value, unquoted
  /** Offsets into the file text spanning the scalar (including quotes, if any). */
  valueStart: number
  valueEnd: number
  quote: '' | '"' | "'"
  /** Trailing `# ...` comment text on the same line, without the leading `#`. */
  comment?: string
  /** Full text of the line, without the line terminator. */
  lineText: string
  /** Offset of the start of the line in the file text. */
  lineStart: number
  /** The value spans several lines (e.g. a `>-` block scalar), so it can't be rewritten in place. */
  multiline?: boolean
  /**
   * Other lines (YAML anchors / aliases) that also determine what this `uses:` runs.
   * In `changed` mode, a PR touching any of them gets this site checked.
   */
  alsoAt?: number[]
}

export interface Fix {
  /** The original line text. */
  oldLine: string
  /** The fully rewritten line text (used for review suggestions and patches). */
  newLine: string
  /** Short description for humans, e.g. "pin to <sha> (v4.2.2)". */
  description: string
}

export interface Finding {
  rule: RuleId
  severity: Severity
  file: string
  line: number
  uses: string
  message: string
  fix?: Fix
}
