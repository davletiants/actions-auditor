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

  const pushSite = (node: Scalar, at: [number, number], via: number[], isAliasSite: boolean) => {
    if (typeof node.value !== 'string') return
    const [valueStart, valueEnd] = at
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
      quote: isAliasSite
        ? ''
        : node.type === Scalar.QUOTE_DOUBLE
          ? '"'
          : node.type === Scalar.QUOTE_SINGLE
            ? "'"
            : '',
      comment: commentMatch ? commentMatch[1] : undefined,
      lineText,
      lineStart,
      alsoAt: alsoAt.length ? alsoAt : undefined,
    })
  }

  /** Looks up `key` in a map, following aliases and `<<:` merge keys. Returns the raw value node. */
  const lookup = (mapNode: unknown, key: string, via: number[], depth = 0): [unknown, number[]] | undefined => {
    const [map, mapVia] = deref(mapNode, via)
    if (!isMap(map) || depth > 10) return undefined
    const pair = map.items.find((p) => isScalar(p.key) && p.key.value === key)
    if (pair) return [pair.value, mapVia]
    for (const merge of map.items.filter((p) => isScalar(p.key) && p.key.value === '<<')) {
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
    const [value, valueVia] = hit
    if (isAlias(value)) {
      // `uses: *ref`: report at the alias (that's the line to rewrite), but a change to
      // the anchor's definition also changes what runs here.
      const target = value.resolve(doc)
      if (isScalar(target) && target.range && value.range) {
        pushSite(target, [value.range[0], value.range[1]], [...valueVia, lineOf(target.range[0])], true)
      }
    } else if (isScalar(value) && value.range) {
      pushSite(value, [value.range[0], value.range[1]], valueVia, false)
    }
  }

  const collectSteps = (mapNode: unknown, via: number[]) => {
    const hit = lookup(mapNode, 'steps', via)
    if (!hit) return
    const [steps, stepsVia] = deref(...hit)
    if (!isSeq(steps)) return
    for (const step of steps.items) collectUses(step, stepsVia)
  }

  const [jobs, jobsVia] = deref(root.get('jobs', true), [])
  if (isMap(jobs)) {
    for (const pair of jobs.items) {
      collectUses(pair.value, jobsVia)
      collectSteps(pair.value, jobsVia)
    }
  }

  const runs = lookup(root, 'runs', [])
  if (runs) collectSteps(...runs)

  return { sites: [...sites.values()].sort((a, b) => a.valueStart - b.valueStart), errors }
}
