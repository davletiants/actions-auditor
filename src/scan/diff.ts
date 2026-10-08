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
 * Whether an inline review comment can be placed on `file:line`. `touched` maps each PR file to
 * its added lines, or `null` when GitHub omitted the patch (large diffs): then we can't know, so no.
 */
export function isCommentable(touched: Map<string, Set<number> | null>, file: string, line: number): boolean {
  return touched.get(file)?.has(line) ?? false
}
