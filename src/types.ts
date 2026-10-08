import type { RuleId } from './config.ts'

export type Severity = 'error' | 'warning'

/** A `uses:` occurrence located in a workflow or action metadata file. */
export interface UsesSite {
  file: string // repo-relative, forward slashes
  line: number // 1-based
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
  /** Ids of the jobs this `uses:` runs in (`''` for an action's `runs.steps`). */
  jobs: string[]
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
