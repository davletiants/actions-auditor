export type ActionRef =
  | { kind: 'local'; raw: string }
  | { kind: 'docker'; raw: string; digest?: string }
  | {
      kind: 'repo'
      raw: string
      owner: string
      repo: string
      /** Sub-path inside the repo (composite action dir or reusable workflow file), if any. */
      path?: string
      ref: string
      isSha: boolean
      isShortSha: boolean
    }
  | { kind: 'invalid'; raw: string; reason: string }

export const FULL_SHA = /^[0-9a-f]{40}$/
const SHORT_SHA = /^[0-9a-f]{7,39}$/
const DOCKER_DIGEST = /@sha256:[0-9a-f]{64}$/

export function parseActionRef(raw: string): ActionRef {
  const value = raw.trim()
  if (value.startsWith('./') || value.startsWith('../')) return { kind: 'local', raw: value }

  if (value.startsWith('docker://')) {
    return { kind: 'docker', raw: value, digest: value.match(DOCKER_DIGEST)?.[0].slice(1) }
  }

  if (value.includes('${{')) {
    return { kind: 'invalid', raw: value, reason: 'expressions are not allowed in `uses:`' }
  }

  const at = value.lastIndexOf('@')
  if (at === -1) return { kind: 'invalid', raw: value, reason: 'missing `@<ref>`' }
  const target = value.slice(0, at)
  const ref = value.slice(at + 1)
  const [owner, repo, ...rest] = target.split('/')
  if (!owner || !repo || !ref) {
    return { kind: 'invalid', raw: value, reason: 'expected `owner/repo[/path]@ref`' }
  }
  return {
    kind: 'repo',
    raw: value,
    owner,
    repo,
    path: rest.length ? rest.join('/') : undefined,
    ref,
    isSha: FULL_SHA.test(ref),
    isShortSha: !FULL_SHA.test(ref) && SHORT_SHA.test(ref),
  }
}

/** `owner/repo[/path]` without the ref, used for allow/deny matching and messages. */
export function actionName(ref: Extract<ActionRef, { kind: 'repo' }>): string {
  return ref.path ? `${ref.owner}/${ref.repo}/${ref.path}` : `${ref.owner}/${ref.repo}`
}
