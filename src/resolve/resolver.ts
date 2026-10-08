import type { GitApi, NamedCommit, RepoInfo } from './github.js'

export type RefResolution =
  | { kind: 'tag'; sha: string }
  | { kind: 'branch'; sha: string }
  | { kind: 'ambiguous'; tagSha: string; branchSha: string }
  | { kind: 'missing' }

export type Reachability = 'reachable' | 'imposter' | 'missing'

const MAX_TAG_DEREF = 5
const MAX_BRANCH_COMPARES = 20

/** Caching layer over GitApi. One instance per run; every lookup is memoized as a promise. */
export class Resolver {
  private readonly cache = new Map<string, Promise<unknown>>()

  constructor(private readonly api: GitApi) {}

  repo(owner: string, repo: string): Promise<RepoInfo | null> {
    return this.memo(`repo:${owner}/${repo}`, () => this.api.getRepo(owner, repo))
  }

  async resolveRef(owner: string, repo: string, ref: string): Promise<RefResolution> {
    const [tagSha, branchSha] = await Promise.all([
      this.tagCommit(owner, repo, ref),
      this.branchCommit(owner, repo, ref),
    ])
    if (tagSha && branchSha) {
      return tagSha === branchSha ? { kind: 'tag', sha: tagSha } : { kind: 'ambiguous', tagSha, branchSha }
    }
    if (tagSha) return { kind: 'tag', sha: tagSha }
    if (branchSha) return { kind: 'branch', sha: branchSha }
    return { kind: 'missing' }
  }

  /** Commit SHA a tag points at, following annotated tag objects. */
  tagCommit(owner: string, repo: string, tag: string): Promise<string | null> {
    return this.memo(`tag:${owner}/${repo}:${tag}`, async () => {
      let obj = await this.api.getRef(owner, repo, `tags/${tag}`)
      for (let i = 0; obj && obj.type === 'tag' && i < MAX_TAG_DEREF; i++) {
        obj = await this.api.getTagObject(owner, repo, obj.sha)
      }
      return obj && obj.type === 'commit' ? obj.sha : null
    })
  }

  branchCommit(owner: string, repo: string, branch: string): Promise<string | null> {
    return this.memo(`branch:${owner}/${repo}:${branch}`, async () => {
      const obj = await this.api.getRef(owner, repo, `heads/${branch}`)
      return obj?.sha ?? null
    })
  }

  tags(owner: string, repo: string): Promise<NamedCommit[]> {
    return this.memo(`tags:${owner}/${repo}`, () => this.api.listTags(owner, repo))
  }

  branches(owner: string, repo: string): Promise<NamedCommit[]> {
    return this.memo(`branches:${owner}/${repo}`, () => this.api.listBranches(owner, repo))
  }

  latestReleaseTag(owner: string, repo: string): Promise<string | null> {
    return this.memo(`release:${owner}/${repo}`, () => this.api.latestReleaseTag(owner, repo))
  }

  /**
   * The most specific tag pointing at `sha`, preferring tags in the same family as `hint`
   * (so a floating `v4` resolves to a comment like `v4.2.2`).
   */
  async bestTagFor(owner: string, repo: string, sha: string, hint?: string): Promise<string | undefined> {
    const candidates = (await this.tags(owner, repo)).filter((t) => t.sha === sha).map((t) => t.name)
    if (hint && !candidates.includes(hint)) candidates.push(hint)
    if (!candidates.length) return undefined
    const family = (name: string) => !!hint && (name === hint || name.startsWith(`${hint}.`))
    const specificity = (name: string) => name.split(/[.-]/).length
    return candidates.sort(
      (a, b) =>
        Number(family(b)) - Number(family(a)) ||
        specificity(b) - specificity(a) ||
        b.localeCompare(a, undefined, { numeric: true }),
    )[0]
  }

  /**
   * Is `sha` part of the upstream repo's history? GitHub serves commits from any fork under
   * the parent's URL, so `owner/repo@<sha>` can run code the owner never merged.
   */
  reachability(owner: string, repo: string, sha: string): Promise<Reachability> {
    return this.memo(`reach:${owner}/${repo}:${sha}`, async (): Promise<Reachability> => {
      if (!(await this.api.commitExists(owner, repo, sha))) return 'missing'
      if ((await this.tags(owner, repo)).some((t) => t.sha === sha)) return 'reachable'

      const info = await this.repo(owner, repo)
      const branches = await this.branches(owner, repo)
      if (branches.some((b) => b.sha === sha)) return 'reachable'

      const ordered = [
        ...(info ? [info.defaultBranch] : []),
        ...branches.map((b) => b.name).filter((n) => n !== info?.defaultBranch),
      ].slice(0, MAX_BRANCH_COMPARES)
      for (const branch of ordered) {
        const status = await this.api.compare(owner, repo, branch, sha)
        if (status === 'behind' || status === 'identical') return 'reachable'
      }
      return 'imposter'
    })
  }

  private memo<T>(key: string, fn: () => Promise<T>): Promise<T> {
    let hit = this.cache.get(key) as Promise<T> | undefined
    if (!hit) {
      hit = fn()
      this.cache.set(key, hit)
    }
    return hit
  }
}
