import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { auditSites, versionFromComment } from '../src/checks/audit.ts'
import { parseConfig } from '../src/config.ts'
import { buildPatch } from '../src/report/format.ts'
import { Resolver } from '../src/resolve/resolver.ts'
import { findUses } from '../src/scan/parse.ts'
import { FakeGitApi, sha, type FakeRepo } from './fake-api.ts'

const CHECKOUT_422 = sha('4')
const CHECKOUT_MAIN = sha('5')
const IMPOSTER = sha('e')

const REPOS: Record<string, FakeRepo> = {
  'actions/checkout': {
    tags: { v4: CHECKOUT_422, '@v4.2.2': CHECKOUT_422, 'v4.2': CHECKOUT_422, 'v4.1.0': sha('3') },
    branches: { main: CHECKOUT_MAIN },
    history: { main: [CHECKOUT_422, sha('3')] },
    orphanCommits: [IMPOSTER],
    latestRelease: 'v4.2.2',
  },
  'weird/repo': { tags: { release: sha('1') }, branches: { release: sha('2') } },
  'someone/checkout-fork': { info: { fork: true }, tags: { v1: sha('6') } },
  'old/name': { info: { fullName: 'new/name' }, tags: { v1: sha('7') } },
  'tj-actions/changed-files': { tags: { v45: '0e58ed8671d6b60d0890c21b07f8835ace038e67' } },
}

async function audit(uses: string[], configYaml = '', api = new FakeGitApi(REPOS)) {
  const text = `jobs:\n  j:\n    steps:\n${uses.map((u) => `      - uses: ${u}`).join('\n')}\n`
  const { sites } = findUses('.github/workflows/ci.yml', text)
  return auditSites(sites, { resolver: new Resolver(api), config: parseConfig(configYaml) })
}

