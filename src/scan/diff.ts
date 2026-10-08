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
