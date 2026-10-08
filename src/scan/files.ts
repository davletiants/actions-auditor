import { readdir } from 'node:fs/promises'
import path from 'node:path'

const SKIP_DIRS = new Set(['.git', 'node_modules'])

/** Workflow files and action metadata files: the only places `uses:` is executed. */
export function isAuditedPath(file: string): boolean {
  const p = file.replace(/\\/g, '/')
  return /^\.github\/workflows\/[^/]+\.ya?ml$/.test(p) || /(^|\/)action\.ya?ml$/.test(p)
}

/** Repo-relative (forward-slash) paths of every audited file under `root`. */
export async function findAuditedFiles(root: string): Promise<string[]> {
  const out: string[] = []
  const walk = async (dir: string) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) await walk(path.join(dir, entry.name))
        continue
      }
      const rel = path.relative(root, path.join(dir, entry.name)).replace(/\\/g, '/')
      if (entry.isFile() && isAuditedPath(rel)) out.push(rel)
    }
  }
  await walk(root)
  return out.sort()
}
