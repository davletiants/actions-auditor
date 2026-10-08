import { describe, expect, it } from 'vitest'
import { applyLineFixes, rewriteLine } from '../src/checks/fix.js'
import { globMatch, parseConfig } from '../src/config.js'
import { addedLines } from '../src/scan/diff.js'
import { isAuditedPath } from '../src/scan/files.js'
import { findUses } from '../src/scan/parse.js'
import { parseActionRef } from '../src/scan/reference.js'

const WORKFLOW = `name: ci
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: setup
        uses: "actions/setup-node@v4.1.0" # pinned later
      - run: 'echo uses: not-a-step@v1'
      - { uses: 'docker://alpine:3.20', with: { args: echo } }
      - uses: ./local-action
        with:
          uses: ignored/input@v1
  call:
    uses: org/shared/.github/workflows/build.yml@main
`

describe('findUses', () => {
  it('finds step, flow-style and reusable-workflow uses with positions', () => {
    const { sites, errors } = findUses('.github/workflows/ci.yml', WORKFLOW)
    expect(errors).toEqual([])
    expect(sites.map((s) => [s.value, s.line])).toEqual([
      ['actions/checkout@v4', 7],
      ['actions/setup-node@v4.1.0', 9],
      ['docker://alpine:3.20', 11],
      ['./local-action', 12],
      ['org/shared/.github/workflows/build.yml@main', 16],
    ])
    expect(sites[1].quote).toBe('"')
    expect(sites[1].comment).toBe('pinned later')
    expect(sites[2].quote).toBe("'")
  })

  it('finds composite action steps in action.yml', () => {
    const text = 'name: x\nruns:\n  using: composite\n  steps:\n    - uses: actions/cache@v4\r\n'
    expect(findUses('action.yml', text).sites.map((s) => s.value)).toEqual(['actions/cache@v4'])
  })

  it('tolerates non-workflow YAML', () => {
    expect(findUses('a.yml', '- just\n- a list').sites).toEqual([])
    expect(findUses('a.yml', '').sites).toEqual([])
  })
})

describe('rewriteLine', () => {
  const site = (line: string) => findUses('f.yml', `jobs:\n  j:\n    steps:\n${line}\n`).sites[0]

  it('replaces the value and adds a version comment, keeping indentation', () => {
    expect(rewriteLine(site('      - uses: actions/checkout@v4'), 'actions/checkout@abc', 'v4.2.2')).toBe(
      '      - uses: actions/checkout@abc # v4.2.2',
    )
  })
  it('keeps quotes and replaces an existing comment', () => {
    expect(rewriteLine(site('      - uses: "a/b@v1"   # old'), 'a/b@abc', 'v1.0.0')).toBe(
      '      - uses: "a/b@abc" # v1.0.0',
    )
  })
  it('leaves flow-style tails intact', () => {
    expect(rewriteLine(site('      - { uses: a/b@v1, with: { x: 1 } }'), 'a/b@abc', 'v1')).toBe(
      '      - { uses: a/b@abc, with: { x: 1 } } # v1',
    )
  })
  it('applies fixes preserving CRLF', () => {
    expect(applyLineFixes('a\r\nb\r\nc', new Map([[2, 'B']]))).toBe('a\r\nB\r\nc')
  })
})

describe('parseActionRef', () => {
  it.each([
    ['./x', 'local'],
    ['docker://alpine:3', 'docker'],
    ['actions/checkout', 'invalid'],
    ['actions/checkout@${{ env.V }}', 'invalid'],
    ['actions/checkout@v4', 'repo'],
  ])('%s -> %s', (raw, kind) => expect(parseActionRef(raw).kind).toBe(kind))

  it('splits owner/repo/path and recognises SHAs', () => {
    const ref = parseActionRef(`github/codeql-action/init@${'a'.repeat(40)}`)
    expect(ref).toMatchObject({ owner: 'github', repo: 'codeql-action', path: 'init', isSha: true })
    expect(parseActionRef('a/b@abc1234')).toMatchObject({ isSha: false, isShortSha: true })
    expect(parseActionRef(`docker://a@sha256:${'0'.repeat(64)}`)).toMatchObject({ digest: `sha256:${'0'.repeat(64)}` })
  })
})

describe('addedLines', () => {
  it('maps + lines to new-file line numbers', () => {
    const patch = '@@ -1,3 +1,4 @@\n a\n-b\n+B\n+C\n c\n@@ -10,2 +11,2 @@\n x\n+y\n\\ No newline at end of file'
    expect([...addedLines(patch)]).toEqual([2, 3, 12])
  })
})

describe('config', () => {
  it('parses and validates', () => {
    const c = parseConfig('allow: [actions/*]\ndeny: [evil/*]\nseverity:\n  comment-drift: error\n  fork-target: off\n')
    expect(c.allow).toEqual(['actions/*'])
    expect(c.severity['comment-drift']).toBe('error')
    expect(c.severity['fork-target']).toBe('off')
    expect(() => parseConfig('severity: { nope: error }')).toThrow(/unknown rule/)
  })
  it('globs', () => {
    expect(globMatch('actions/*', 'actions/checkout')).toBe(true)
    expect(globMatch('actions/*', 'actions/cache/save')).toBe(false)
    expect(globMatch('actions/**', 'actions/cache/save')).toBe(true)
    expect(globMatch('Actions/Checkout', 'actions/checkout')).toBe(true)
  })
  it('knows which paths are audited', () => {
    expect(isAuditedPath('.github/workflows/ci.yml')).toBe(true)
    expect(isAuditedPath('.github/workflows/nested/ci.yml')).toBe(false)
    expect(isAuditedPath('tools/my-action/action.yaml')).toBe(true)
    expect(isAuditedPath('docs/workflow.yml')).toBe(false)
  })
})
