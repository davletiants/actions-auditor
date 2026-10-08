import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { auditSites } from '../src/checks/audit.ts'
import { rewriteLine } from '../src/checks/fix.ts'
import { parseConfig } from '../src/config.ts'
import { postReview } from '../src/report/actions.ts'
import type { Octokit } from '../src/resolve/github.ts'
import { Resolver } from '../src/resolve/resolver.ts'
import { changedSites, isCommentable } from '../src/scan/diff.ts'
import { findUses } from '../src/scan/parse.ts'
import type { Finding } from '../src/types.ts'
import { FakeGitApi, sha } from './fake-api.ts'

const COMPROMISED = '0e58ed8671d6b60d0890c21b07f8835ace038e67'

describe('YAML anchors and aliases', () => {
  const text = [
    'x-checkout: &co actions/checkout@v4', // 1
    'x-step: &cache', // 2
    '  uses: actions/cache@v4', // 3
    'x-steps: &common', // 4
    '  - uses: actions/upload-artifact@v4', // 5
    'jobs:', // 6
    '  a:', // 7
    '    steps:', // 8
    '      - uses: *co', // 9
    '      - *cache', // 10
    '  b:', // 11
    '    steps: *common', // 12
    '',
  ].join('\n')

  it('follows scalar aliases, step aliases and aliased step lists', () => {
    const { sites, errors } = findUses('.github/workflows/ci.yml', text)
    assert.deepEqual(errors, [])
    assert.deepEqual(
      sites.map((s) => [s.value, s.line, s.alsoAt]),
      [
        ['actions/checkout@v4', 1, [9]],
        ['actions/cache@v4', 3, [10]],
        ['actions/upload-artifact@v4', 5, [12]],
      ],
    )
  })

  it('fixes `uses: *alias` at the anchor, so the alias keeps pointing at it', () => {
    const site = findUses('f.yml', text).sites.find((s) => s.value === 'actions/checkout@v4')!
    assert.equal(
      rewriteLine(site, `actions/checkout@${sha('4')}`, 'v4.2.2'),
      `x-checkout: &co actions/checkout@${sha('4')} # v4.2.2`,
    )
  })

  it('follows alias keys', () => {
    const usesKey = 'x: &k uses\njobs:\n  a:\n    steps:\n      - *k : evil/x@main\n'
    assert.deepEqual(
      findUses('f.yml', usesKey).sites.map((s) => s.value),
      ['evil/x@main'],
    )
    const stepsKey = 'x: &s steps\njobs:\n  a:\n    *s :\n      - uses: evil/x@main\n'
    assert.deepEqual(
      findUses('f.yml', stepsKey).sites.map((s) => s.value),
      ['evil/x@main'],
    )
  })

  it('reports a site reached by the same anchor from two places only once', () => {
    const twice = 'x: &s\n  uses: a/b@v1\njobs:\n  a:\n    steps: [*s]\n  b:\n    steps: [*s]\n'
    const { sites } = findUses('f.yml', twice)
    assert.equal(sites.length, 1)
    assert.deepEqual(sites[0].alsoAt, [5, 7])
  })
})

describe('changed mode', () => {
  const pinned = `good/x@${sha('a')}`
  const changed = (base: string, head: string, lines: Set<number> | null) =>
    changedSites(findUses('f.yml', head).sites, lines, findUses('f.yml', base).sites).map((s) => s.value)

  it('checks a site an anchor swap re-points, though none of its lines changed', () => {
    const base = `x-a: &a\n  uses: ${pinned}\nx-b: &b\n  uses: evil/x@main\njobs:\n  j:\n    steps:\n      - *a\n`
    const head = base.replace('&a', '&tmp').replace('&b', '&a').replace('&tmp', '&b')
    assert.deepEqual(changed(base, head, new Set([1, 3])), ['evil/x@main'])
  })

  it('checks a site that deleting an anchor redefinition re-points', () => {
    const tail = 'jobs:\n  j:\n    steps:\n      - *a\n'
    const base = `x1: &a\n  uses: evil/x@main\nx2: &a\n  uses: ${pinned}\n${tail}`
    const head = `x1: &a\n  uses: evil/x@main\n${tail}`
    assert.deepEqual(changed(base, head, new Set()), ['evil/x@main'])
  })

  it('checks a new alias to an existing site, but not the untouched site alone', () => {
    const base = 'x: &s\n  uses: a/b@v1\njobs:\n  a:\n    steps: [*s]\n'
    const head = `${base}  b:\n    steps: [*s]\n`
    assert.deepEqual(changed(base, head, new Set([6, 7])), ['a/b@v1'])
    assert.deepEqual(changed(base, base, new Set()), [])
  })

  it('checks a value the file already ran when an anchor swap moves it into another job', () => {
    const base =
      `x-a: &a\n  uses: ${pinned}\nx-b: &b\n  uses: evil/x@main\n` +
      'jobs:\n  unprivileged:\n    steps: [*b]\n  deploy:\n    steps: [*a]\n'
    const head = base.replace('&a', '&tmp').replace('&b', '&a').replace('&tmp', '&b')
    // Both values now run in a job that didn't run them before.
    assert.deepEqual(changed(base, head, new Set([1, 3])), [pinned, 'evil/x@main'])
  })

  it('does not re-check untouched legacy refs when a step is inserted above them', () => {
    const base = 'jobs:\n  j:\n    steps:\n      - uses: legacy/x@v1\n'
    const head = `jobs:\n  j:\n    steps:\n      - uses: ${pinned}\n      - uses: legacy/x@v1\n`
    assert.deepEqual(changed(base, head, new Set([4])), [pinned])
  })

  it('checks the whole file when GitHub omitted the patch', () => {
    const text = 'jobs:\n  j:\n    steps:\n      - uses: a/b@v1\n'
    assert.deepEqual(changed(text, text, null), ['a/b@v1'])
  })
})

