import { isAlias, isMap, isScalar, isSeq, LineCounter, parseDocument, Scalar } from 'yaml'
import type { UsesSite } from '../types.js'

export interface ParseResult {
  sites: UsesSite[]
  errors: string[]
}

/**
 * Finds every `uses:` that GitHub would actually execute:
 *   workflows: jobs.<id>.uses (reusable workflow) and jobs.<id>.steps[*].uses
 *   action.yml: runs.steps[*].uses (composite actions)
 * YAML anchors/aliases and merge keys are followed, so `uses: *ref` or `- *step` can't
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

  const pushSite = (node: Scalar, via: number[]) => {
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
      return
    }
    sites.set(valueStart, {
      file,
      line: pos.line,
      column: pos.col,
      value: node.value.trim(),
      valueStart,
      valueEnd,
      quote: node.type === Scalar.QUOTE_DOUBLE ? '"' : node.type === Scalar.QUOTE_SINGLE ? "'" : '',
      comment: commentMatch ? commentMatch[1] : undefined,
      lineText,
      lineStart,
      multiline: text.slice(valueStart, valueEnd).includes('\n') || undefined,
      alsoAt: alsoAt.length ? alsoAt : undefined,
    })
  }

  /** Looks up `key` in a map, following aliases and `<<:` merge keys. Returns the raw value node. */
  const lookup = (mapNode: unknown, key: string, via: number[], depth = 0): [unknown, number[]] | undefined => {
    const [map, mapVia] = deref(mapNode, via)
    if (!isMap(map) || depth > 10) return undefined
    const pair = map.items.find((p) => keyName(p.key) === key)
    if (pair) return [pair.value, mapVia]
    for (const merge of map.items.filter((p) => keyName(p.key) === '<<')) {
      for (const source of isSeq(merge.value) ? merge.value.items : [merge.value]) {
        const hit = lookup(source, key, mapVia, depth + 1)
        if (hit) return hit
      }
    }
    return undefined
  }

  const collectUses = (mapNode: unknown, via: number[]) => {
    const hit = lookup(mapNode, 'uses', via)
    if (!hit) return
    // `uses: *ref` is reported at the anchored value: fixing it there fixes every alias and keeps them
    // pointing at the anchor. The alias's line is recorded too, since adding it changes what runs.
    const [value, valueVia] = deref(...hit)
    if (isScalar(value)) pushSite(value, valueVia)
  }

  const collectSteps = (mapNode: unknown, via: number[]) => {
    const hit = lookup(mapNode, 'steps', via)
    if (!hit) return
    const [steps, stepsVia] = deref(...hit)
    if (!isSeq(steps)) return
    for (const step of steps.items) collectUses(step, stepsVia)
  }

  const jobsHit = lookup(root, 'jobs', [])
  if (jobsHit) {
    const [jobs, jobsVia] = deref(...jobsHit)
    if (isMap(jobs)) {
      for (const pair of jobs.items) {
        collectUses(pair.value, jobsVia)
        collectSteps(pair.value, jobsVia)
      }
    }
  }

  const runs = lookup(root, 'runs', [])
  if (runs) collectSteps(...runs)

  return { sites: [...sites.values()].sort((a, b) => a.valueStart - b.valueStart), errors }
}
