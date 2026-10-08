import { describe, expect, it } from 'vitest'
import { auditSites, versionFromComment } from '../src/checks/audit.js'
import { parseConfig } from '../src/config.js'
import { buildPatch } from '../src/report/format.js'
import { Resolver } from '../src/resolve/resolver.js'
import { findUses } from '../src/scan/parse.js'
import { FakeGitApi, sha, type FakeRepo } from './fake-api.js'

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
    expect(f).toMatchObject({ rule: 'unpinned-ref', severity: 'error', line: 4 })
    expect(f.fix?.newLine).toBe(`      - uses: actions/checkout@${CHECKOUT_422} # v4.2.2`)
  })

  it('dereferences annotated tags', async () => {
    const [f] = await audit(['actions/checkout@v4.2.2'])
    expect(f.fix?.newLine).toContain(`@${CHECKOUT_422} # v4.2.2`)
  })

  it('passes a correctly pinned SHA with a matching comment', async () => {
    expect(await audit([`actions/checkout@${CHECKOUT_422} # v4.2.2`])).toEqual([])
  })

  it('accepts a SHA that is only reachable through history, not a tag or head', async () => {
    const api = new FakeGitApi({ 'a/b': { branches: { main: sha('1') }, history: { main: [sha('2')] } } })
    expect(await audit([`a/b@${sha('2')}`], '', api)).toEqual([])
  })

  it('flags branch refs with head and release hints, but no auto-fix', async () => {
    const [f] = await audit(['actions/checkout@main'])
    expect(f.rule).toBe('branch-ref')
    expect(f.fix).toBeUndefined()
    expect(f.message).toContain(CHECKOUT_MAIN)
    expect(f.message).toContain(`v4.2.2\` is \`${CHECKOUT_422}`)
  })

  it('refuses to guess when a name is both a tag and a branch', async () => {
    const [f] = await audit(['weird/repo@release'])
    expect(f.rule).toBe('ambiguous-ref')
    expect(f.fix).toBeUndefined()
  })

  it('detects imposter commits from the fork network', async () => {
    const [f] = await audit([`actions/checkout@${IMPOSTER}`])
    expect(f.rule).toBe('imposter-commit')
  })

  it('detects commits that do not exist', async () => {
    const [f] = await audit([`actions/checkout@${sha('9')}`])
    expect(f.rule).toBe('unknown-commit')
  })

  it('detects version comments that lie, and fixes the comment', async () => {
    const [f] = await audit([`actions/checkout@${CHECKOUT_422} # v4.1.0`])
    expect(f).toMatchObject({ rule: 'comment-drift', severity: 'warning' })
    expect(f.fix?.newLine).toBe(`      - uses: actions/checkout@${CHECKOUT_422} # v4.2.2`)
  })

  it('warns about forks and renamed repos and withholds suggestions', async () => {
    const fork = await audit(['someone/checkout-fork@v1'])
    expect(fork.map((f) => f.rule)).toEqual(['fork-target', 'unpinned-ref'])
    expect(fork[1].fix).toBeUndefined()
    const renamed = await audit(['old/name@v1'])
    expect(renamed.map((f) => f.rule)).toEqual(['renamed-repo', 'unpinned-ref'])
    expect(renamed[1].fix).toBeUndefined()
  })

  it('flags known-compromised commits, including when a tag currently resolves to one', async () => {
    const direct = await audit(['tj-actions/changed-files@0e58ed8671d6b60d0890c21b07f8835ace038e67'])
    expect(direct.map((f) => f.rule)).toContain('compromised')
    const viaTag = await audit(['tj-actions/changed-files@v45'])
    expect(viaTag.map((f) => f.rule)).toEqual(['compromised', 'unpinned-ref'])
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
    expect(findings.map((f) => f.rule)).toEqual(['unpinned-docker', 'short-sha', 'unresolvable-ref', 'unresolvable-ref'])
  })

  it('respects allow, deny and severity config', async () => {
    expect(await audit(['actions/checkout@v4'], 'allow: ["actions/*"]')).toEqual([])
    const denied = await audit([`actions/checkout@${CHECKOUT_422}`], 'deny: ["actions/checkout"]')
    expect(denied.map((f) => f.rule)).toEqual(['denied'])
    const warnOnly = await audit(['actions/checkout@v4'], 'severity: { unpinned-ref: warning }')
    expect(warnOnly[0].severity).toBe('warning')
    expect(await audit(['actions/checkout@v4'], 'severity: { unpinned-ref: off }')).toEqual([])
  })

  it('memoizes API lookups across repeated references', async () => {
    const api = new FakeGitApi(REPOS)
    await audit(['actions/checkout@v4'], '', api)
    const single = api.calls
    const api2 = new FakeGitApi(REPOS)
    await audit(Array(5).fill('actions/checkout@v4'), '', api2)
    expect(api2.calls).toBe(single)
  })

  it('builds an applicable zero-context patch', async () => {
    const findings = await audit(['actions/checkout@v4', 'actions/checkout@main'])
    expect(buildPatch(findings)).toBe(
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
  it.each([
    ['v4.2.2', 'v4.2.2'],
    ['tag=v1.0', 'v1.0'],
    ['pin@v2', 'v2'],
    ['4.0.0 (latest)', '4.0.0'],
    ['some note', undefined],
    [undefined, undefined],
  ])('%s -> %s', (comment, expected) => expect(versionFromComment(comment)).toBe(expected))
})
