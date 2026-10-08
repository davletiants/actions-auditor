import type { UsesSite } from '../types.js'

/**
 * Rewrites the `uses:` value on its line, keeping indentation, quoting and any flow-style
 * trailing content intact. `commentTag` replaces (or adds) the trailing `# tag` comment.
 */
export function rewriteLine(site: UsesSite, newValue: string, commentTag?: string): string {
  const before = site.lineText.slice(0, site.valueStart - site.lineStart)
  const after = site.lineText.slice(site.valueEnd - site.lineStart)
  const scalar = `${site.quote}${newValue}${site.quote}`

  if (/^\s*(#.*)?$/.test(after)) {
    // Block style: the rest of the line is only whitespace and/or a comment.
    return commentTag ? `${before}${scalar} # ${commentTag}` : `${before}${scalar}${after}`
  }
  // Flow style (`- { uses: x@v1, with: ... }`): leave the rest alone, append a comment if none.
  const tail = commentTag && !/\s#/.test(after) ? `${after} # ${commentTag}` : after
  return `${before}${scalar}${tail}`
}

/** Applies line rewrites to a whole file's text. Lines are 1-based. */
export function applyLineFixes(text: string, fixes: Map<number, string>): string {
  if (!fixes.size) return text
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const lines = text.split(/\r?\n/)
  for (const [line, newLine] of fixes) lines[line - 1] = newLine
  return lines.join(eol)
}