describe('commentable lines', () => {
  it('never comments on files whose patch GitHub omitted', () => {
    const touched = new Map<string, Set<number> | null>([
      ['small.yml', new Set([3])],
      ['huge.yml', null],
    ])
    assert.equal(isCommentable(touched, 'small.yml', 3), true)
    assert.equal(isCommentable(touched, 'small.yml', 4), false)
    assert.equal(isCommentable(touched, 'huge.yml', 3), false)
    assert.equal(isCommentable(touched, 'other.yml', 3), false)
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
    assert.equal(
      await postReview(octokit, { owner: 'o', repo: 'r', pullNumber: 1, headSha: sha('a') }, [finding]),
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
  const rules = async (uses: string, configYaml: string) => (await audit(uses, configYaml)).map((f) => f.rule)

  it('still flags a compromised commit reached through a tag on an allowed repo', async () => {
    assert.deepEqual(await rules('tj-actions/changed-files@v45', 'allow: ["tj-actions/*"]'), ['compromised'])
  })

  it('still flags a compromised commit reached through a branch', async () => {
    assert.deepEqual(await rules('tj-actions/changed-files@main', ''), ['compromised', 'branch-ref'])
  })

  it('matches `repo@sha` deny entries against the commit a tag resolves to', async () => {
    const deny = `deny: ["acme/tool@${sha('b')}"]`
    assert.deepEqual(await rules('acme/tool@v1', deny), ['denied', 'unpinned-ref'])
    assert.deepEqual(await rules('acme/tool@v2', deny), ['unpinned-ref'])
  })

  it('applies `repo@sha` deny entries even when the repo is allow-listed', async () => {
    assert.deepEqual(await rules('acme/tool@v1', `allow: ["acme/*"]\ndeny: ["acme/tool@${sha('b')}"]`), ['denied'])
  })

  it('still matches literal `repo@tag` deny entries, once', async () => {
    const findings = await audit('acme/tool@v1', 'deny: ["acme/tool@v1"]')
    assert.equal(findings.filter((f) => f.rule === 'denied').length, 1)
  })

  it('treats `repo@` with an empty ref as denying the whole action', async () => {
    assert.deepEqual(await rules('acme/tool@v2', 'deny: ["acme/tool@"]'), ['denied', 'unpinned-ref'])
  })

  for (const deny of ['', '\ndeny: ["acme/*@main"]']) {
    it(`makes no API calls for an allow-listed repo no deny or compromised entry can match (${JSON.stringify(deny)})`, async () => {
      const fake = api()
      const { sites } = findUses('ci.yml', 'jobs:\n  j:\n    steps:\n      - uses: acme/tool@v1\n')
      const config = parseConfig(`allow: ["acme/*"]${deny}`)
      assert.deepEqual(await auditSites(sites, { resolver: new Resolver(fake), config }), [])
      assert.equal(fake.calls, 0)
    })
  }
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
    assert.partialDeepStrictEqual(f, { rule: 'comment-drift', line: 1 })
    assert.equal(f.fix?.newLine, `x: &co actions/checkout@${sha('4')} # v4.2.2`)
  })

  it('does not offer a one-line fix for a value spanning several lines', async () => {
    const [f] = await audit('jobs:\n  j:\n    steps:\n      - uses: >-\n          actions/checkout@v4.2.2\n')
    assert.equal(f.rule, 'unpinned-ref')
    assert.equal(f.fix, undefined)
  })
})
