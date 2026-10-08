import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { rewriteLine } from '../src/checks/fix.ts'
import { globMatch, parseConfig } from '../src/config.ts'
import { addedLines } from '../src/scan/diff.ts'
import { isAuditedPath } from '../src/scan/files.ts'
import { findUses } from '../src/scan/parse.ts'
import { parseActionRef } from '../src/scan/reference.ts'

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
    assert.deepEqual(errors, [])
    assert.deepEqual(
      sites.map((s) => [s.value, s.line]),
      [
        ['actions/checkout@v4', 7],
        ['actions/setup-node@v4.1.0', 9],
        ['docker://alpine:3.20', 11],
        ['./local-action', 12],
        ['org/shared/.github/workflows/build.yml@main', 16],
      ],
    )
    assert.equal(sites[1].quote, '"')
    assert.equal(sites[1].comment, 'pinned later')
    assert.equal(sites[2].quote, "'")
  })

  it('finds composite action steps in action.yml', () => {
    const text = 'name: x\nruns:\n  using: composite\n  steps:\n    - uses: actions/cache@v4\r\n'
    assert.deepEqual(
      findUses('action.yml', text).sites.map((s) => s.value),
      ['actions/cache@v4'],
    )
  })

  it('tolerates non-workflow YAML', () => {
    assert.deepEqual(findUses('a.yml', '- just\n- a list').sites, [])
    assert.deepEqual(findUses('a.yml', '').sites, [])
  })
})

describe('rewriteLine', () => {
  const site = (line: string) => findUses('f.yml', `jobs:\n  j:\n    steps:\n${line}\n`).sites[0]

  it('replaces the value and adds a version comment, keeping indentation', () => {
    assert.equal(
      rewriteLine(site('      - uses: actions/checkout@v4'), 'actions/checkout@abc', 'v4.2.2'),
      '      - uses: actions/checkout@abc # v4.2.2',
    )
  })
  it('keeps quotes and replaces an existing comment', () => {
    assert.equal(rewriteLine(site('      - uses: "a/b@v1"   # old'), 'a/b@abc', 'v1.0.0'), '      - uses: "a/b@abc" # v1.0.0')
  })
  it('leaves flow-style tails intact', () => {
    assert.equal(
      rewriteLine(site('      - { uses: a/b@v1, with: { x: 1 } }'), 'a/b@abc', 'v1'),
      '      - { uses: a/b@abc, with: { x: 1 } } # v1',
    )
  })
})

describe('parseActionRef', () => {
  for (const [raw, kind] of [
    ['./x', 'local'],
    ['docker://alpine:3', 'docker'],
    ['actions/checkout', 'invalid'],
    ['actions/checkout@${{ env.V }}', 'invalid'],
    ['actions/checkout@v4', 'repo'],
  ]) {
    it(`${raw} -> ${kind}`, () => assert.equal(parseActionRef(raw).kind, kind))
  }

  it('splits owner/repo/path and recognises SHAs', () => {
    const ref = parseActionRef(`github/codeql-action/init@${'a'.repeat(40)}`)
    assert.partialDeepStrictEqual(ref, { owner: 'github', repo: 'codeql-action', path: 'init', isSha: true })
    assert.partialDeepStrictEqual(parseActionRef('a/b@abc1234'), { isSha: false, isShortSha: true })
    assert.partialDeepStrictEqual(parseActionRef(`docker://a@sha256:${'0'.repeat(64)}`), {
      digest: `sha256:${'0'.repeat(64)}`,
    })
  })
})

describe('addedLines', () => {
  it('maps + lines to new-file line numbers', () => {
    const patch = '@@ -1,3 +1,4 @@\n a\n-b\n+B\n+C\n c\n@@ -10,2 +11,2 @@\n x\n+y\n\\ No newline at end of file'
    assert.deepEqual([...addedLines(patch)], [2, 3, 12])
  })
})

describe('config', () => {
  it('parses and validates', () => {
    const c = parseConfig('allow: [actions/*]\ndeny: [evil/*]\nseverity:\n  comment-drift: error\n  fork-target: off\n')
    assert.deepEqual(c.allow, ['actions/*'])
    assert.equal(c.severity['comment-drift'], 'error')
    assert.equal(c.severity['fork-target'], 'off')
    assert.throws(() => parseConfig('severity: { nope: error }'), /unknown rule/)
  })
  it('globs', () => {
    assert.equal(globMatch('actions/*', 'actions/checkout'), true)
    assert.equal(globMatch('actions/*', 'actions/cache/save'), false)
    assert.equal(globMatch('actions/**', 'actions/cache/save'), true)
    assert.equal(globMatch('Actions/Checkout', 'actions/checkout'), true)
  })
  it('knows which paths are audited', () => {
    assert.equal(isAuditedPath('.github/workflows/ci.yml'), true)
    assert.equal(isAuditedPath('.github/workflows/nested/ci.yml'), false)
    assert.equal(isAuditedPath('tools/my-action/action.yaml'), true)
    assert.equal(isAuditedPath('docs/workflow.yml'), false)
  })
})