describe('audit', () => {
  it('flags a floating tag and suggests the most specific tag at the same commit', async () => {
    const [f] = await audit(['actions/checkout@v4'])
    assert.partialDeepStrictEqual(f, { rule: 'unpinned-ref', severity: 'error', line: 4 })
    assert.equal(f.fix?.newLine, `      - uses: actions/checkout@${CHECKOUT_422} # v4.2.2`)
  })

  it('dereferences annotated tags', async () => {
    const [f] = await audit(['actions/checkout@v4.2.2'])
    assert.ok(f.fix?.newLine.includes(`@${CHECKOUT_422} # v4.2.2`))
  })

  it('passes a correctly pinned SHA with a matching comment', async () => {
    assert.deepEqual(await audit([`actions/checkout@${CHECKOUT_422} # v4.2.2`]), [])
  })

  it('accepts a SHA that is only reachable through history, not a tag or head', async () => {
    const api = new FakeGitApi({ 'a/b': { branches: { main: sha('1') }, history: { main: [sha('2')] } } })
    assert.deepEqual(await audit([`a/b@${sha('2')}`], '', api), [])
  })

  it('flags branch refs with head and release hints, but no auto-fix', async () => {
    const [f] = await audit(['actions/checkout@main'])
    assert.equal(f.rule, 'branch-ref')
    assert.equal(f.fix, undefined)
    assert.ok(f.message.includes(CHECKOUT_MAIN))
    assert.ok(f.message.includes(`v4.2.2\` is \`${CHECKOUT_422}`))
  })

  it('refuses to guess when a name is both a tag and a branch', async () => {
    const [f] = await audit(['weird/repo@release'])
    assert.equal(f.rule, 'ambiguous-ref')
    assert.equal(f.fix, undefined)
  })

  it('detects imposter commits from the fork network', async () => {
    const [f] = await audit([`actions/checkout@${IMPOSTER}`])
    assert.equal(f.rule, 'imposter-commit')
  })

  it('detects commits that do not exist', async () => {
    const [f] = await audit([`actions/checkout@${sha('9')}`])
    assert.equal(f.rule, 'unknown-commit')
  })

  it('detects version comments that lie, and fixes the comment', async () => {
    const [f] = await audit([`actions/checkout@${CHECKOUT_422} # v4.1.0`])
    assert.partialDeepStrictEqual(f, { rule: 'comment-drift', severity: 'warning' })
    assert.equal(f.fix?.newLine, `      - uses: actions/checkout@${CHECKOUT_422} # v4.2.2`)
  })

  it('warns about forks and renamed repos and withholds suggestions', async () => {
    const fork = await audit(['someone/checkout-fork@v1'])
    assert.deepEqual(
      fork.map((f) => f.rule),
      ['fork-target', 'unpinned-ref'],
    )
    assert.equal(fork[1].fix, undefined)
    const renamed = await audit(['old/name@v1'])
    assert.deepEqual(
      renamed.map((f) => f.rule),
      ['renamed-repo', 'unpinned-ref'],
    )
    assert.equal(renamed[1].fix, undefined)
  })

  it('flags known-compromised commits, including when a tag currently resolves to one', async () => {
    const direct = await audit(['tj-actions/changed-files@0e58ed8671d6b60d0890c21b07f8835ace038e67'])
    assert.ok(direct.some((f) => f.rule === 'compromised'))
    const viaTag = await audit(['tj-actions/changed-files@v45'])
    assert.deepEqual(
      viaTag.map((f) => f.rule),
      ['compromised', 'unpinned-ref'],
    )
  })

  it('handles docker, short SHAs, missing repos and refs', async () => {
    const findings = await audit([
      'docker://alpine:3.20',
      `docker://alpine@sha256:${'0'.repeat(64)}`,
      'actions/checkout@abc1234',
      'nobody/nothing@v1',
      'actions/checkout@v999',
      './local',
    ])
    assert.deepEqual(
      findings.map((f) => f.rule),
      ['unpinned-docker', 'short-sha', 'unresolvable-ref', 'unresolvable-ref'],
    )
  })

  it('respects allow, deny and severity config', async () => {
    assert.deepEqual(await audit(['actions/checkout@v4'], 'allow: ["actions/*"]'), [])
    const denied = await audit([`actions/checkout@${CHECKOUT_422}`], 'deny: ["actions/checkout"]')
    assert.deepEqual(
      denied.map((f) => f.rule),
      ['denied'],
    )
    const warnOnly = await audit(['actions/checkout@v4'], 'severity: { unpinned-ref: warning }')
    assert.equal(warnOnly[0].severity, 'warning')
    assert.deepEqual(await audit(['actions/checkout@v4'], 'severity: { unpinned-ref: off }'), [])
  })

  it('memoizes API lookups across repeated references', async () => {
    const api = new FakeGitApi(REPOS)
    await audit(['actions/checkout@v4'], '', api)
    const single = api.calls
    const api2 = new FakeGitApi(REPOS)
    await audit(Array(5).fill('actions/checkout@v4'), '', api2)
    assert.equal(api2.calls, single)
  })

  it('builds an applicable zero-context patch', async () => {
    const findings = await audit(['actions/checkout@v4', 'actions/checkout@main'])
    assert.equal(
      buildPatch(findings),
      [
        '--- a/.github/workflows/ci.yml',
        '+++ b/.github/workflows/ci.yml',
        '@@ -4,1 +4,1 @@',
        '-      - uses: actions/checkout@v4',
        `+      - uses: actions/checkout@${CHECKOUT_422} # v4.2.2`,
        '',
      ].join('\n'),
    )
  })
})

describe('versionFromComment', () => {
  for (const [comment, expected] of [
    ['v4.2.2', 'v4.2.2'],
    ['tag=v1.0', 'v1.0'],
    ['pin@v2', 'v2'],
    ['4.0.0 (latest)', '4.0.0'],
    ['some note', undefined],
    [undefined, undefined],
  ]) {
    it(`${comment} -> ${expected}`, () => assert.equal(versionFromComment(comment), expected))
  }
})
