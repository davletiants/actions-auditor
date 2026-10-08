import type { UsesSite } from '../types.js'

/**
 * Line numbers (new-file side, 1-based) added or modified by a unified diff patch,
 * as returned in the `patch` field of `GET /repos/{o}/{r}/pulls/{n}/files`.
 */
export function addedLines(patch: string): Set<number> {
  const added = new Set<number>()
  let line = 0
  for (const text of patch.split('\n')) {
    const hunk = text.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/)
    if (hunk) {
      line = Number(hunk[1])
      continue
    }
    if (!line) continue
    if (text.startsWith('+')) added.add(line++)
    else if (text.startsWith('-') || text.startsWith('\\')) continue
    else line++
  }
  return added
}

/**
 * Whether `line` is among a file's added lines. `lines` is `undefined` for files the PR doesn't touch,
 * and `null` when GitHub omitted the patch (large diffs): then we can't know, and `ifUnknown` decides.
 */
export function lineTouched(lines: Set<number> | null | undefined, line: number, ifUnknown: boolean): boolean {
  return lines === null ? ifUnknown : (lines?.has(line) ?? false)
}

/** Whether an inline review comment can be placed on `file:line`. Never in a file whose patch was omitted. */
export function isCommentable(touched: Map<string, Set<number> | null>, file: string, line: number): boolean {
  return lineTouched(touched.get(file), line, false)
}

/**
 * The sites a PR may have changed: those on an added line or reached through one (`alsoAt`, e.g. a new
 * alias), plus any that now run a value in a job where the base version of the file (`baseSites`) didn't.
 * The latter catches edits that re-point an alias without touching its lines, like renaming anchors or
 * deleting a redefinition. A file whose patch was omitted is checked in full.
 */
export function changedSites(found: UsesSite[], lines: Set<number> | null | undefined, baseSites: UsesSite[]): UsesSite[] {
  const ran = new Set(baseSites.flatMap((s) => s.jobs.map((job) => `${job}\0${s.value}`)))
  return found.filter(
    (s) =>
      s.jobs.some((job) => !ran.has(`${job}\0${s.value}`)) ||
      [s.line, ...(s.alsoAt ?? [])].some((l) => lineTouched(lines, l, true)),
  )
}
