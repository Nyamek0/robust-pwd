/**
 * Fournisseur GitLab CI/CD (variables de projet, REST v4).
 * Jumeau de `robust_pwd/providers/gitlab.py`.
 */

import type { SyncApplySummary, SyncPlanItem } from '../../shared/secretsTypes'
import type { SyncVariableRecord } from '../sync'
import {
  defaultTransport,
  ProviderError,
  requestJson,
  type HttpTransport,
  type RemoteProvider,
} from './base'

export class GitLabProvider implements RemoteProvider {
  readonly name = 'gitlab' as const
  readonly canReadValues = true
  private readonly host: string

  constructor(
    host: string,
    private readonly token: string,
    private readonly transport: HttpTransport = defaultTransport,
  ) {
    this.host = host.replace(/\/+$/, '')
  }

  private headers(): Record<string, string> {
    return {
      'PRIVATE-TOKEN': this.token,
      Accept: 'application/json',
      'User-Agent': 'robust-pwd/1.1',
    }
  }

  private projectUrl(target: string): string {
    const encoded = encodeURIComponent(target.replace(/^\/+|\/+$/g, ''))
    return `${this.host}/api/v4/projects/${encoded}`
  }

  async verifyToken(): Promise<string> {
    const { data } = await requestJson<{ username?: unknown }>(
      this.transport,
      'GET',
      `${this.host}/api/v4/user`,
      this.headers(),
    )
    if (!data || typeof data.username !== 'string' || !data.username) {
      throw new ProviderError('INVALID_RESPONSE', 'Réponse utilisateur GitLab invalide.')
    }
    return data.username
  }

  async listRemote(target: string, scope: string): Promise<SyncVariableRecord[]> {
    const base = this.projectUrl(target)
    let page = 1
    const collected: SyncVariableRecord[] = []

    for (;;) {
      const url = `${base}/variables?per_page=100&page=${page}`
      const { headers, data } = await requestJson<unknown[]>(
        this.transport,
        'GET',
        url,
        this.headers(),
      )
      if (!Array.isArray(data)) {
        throw new ProviderError('INVALID_RESPONSE', 'Liste de variables GitLab invalide.')
      }
      for (const raw of data) {
        if (!raw || typeof raw !== 'object') continue
        const item = raw as Record<string, unknown>
        const itemScope =
          typeof item.environment_scope === 'string' && item.environment_scope
            ? item.environment_scope
            : '*'
        if (itemScope !== scope) continue
        collected.push({
          key: String(item.key ?? ''),
          value: String(item.value ?? ''),
          masked: Boolean(item.masked ?? false),
          protected: Boolean(item.protected ?? false),
          raw: Boolean(item.raw ?? true),
          type: item.variable_type === 'file' ? 'file' : 'env_var',
        })
      }
      const nextPage = (headers['x-next-page'] ?? '').trim()
      if (!nextPage || data.length < 100) break
      const parsedNext = Number.parseInt(nextPage, 10)
      if (!Number.isInteger(parsedNext) || parsedNext <= page) break
      page = parsedNext
    }

    return collected
  }

  async applyPlan(
    target: string,
    scope: string,
    localVars: SyncVariableRecord[],
    planItems: SyncPlanItem[],
  ): Promise<SyncApplySummary> {
    const base = this.projectUrl(target)
    const byKey = new Map<string, SyncVariableRecord>()
    for (const v of localVars) byKey.set(v.key, v)
    const encodedScope = encodeURIComponent(scope)
    const summary: SyncApplySummary = { created: 0, updated: 0, deleted: 0 }

    for (const item of planItems) {
      const encodedKey = encodeURIComponent(item.key)
      if (item.action === 'create') {
        const variable = byKey.get(item.key)
        if (!variable) continue
        await requestJson(this.transport, 'POST', `${base}/variables`, this.headers(), {
          key: item.key,
          value: variable.value ?? '',
          masked: Boolean(variable.masked ?? false),
          protected: Boolean(variable.protected ?? false),
          raw: Boolean(variable.raw ?? true),
          variable_type: variable.type ?? 'env_var',
          environment_scope: scope,
        })
        summary.created += 1
      } else if (item.action === 'update') {
        const variable = byKey.get(item.key)
        if (!variable) continue
        const url = `${base}/variables/${encodedKey}?filter[environment_scope]=${encodedScope}`
        await requestJson(this.transport, 'PUT', url, this.headers(), {
          value: variable.value ?? '',
          masked: Boolean(variable.masked ?? false),
          protected: Boolean(variable.protected ?? false),
          raw: Boolean(variable.raw ?? true),
          variable_type: variable.type ?? 'env_var',
          environment_scope: scope,
        })
        summary.updated += 1
      } else if (item.action === 'delete') {
        const url = `${base}/variables/${encodedKey}?filter[environment_scope]=${encodedScope}`
        await requestJson(this.transport, 'DELETE', url, this.headers())
        summary.deleted += 1
      }
    }
    return summary
  }
}

