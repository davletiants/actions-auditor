import { describe, expect, it } from 'vitest'
import { auditSites } from '../src/checks/audit.js'
import { rewriteLine } from '../src/checks/fix.js'
import { parseConfig } from '../src/config.js'
import { postReview } from '../src/report/actions.js'
import type { Octokit } from '../src/resolve/github.js'
import { Resolver } from '../src/resolve/resolver.js'
import { changedSites, isCommentable } from '../src/scan/diff.js'
import { findUses } from '../src/scan/parse.js'
import type { Finding } from '../src/types.js'
import { FakeGitApi, sha } from './fake-api.js'

const COMPROMISED = '0e58ed8671d6b60d0890c21b07f8835ace038e67'

describe('YAML anchors and aliases', () => {
  const text = [
    'x-checkout: &co actions/checkout@v4', // 1
    'x-step: &cache', // 2
    '  uses: actions/cache@v4', // 3
    'x-base: &base', // 4
    '  uses: actions/setup-node@v4', // 5
    'x-steps: &common', // 6
    '  - uses: actions/upload-artifact@v4', // 7
    'jobs:', // 8
    '  a:', // 9
    '    steps:', // 10
    '      - uses: *co', // 11
    '      - *cache', // 12
    '      - <<: *base', // 13
    '        name: merged', // 14
    '  b:', // 15
    '    steps: *common', // 16
    '',
  ].join('\n')

  it('follows scalar aliases, step aliases, merge keys and aliased step lists', () => {
    const { sites, errors } = findUses('.github/workflows/ci.yml', text)
    expect(errors).toEqual([])
    expect(sites.map((s) => [s.value, s.line, s.alsoAt])).toEqual([
      ['actions/checkout@v4', 1, [11]],
      ['actions/cache@v4', 3, [12]],
      ['actions/setup-node@v4', 5, [13]],
      ['actions/upload-artifact@v4', 7, [16]],
    ])
  })

  it('fixes `uses: *alias` at the anchor, so the alias keeps pointing at it', () => {
    const site = findUses('f.yml', text).sites.find((s) => s.value === 'actions/checkout@v4')!
    expect(rewriteLine(site, `actions/checkout@${sha('4')}`, 'v4.2.2')).toBe(
      `x-checkout: &co actions/checkout@${sha('4')} # v4.2.2`,
    )
  })

  it('follows alias keys', () => {
    const usesKey = 'x: &k uses\njobs:\n  a:\n    steps:\n      - *k : evil/x@main\n'
    expect(findUses('f.yml', usesKey).sites.map((s) => s.value)).toEqual(['evil/x@main'])
    const stepsKey = 'x: &s steps\njobs:\n  a:\n    *s :\n      - uses: evil/x@main\n'
    expect(findUses('f.yml', stepsKey).sites.map((s) => s.value)).toEqual(['evil/x@main'])
  })

  it('follows a root merge key that supplies `jobs`', () => {
    const merged = 'x: &w\n  jobs:\n    a: {steps: [{uses: evil/x@main}]}\n<<: *w\n'
    expect(findUses('f.yml', merged).sites.map((s) => s.value)).toEqual(['evil/x@main'])
  })

  it('reports a site reached by the same anchor from two places only once', () => {
    const twice = 'x: &s\n  uses: a/b@v1\njobs:\n  a:\n    steps: [*s]\n  b:\n    steps: [*s]\n'
    const { sites } = findUses('f.yml', twice)
    expect(sites).toHaveLength(1)
    expect(sites[0].alsoAt).toEqual([5, 7])
  })
})

describe('changed mode', () => {
  const pinned = `good/x@${sha('a')}`
  const changed = (base: string, head: string, lines: Set<number> | null) =>
    changedSites(findUses('f.yml', head).sites, lines, new Set(findUses('f.yml', base).sites.map((s) => s.value))).map(
      (s) => s.value,
    )

  it('checks a site an anchor swap re-points, though none of its lines changed', () => {
    const base = `x-a: &a\n  uses: ${pinned}\nx-b: &b\n  uses: evil/x@main\njobs:\n  j:\n    steps:\n      - *a\n`
    const head = base.replace('&a', '&tmp').replace('&b', '&a').replace('&tmp', '&b')
    expect(changed(base, head, new Set([1, 3]))).toEqual(['evil/x@main'])
  })

  it('checks a site that deleting an anchor redefinition re-points', () => {
    const tail = 'jobs:\n  j:\n    steps:\n      - *a\n'
    const base = `x1: &a\n  uses: evil/x@main\nx2: &a\n  uses: ${pinned}\n${tail}`
    const head = `x1: &a\n  uses: evil/x@main\n${tail}`
    expect(changed(base, head, new Set())).toEqual(['evil/x@main'])
  })

  it('checks a new alias to an existing site, but not the untouched site alone', () => {
    const base = 'x: &s\n  uses: a/b@v1\njobs:\n  a:\n    steps: [*s]\n'
    const head = `${base}  b:\n    steps: [*s]\n`
    expect(changed(base, head, new Set([6, 7]))).toEqual(['a/b@v1'])
    expect(changed(base, head, new Set())).toEqual([])
  })

  it('checks the whole file when GitHub omitted the patch', () => {
    const text = 'jobs:\n  j:\n    steps:\n      - uses: a/b@v1\n'
    expect(changed(text, text, null)).toEqual(['a/b@v1'])
  })
})

