import type { getOctokit } from '@actions/github'

export type Octokit = ReturnType<typeof getOctokit>

export interface RepoInfo {
  fullName: string
  fork: boolean
  archived: boolean
  defaultBranch: string
}

export interface NamedCommit {
  name: string
  sha: string
}

/** The handful of GitHub API calls the auditor needs. Every "not found" is `null`, never a throw. */
export interface GitApi {
  getRepo(owner: string, repo: string): Promise<RepoInfo | null>
  /** `ref` is e.g. `tags/v4` or `heads/main`. Returns the object the ref points at. */
  getRef(owner: string, repo: string, ref: string): Promise<{ sha: string; type: string } | null>
  /** Dereferences an annotated tag object one level. */
  getTagObject(owner: string, repo: string, sha: string): Promise<{ sha: string; type: string } | null>
  commitExists(owner: string, repo: string, sha: string): Promise<boolean>
  /** Status of `base...head`: ahead | behind | identical | diverged, or null if not comparable. */
  compare(owner: string, repo: string, base: string, head: string): Promise<string | null>
  /** Tags with their peeled commit SHA. */
  listTags(owner: string, repo: string): Promise<NamedCommit[]>
  listBranches(owner: string, repo: string): Promise<NamedCommit[]>
  latestReleaseTag(owner: string, repo: string): Promise<string | null>
}

const MAX_PAGES = 10 // 1000 tags / branches is plenty; bounded to protect the rate limit

export class OctokitGitApi implements GitApi {
  constructor(private readonly octokit: Octokit) {}

  async getRepo(owner: string, repo: string): Promise<RepoInfo | null> {
    return orNull(async () => {
      const { data } = await this.octokit.rest.repos.get({ owner, repo })
      return {
        fullName: data.full_name,
        fork: data.fork,
        archived: data.archived,
        defaultBranch: data.default_branch,
      }
    })
  }

  async getRef(owner: string, repo: string, ref: string) {
    return orNull(async () => {
      const { data } = await this.octokit.rest.git.getRef({ owner, repo, ref })
      // Older API behaviour returned an array of prefix matches; insist on an exact match.
      const exact = (Array.isArray(data) ? data : [data]).find((r) => r.ref === `refs/${ref}`)
      return exact ? { sha: exact.object.sha, type: exact.object.type } : null
    })
  }

  async getTagObject(owner: string, repo: string, sha: string) {
    return orNull(async () => {
      const { data } = await this.octokit.rest.git.getTag({ owner, repo, tag_sha: sha })
      return { sha: data.object.sha, type: data.object.type }
    })
  }

  async commitExists(owner: string, repo: string, sha: string): Promise<boolean> {
    const result = await orNull(() => this.octokit.rest.repos.getCommit({ owner, repo, ref: sha, per_page: 1 }))
    return result !== null
  }

  async compare(owner: string, repo: string, base: string, head: string) {
    return orNull(async () => {
      const { data } = await this.octokit.rest.repos.compareCommitsWithBasehead({
        owner,
        repo,
        basehead: `${base}...${head}`,
        per_page: 1,
      })
      return data.status
    })
  }

  async listTags(owner: string, repo: string): Promise<NamedCommit[]> {
    return this.paginateNamed(this.octokit.rest.repos.listTags, owner, repo)
  }

  async listBranches(owner: string, repo: string): Promise<NamedCommit[]> {
    return this.paginateNamed(this.octokit.rest.repos.listBranches, owner, repo)
  }

  async latestReleaseTag(owner: string, repo: string) {
    return orNull(async () => (await this.octokit.rest.repos.getLatestRelease({ owner, repo })).data.tag_name)
  }

  private async paginateNamed(
    method: Octokit['rest']['repos']['listTags'] | Octokit['rest']['repos']['listBranches'],
    owner: string,
    repo: string,
  ): Promise<NamedCommit[]> {
    const out: NamedCommit[] = []
    let page = 0
    try {
      for await (const response of this.octokit.paginate.iterator(method, { owner, repo, per_page: 100 })) {
        for (const item of response.data as Array<{ name: string; commit: { sha: string } }>) {
          out.push({ name: item.name, sha: item.commit.sha })
        }
        if (++page >= MAX_PAGES) break
      }
    } catch (err) {
      if (!isNotFound(err)) throw err
    }
    return out
  }
}

async function orNull<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn()
  } catch (err) {
    if (isNotFound(err)) return null
    throw err
  }
}

function isNotFound(err: unknown): boolean {
  const status = (err as { status?: number })?.status
  // 422 is returned for e.g. compare with an unknown SHA or a malformed ref.
  return status === 404 || status === 422 || status === 409
}
