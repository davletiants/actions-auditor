import { isMap, isScalar, isSeq, LineCounter, parseDocument, Scalar, YAMLMap } from 'yaml'
import type { UsesSite } from '../types.js'

export interface ParseResult {
  sites: UsesSite[]
  errors: string[]
}

/**
 * Finds every `uses:` that GitHub would actually execute:
 *   workflows: jobs.<id>.uses (reusable workflow) and jobs.<id>.steps[*].uses
 *   action.yml: runs.steps[*].uses (composite actions)
 * Positions are kept so findings can be annotated and fixed in place without
 * re-serializing (and reformatting) the user's YAML.
 */
export function findUses(file: string, text: string): ParseResult {
  const lineCounter = new LineCounter()
  const doc = parseDocument(text, { lineCounter, keepSourceTokens: false })
  const errors = doc.errors.map((e) => e.message)
  const sites: UsesSite[] = []
  const root = doc.contents
  if (!isMap(root)) return { sites, errors }

  const collectSteps = (steps: unknown) => {
    if (!isSeq(steps)) return
    for (const step of steps.items) {
      if (isMap(step)) pushSite(getScalar(step, 'uses'))
    }
  }

  const pushSite = (node: Scalar | undefined) => {
    if (!node || typeof node.value !== 'string' || !node.range) return
    const [valueStart, valueEnd] = node.range
    const lineStart = text.lastIndexOf('\n', valueStart - 1) + 1
    let lineEnd = text.indexOf('\n', valueStart)
    if (lineEnd === -1) lineEnd = text.length
    const lineText = text.slice(lineStart, lineEnd).replace(/\r$/, '')
    const rest = text.slice(valueEnd, lineEnd).replace(/\r$/, '')
    const commentMatch = rest.match(/(?:^|\s)#\s*(.*?)\s*$/)
    const pos = lineCounter.linePos(valueStart)
    sites.push({
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
    })
  }

  const jobs = root.get('jobs', true)
  if (isMap(jobs)) {
    for (const pair of jobs.items) {
      if (!isMap(pair.value)) continue
      pushSite(getScalar(pair.value, 'uses'))
      collectSteps(pair.value.get('steps', true))
    }
  }

  const runs = root.get('runs', true)
  if (isMap(runs)) collectSteps(runs.get('steps', true))

  return { sites, errors }
}

function getScalar(map: YAMLMap, key: string): Scalar | undefined {
  const node = map.get(key, true)
  return isScalar(node) ? node : undefined
}
