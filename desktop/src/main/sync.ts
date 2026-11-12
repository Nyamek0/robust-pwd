/**
 * Calcul du plan de synchronisation et validation par fournisseur (voir `docs/secrets-format.md`, §5).
 *
 * Implémentation jumelle de `robust_pwd/sync.py`.
 */

import type {
  RemoteProviderName,
  SyncAction,
  SyncPlan,
  SyncPlanCounts,
  SyncPlanItem,
  VariableType,
} from '../shared/secretsTypes'

export interface SyncVariableRecord {
  key: string
  value: string | null
  masked?: boolean
  protected?: boolean
  raw?: boolean
  type?: VariableType
}

const ACTION_ORDER: Record<SyncAction, number> = {
  create: 0,
  update: 1,
  overwrite: 2,
  delete: 3,
  keep: 4,
  unchanged: 5,
}

const GITLAB_MASKED_RE = /^[A-Za-z0-9+/=@:.~_-]{8,}$/
const GITHUB_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/
const GITLAB_MAX_VALUE_LENGTH = 10_000
const GITHUB_MAX_VALUE_BYTES = 48 * 1024

export function validateForProvider(
  provider: RemoteProviderName,
  localVars: SyncVariableRecord[],
): string[] {
  const errors: string[] = []
  if (provider === 'gitlab') {
    for (const variable of localVars) {
      const value = variable.value ?? ''
      if (value.length > GITLAB_MAX_VALUE_LENGTH) {
        errors.push(
          `${variable.key} : dépasse la taille maximale GitLab (${GITLAB_MAX_VALUE_LENGTH} caractères).`,
        )
      }
      if (variable.masked) {
        if (value.length < 8) {
          errors.push(
            `${variable.key} : une variable masquée GitLab doit faire au moins 8 caractères.`,
          )
        } else if (value.includes('\n') || value.includes('\r')) {
          errors.push(
            `${variable.key} : une variable masquée GitLab ne peut pas être multi-ligne.`,
          )
        } else if (!GITLAB_MASKED_RE.test(value)) {
          errors.push(
            `${variable.key} : contient des caractères non pris en charge par le masquage GitLab.`,
          )
        }
      }
    }
  } else if (provider === 'github') {
    const seenUpper = new Map<string, string>()
    for (const variable of localVars) {
      const value = variable.value ?? ''
      const upper = variable.key.toUpperCase()
      const existing = seenUpper.get(upper)
      if (existing && existing !== variable.key) {
        errors.push(
          `${variable.key} : collision de nom insensible à la casse avec « ${existing} » sur GitHub.`,
        )
      }
      seenUpper.set(upper, variable.key)
      if (!GITHUB_KEY_RE.test(variable.key)) {
        errors.push(`${variable.key} : nom de secret GitHub invalide.`)
      }
      if (upper.startsWith('GITHUB_')) {
        errors.push(`${variable.key} : un secret GitHub ne peut pas commencer par « GITHUB_ ».`)
      }
      if (value.length === 0) {
        errors.push(`${variable.key} : un secret GitHub ne peut pas être vide.`)
      }
      if (Buffer.byteLength(value, 'utf8') > GITHUB_MAX_VALUE_BYTES) {
        errors.push(`${variable.key} : dépasse la limite GitHub de 48 Ko.`)
      }
    }
  }
  return errors
}

function sameGitLabVar(local: SyncVariableRecord, remote: SyncVariableRecord): boolean {
  return (
    (local.value ?? '') === (remote.value ?? '') &&
    Boolean(local.masked) === Boolean(remote.masked) &&
    Boolean(local.protected) === Boolean(remote.protected) &&
    (local.raw ?? true) === (remote.raw ?? true) &&
    (local.type ?? 'env_var') === (remote.type ?? 'env_var')
  )
}

export function buildSyncPlan(options: {
  provider: RemoteProviderName
  target: string
  environment: string
  scope: string
  localVars: SyncVariableRecord[]
  remoteVars: SyncVariableRecord[]
  prune?: boolean
}): SyncPlan {
  const { provider, target, environment, scope, localVars, remoteVars, prune = false } = options
  const canRead = provider === 'gitlab'
  const caseInsensitive = provider === 'github'
  const norm = (key: string): string => (caseInsensitive ? key.toUpperCase() : key)

  const localByNorm = new Map<string, SyncVariableRecord>()
  for (const v of localVars) localByNorm.set(norm(v.key), v)
  const remoteByNorm = new Map<string, SyncVariableRecord>()
  for (const v of remoteVars) remoteByNorm.set(norm(v.key), v)

  const items: SyncPlanItem[] = []
  for (const [nkey, lvar] of localByNorm.entries()) {
    const outKey = caseInsensitive ? nkey : lvar.key
    const rvar = remoteByNorm.get(nkey)
    let action: SyncAction
    if (!rvar) {
      action = 'create'
    } else if (!canRead) {
      action = 'overwrite'
    } else if (sameGitLabVar(lvar, rvar)) {
      action = 'unchanged'
    } else {
      action = 'update'
    }
    items.push({
      key: outKey,
      action,
      masked: Boolean(lvar.masked),
      protected: Boolean(lvar.protected),
      raw: lvar.raw ?? true,
      type: lvar.type ?? 'env_var',
    })
  }

  for (const [nkey, rvar] of remoteByNorm.entries()) {
    if (localByNorm.has(nkey)) continue
    items.push({
      key: rvar.key,
      action: prune ? 'delete' : 'keep',
      masked: Boolean(rvar.masked),
      protected: Boolean(rvar.protected),
      raw: rvar.raw ?? true,
      type: rvar.type ?? 'env_var',
    })
  }

  items.sort((a, b) => {
    const diff = ACTION_ORDER[a.action] - ACTION_ORDER[b.action]
    if (diff !== 0) return diff
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0
  })

  const counts: SyncPlanCounts = {
    create: 0,
    update: 0,
    overwrite: 0,
    delete: 0,
    keep: 0,
    unchanged: 0,
  }
  for (const item of items) counts[item.action] += 1

  const errors = validateForProvider(provider, localVars)
  return {
    provider,
    target,
    environment,
    scope,
    canReadValues: canRead,
    items,
    errors,
    counts,
  }
}