describe('commentable lines', () => {
  it('never comments on files whose patch GitHub omitted', () => {
    const touched = new Map<string, Set<number> | null>([
      ['small.yml', new Set([3])],
      ['huge.yml', null],
    ])
    expect(isCommentable(touched, 'small.yml', 3)).toBe(true)
    expect(isCommentable(touched, 'small.yml', 4)).toBe(false)
    expect(isCommentable(touched, 'huge.yml', 3)).toBe(false)
    expect(isCommentable(touched, 'other.yml', 3)).toBe(false)
  })

  it('reports a 422 from the review API instead of throwing', async () => {
    const octokit = {
      paginate: async () => [],
      rest: {
        pulls: {
          listReviewComments: {},
          createReview: async () => {
            throw Object.assign(new Error('Unprocessable'), { status: 422 })
          },
        },
      },
    } as unknown as Octokit
    const finding: Finding = { rule: 'unpinned-ref', severity: 'error', file: 'f.yml', line: 1, uses: 'a/b@v1', message: 'm' }
    expect(await postReview(octokit, { owner: 'o', repo: 'r', pullNumber: 1, headSha: sha('a') }, [finding])).toBe(
      'rejected',
    )
  })
})

describe('allow / deny cannot be used to dodge commit checks', () => {
  const api = () =>
    new FakeGitApi({
      'tj-actions/changed-files': { tags: { v45: COMPROMISED }, branches: { main: COMPROMISED } },
      'acme/tool': { tags: { v1: sha('b'), v2: sha('c') } },
    })
  const audit = async (uses: string, configYaml: string) => {
    const { sites } = findUses('ci.yml', `jobs:\n  j:\n    steps:\n      - uses: ${uses}\n`)
    return auditSites(sites, { resolver: new Resolver(api()), config: parseConfig(configYaml) })
  }

  it('still flags a compromised commit reached through a tag on an allowed repo', async () => {
    const findings = await audit('tj-actions/changed-files@v45', 'allow: ["tj-actions/*"]')
    expect(findings.map((f) => f.rule)).toEqual(['compromised'])
  })

  it('still flags a compromised commit reached through a branch', async () => {
    const findings = await audit('tj-actions/changed-files@main', '')
    expect(findings.map((f) => f.rule)).toEqual(['compromised', 'branch-ref'])
  })

  it('matches `repo@sha` deny entries against the commit a tag resolves to', async () => {
    const deny = `deny: ["acme/tool@${sha('b')}"]`
    expect((await audit('acme/tool@v1', deny)).map((f) => f.rule)).toEqual(['denied', 'unpinned-ref'])
    expect((await audit('acme/tool@v2', deny)).map((f) => f.rule)).toEqual(['unpinned-ref'])
  })

  it('applies `repo@sha` deny entries even when the repo is allow-listed', async () => {
    const findings = await audit('acme/tool@v1', `allow: ["acme/*"]\ndeny: ["acme/tool@${sha('b')}"]`)
    expect(findings.map((f) => f.rule)).toEqual(['denied'])
  })

  it('still matches literal `repo@tag` deny entries, once', async () => {
    const findings = await audit('acme/tool@v1', 'deny: ["acme/tool@v1"]')
    expect(findings.filter((f) => f.rule === 'denied')).toHaveLength(1)
  })

  it('treats `repo@` with an empty ref as denying the whole action', async () => {
    expect((await audit('acme/tool@v2', 'deny: ["acme/tool@"]')).map((f) => f.rule)).toEqual(['denied', 'unpinned-ref'])
  })

  it('makes no API calls for an allow-listed repo no deny or compromised entry can match', async () => {
    const fake = api()
    const { sites } = findUses('ci.yml', 'jobs:\n  j:\n    steps:\n      - uses: acme/tool@v1\n')
    const findings = await auditSites(sites, { resolver: new Resolver(fake), config: parseConfig('allow: ["acme/*"]') })
    expect(findings).toEqual([])
    expect(fake.calls).toBe(0)
  })
})

describe('fixes', () => {
  const api = () =>
    new FakeGitApi({
      'actions/checkout': {
        tags: { 'v4.2.2': sha('4'), 'v4.1.0': sha('3') },
        branches: { main: sha('5') },
        history: { main: [sha('4'), sha('3')] },
      },
    })
  const audit = async (text: string) =>
    auditSites(findUses('ci.yml', text).sites, { resolver: new Resolver(api()), config: parseConfig('') })

  it('checks the version comment on an anchor and corrects it there', async () => {
    const [f] = await audit(`x: &co actions/checkout@${sha('4')} # v4.1.0\njobs:\n  j:\n    steps:\n      - uses: *co\n`)
    expect(f).toMatchObject({ rule: 'comment-drift', line: 1 })
    expect(f.fix?.newLine).toBe(`x: &co actions/checkout@${sha('4')} # v4.2.2`)
  })

  it('does not offer a one-line fix for a value spanning several lines', async () => {
    const [f] = await audit('jobs:\n  j:\n    steps:\n      - uses: >-\n          actions/checkout@v4.2.2\n')
    expect(f.rule).toBe('unpinned-ref')
    expect(f.fix).toBeUndefined()
  })
})
