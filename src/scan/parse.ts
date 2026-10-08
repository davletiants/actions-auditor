import { isAlias, isMap, isScalar, isSeq, LineCounter, parseDocument, Scalar } from 'yaml'
import type { UsesSite } from '../types.ts'

export interface ParseResult {
  sites: UsesSite[]
  errors: string[]
}

/**
 * Finds every `uses:` that GitHub would actually execute:
 *   workflows: jobs.<id>.uses (reusable workflow) and jobs.<id>.steps[*].uses
 *   action.yml: runs.steps[*].uses (composite actions)
 * YAML anchors and aliases are followed (GitHub rejects `<<:` merge keys), so `uses: *ref` or `- *step` can't
 * slip past. Positions are kept so findings can be annotated and fixed in place without
 * re-serializing (and reformatting) the user's YAML.
 */
export function findUses(file: string, text: string): ParseResult {
  const lineCounter = new LineCounter()
  const doc = parseDocument(text, { lineCounter, keepSourceTokens: false })
  const errors = doc.errors.map((e) => e.message)
  const sites = new Map<number, UsesSite>()
  const root = doc.contents
  if (!isMap(root)) return { sites: [], errors }

  const lineOf = (offset: number) => lineCounter.linePos(offset).line

  /** Follows an alias, recording the alias's line: editing it changes what runs. */
  const deref = (node: unknown, via: number[]): [unknown, number[]] => {
    if (!isAlias(node)) return [node, via]
    return [node.resolve(doc), node.range ? [...via, lineOf(node.range[0])] : via]
  }

  /** A map key's name, following an alias key (`*k: value` with `&k uses`). */
  const keyName = (key: unknown) => {
    const [k] = deref(key, [])
    return isScalar(k) ? k.value : undefined
  }

  const pushSite = (node: Scalar, via: number[], job: string) => {
    if (typeof node.value !== 'string' || !node.range) return
    const [valueStart, valueEnd] = node.range
    const lineStart = text.lastIndexOf('\n', valueStart - 1) + 1
    let lineEnd = text.indexOf('\n', valueStart)
    if (lineEnd === -1) lineEnd = text.length
    const lineText = text.slice(lineStart, lineEnd).replace(/\r$/, '')
    const rest = text.slice(valueEnd, lineEnd).replace(/\r$/, '')
    const commentMatch = rest.match(/(?:^|\s)#\s*(.*?)\s*$/)
    const pos = lineCounter.linePos(valueStart)
    const alsoAt = via.filter((l) => l !== pos.line)

    const existing = sites.get(valueStart)
    if (existing) {
      existing.alsoAt = [...new Set([...(existing.alsoAt ?? []), ...alsoAt])]
      if (!existing.jobs.includes(job)) existing.jobs.push(job)
      return
    }
    sites.set(valueStart, {
      file,
      line: pos.line,
      value: node.value.trim(),
      valueStart,
      valueEnd,
      quote: node.type === Scalar.QUOTE_DOUBLE ? '"' : node.type === Scalar.QUOTE_SINGLE ? "'" : '',
      comment: commentMatch ? commentMatch[1] : undefined,
      lineText,
      lineStart,
      multiline: text.slice(valueStart, valueEnd).includes('\n') || undefined,
      alsoAt: alsoAt.length ? alsoAt : undefined,
      jobs: [job],
    })
  }

  /** A map's `[key, value, via]` entries, following an aliased map. Values are raw nodes. */
  const entries = (mapNode: unknown, via: number[]): Array<[unknown, unknown, number[]]> => {
    const [map, mapVia] = deref(mapNode, via)
    return isMap(map) ? map.items.map((p): [unknown, unknown, number[]] => [keyName(p.key), p.value, mapVia]) : []
  }

  /** Looks up `key` in a map, following aliases. Returns the raw value node. */
  const lookup = (mapNode: unknown, key: string, via: number[]): [unknown, number[]] | undefined => {
    const hit = entries(mapNode, via).find(([k]) => k === key)
    return hit && [hit[1], hit[2]]
  }

  const collectUses = (mapNode: unknown, via: number[], job: string) => {
    const hit = lookup(mapNode, 'uses', via)
    if (!hit) return
    // `uses: *ref` is reported at the anchored value: fixing it there fixes every alias and keeps them
    // pointing at the anchor. The alias's line is recorded too, since adding it changes what runs.
    const [value, valueVia] = deref(...hit)
    if (isScalar(value)) pushSite(value, valueVia, job)
  }

  const collectSteps = (mapNode: unknown, via: number[], job: string) => {
    const hit = lookup(mapNode, 'steps', via)
    if (!hit) return
    const [steps, stepsVia] = deref(...hit)
    if (!isSeq(steps)) return
    for (const step of steps.items) collectUses(step, stepsVia, job)
  }

  const jobs = lookup(root, 'jobs', [])
  for (const [id, job, jobVia] of jobs ? entries(...jobs) : []) {
    collectUses(job, jobVia, String(id))
    collectSteps(job, jobVia, String(id))
  }

  const runs = lookup(root, 'runs', [])
  if (runs) collectSteps(...runs, '')

  return { sites: [...sites.values()].sort((a, b) => a.valueStart - b.valueStart), errors }
}
