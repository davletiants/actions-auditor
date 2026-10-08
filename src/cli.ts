#!/usr/bin/env node
import { getOctokit } from '@actions/github'
import { execFileSync } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { auditSites } from './checks/audit.js'
import { applyLineFixes } from './checks/fix.js'
import { parseConfig } from './config.js'
import { OctokitGitApi } from './resolve/github.js'
import { Resolver } from './resolve/resolver.js'
import { buildPatch, countBySeverity, formatText } from './report/format.js'
import { findAuditedFiles } from './scan/files.js'
import { findUses } from './scan/parse.js'
import type { Finding, UsesSite } from './types.js'

const USAGE = `Usage: actions-auditor <scan|fix|patch> [dir] [--config <path>] [--json]

  scan    Report every unpinned / suspicious \`uses:\` in workflows and action.yml files
  fix     Rewrite tag references to full commit SHAs in place (keeps a "# vX.Y.Z" comment)
  patch   Print the fixes as a unified diff instead of writing them

Auth: GITHUB_TOKEN / GH_TOKEN, or the GitHub CLI's login (\`gh auth token\`).`

async function main(argv: string[]) {
  const args: string[] = []
  let configFlag: string | undefined
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--config') configFlag = argv[++i]
    else if (!argv[i].startsWith('--')) args.push(argv[i])
  }
  const [command, dirArg] = args
  if (!command || !['scan', 'fix', 'patch'].includes(command) || argv.includes('--help')) {
    console.log(USAGE)
    return command ? 0 : 2
  }
  const root = path.resolve(dirArg ?? '.')
  const configPath = path.resolve(root, configFlag ?? '.github/actions-auditor.yml')
  const config = parseConfig(await readFile(configPath, 'utf8').catch(() => null))

  const texts = new Map<string, string>()
  const sites: UsesSite[] = []
  for (const file of await findAuditedFiles(root)) {
    const text = await readFile(path.join(root, file), 'utf8')
    texts.set(file, text)
    const { sites: found, errors } = findUses(file, text)
    for (const e of errors) console.error(`warning: ${file}: ${e}`)
    sites.push(...found)
  }

  const resolver = new Resolver(new OctokitGitApi(getOctokit(token())))
  const findings = await auditSites(sites, { resolver, config })

  if (command === 'patch') {
    process.stdout.write(buildPatch(findings))
    return 0
  }

  if (command === 'fix') {
    const fixed = await applyFixes(root, texts, findings)
    console.log(`Rewrote ${fixed} line(s).`)
    const remaining = findings.filter((f) => !f.fix)
    if (remaining.length) {
      console.log(`\n${remaining.length} finding(s) need a manual decision:\n`)
      console.log(formatText(remaining))
    }
    return countBySeverity(remaining).errors ? 1 : 0
  }

  if (argv.includes('--json')) console.log(JSON.stringify(findings, null, 2))
  else {
    console.log(findings.length ? formatText(findings) : 'All `uses:` references are pinned to full commit SHAs.')
    const { errors, warnings } = countBySeverity(findings)
    console.log(`\n${sites.length} reference(s) checked: ${errors} error(s), ${warnings} warning(s).`)
    if (findings.some((f) => f.fix)) console.log('Run `actions-auditor fix` to apply the suggested pins.')
  }
  return countBySeverity(findings).errors ? 1 : 0
}

async function applyFixes(root: string, texts: Map<string, string>, findings: Finding[]): Promise<number> {
  const perFile = new Map<string, Map<number, string>>()
  for (const f of findings) {
    if (!f.fix) continue
    const lines = perFile.get(f.file) ?? new Map<number, string>()
    if (!lines.has(f.line)) lines.set(f.line, f.fix.newLine)
    perFile.set(f.file, lines)
  }
  let count = 0
  for (const [file, lines] of perFile) {
    await writeFile(path.join(root, file), applyLineFixes(texts.get(file)!, lines))
    count += lines.size
  }
  return count
}

function token(): string {
  const env = process.env.GITHUB_TOKEN || process.env.GH_TOKEN
  if (env) return env
  try {
    return execFileSync('gh', ['auth', 'token'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    throw new Error('No GitHub token: set GITHUB_TOKEN or log in with `gh auth login`.')
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : err)
    process.exit(2)
  },
)
