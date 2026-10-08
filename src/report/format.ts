import type { Finding } from '../types.ts'

/**
 * A `git apply --unidiff-zero` compatible patch containing every available fix.
 * Used where we can't post suggestions (fork PRs) and for full scans.
 */
export function buildPatch(findings: Finding[]): string {
  const byFile = new Map<string, Map<number, Finding>>()
  for (const f of findings) {
    if (!f.fix) continue
    const lines = byFile.get(f.file) ?? new Map<number, Finding>()
    if (!lines.has(f.line)) lines.set(f.line, f)
    byFile.set(f.file, lines)
  }
  const out: string[] = []
  for (const [file, lines] of [...byFile].sort(([a], [b]) => a.localeCompare(b))) {
    out.push(`--- a/${file}`, `+++ b/${file}`)
    for (const [line, f] of [...lines].sort(([a], [b]) => a - b)) {
      out.push(`@@ -${line},1 +${line},1 @@`, `-${f.fix!.oldLine}`, `+${f.fix!.newLine}`)
    }
  }
  return out.length ? `${out.join('\n')}\n` : ''
}

export function countBySeverity(findings: Finding[]) {
  return {
    errors: findings.filter((f) => f.severity === 'error').length,
    warnings: findings.filter((f) => f.severity === 'warning').length,
  }
}

export function stripTicks(s: string): string {
  return s.replace(/`/g, '')
}
