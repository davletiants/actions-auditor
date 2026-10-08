/** Workflow files and action metadata files: the only places `uses:` is executed. */
export function isAuditedPath(file: string): boolean {
  const p = file.replace(/\\/g, '/')
  return /^\.github\/workflows\/[^/]+\.ya?ml$/.test(p) || /(^|\/)action\.ya?ml$/.test(p)
}
