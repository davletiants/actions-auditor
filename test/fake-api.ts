import type { GitApi, NamedCommit, RepoInfo } from '../src/resolve/github.ts'

export interface FakeRepo {
  info?: Partial<RepoInfo>
  /** tag name -> commit sha. Prefix the name with `@` to make it an annotated tag. */
  tags?: Record<string, string>
  branches?: Record<string, string>
  /** branch name -> every commit sha reachable from it (beyond the head). */
  history?: Record<string, string[]>
  /** Extra commits that exist (e.g. imposter commits from the fork network). */
  orphanCommits?: string[]
  latestRelease?: string
}

/** In-memory GitApi. Counts calls so tests can assert caching. */
export class FakeGitApi implements GitApi {
  calls = 0
  private readonly repos: Record<string, FakeRepo>
  constructor(repos: Record<string, FakeRepo>) {
    this.repos = repos
  }

  private r(owner: string, repo: string) {
    this.calls++
    return this.repos[`${owner}/${repo}`]
  }

  private tagEntries(r: FakeRepo) {
    return Object.entries(r.tags ?? {}).map(([name, sha]) => ({
      name: name.replace(/^@/, ''),
      annotated: name.startsWith('@'),
      sha,
    }))
  }

  async getRepo(owner: string, repo: string) {
    const r = this.r(owner, repo)
    if (!r) return null
    return {
      fullName: `${owner}/${repo}`,
      fork: false,
      archived: false,
      defaultBranch: 'main',
      ...r.info,
    }
  }

  async getRef(owner: string, repo: string, ref: string) {
    const r = this.r(owner, repo)
    if (!r) return null
    const [kind, ...rest] = ref.split('/')
    const name = rest.join('/')
    if (kind === 'heads') {
      const sha = r.branches?.[name]
      return sha ? { sha, type: 'commit' } : null
    }
    const tag = this.tagEntries(r).find((t) => t.name === name)
    if (!tag) return null
    return tag.annotated ? { sha: `tagobj-${tag.sha}`, type: 'tag' } : { sha: tag.sha, type: 'commit' }
  }

  async getTagObject(_owner: string, _repo: string, sha: string) {
    this.calls++
    return { sha: sha.replace(/^tagobj-/, ''), type: 'commit' }
  }

  private allCommits(r: FakeRepo): Set<string> {
    return new Set([
      ...Object.values(r.tags ?? {}),
      ...Object.values(r.branches ?? {}),
      ...Object.values(r.history ?? {}).flat(),
      ...(r.orphanCommits ?? []),
    ])
  }

  async commitExists(owner: string, repo: string, sha: string) {
    const r = this.r(owner, repo)
    return !!r && this.allCommits(r).has(sha)
  }

  async compare(owner: string, repo: string, base: string, head: string) {
    const r = this.r(owner, repo)
    if (!r) return null
    const baseSha = r.branches?.[base]
    if (!baseSha) return null
    if (baseSha === head) return 'identical'
    return r.history?.[base]?.includes(head) ? 'behind' : 'diverged'
  }

  async listTags(owner: string, repo: string): Promise<NamedCommit[]> {
    const r = this.r(owner, repo)
    return r ? this.tagEntries(r).map(({ name, sha }) => ({ name, sha })) : []
  }

  async listBranches(owner: string, repo: string): Promise<NamedCommit[]> {
    const r = this.r(owner, repo)
    return Object.entries(r?.branches ?? {}).map(([name, sha]) => ({ name, sha }))
  }

  async latestReleaseTag(owner: string, repo: string) {
    return this.r(owner, repo)?.latestRelease ?? null
  }
}

export const sha = (c: string) => c.repeat(40).slice(0, 40)
