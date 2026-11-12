/**
 * Interface et transport HTTP communs aux fournisseurs distants (GitLab, GitHub).
 * S'exécute exclusivement dans le processus principal d'Electron.
 */

import type { RemoteProviderName, SyncApplySummary, SyncPlanItem } from '../../shared/secretsTypes'
import type { SyncVariableRecord } from '../sync'

export class ProviderError extends Error {
  constructor(
    readonly code:
      | 'INSECURE_URL'
      | 'NETWORK'
      | 'AUTH'
      | 'NOT_FOUND'
      | 'HTTP_ERROR'
      | 'INVALID_RESPONSE'
      | 'INVALID_KEY'
      | 'INVALID_TARGET'
      | 'INVALID',
    message: string,
    readonly status?: number,
  ) {
    super(message)
    this.name = 'ProviderError'
  }
}

export interface HttpResponse {
  status: number
  headers: Record<string, string>
  body: string
}

export type HttpTransport = (
  method: string,
  url: string,
  headers: Record<string, string>,
  body?: string,
) => Promise<HttpResponse>

export const defaultTransport: HttpTransport = async (
  method: string,
  url: string,
  headers: Record<string, string>,
  body?: string,
): Promise<HttpResponse> => {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new ProviderError('INSECURE_URL', 'URL distante invalide.')
  }
  if (parsed.protocol !== 'https:') {
    throw new ProviderError('INSECURE_URL', 'Seules les URL HTTPS sont autorisées.')
  }

  try {
    const response = await fetch(url, {
      method,
      headers,
      body,
      signal: AbortSignal.timeout(15_000),
    })
    const outHeaders: Record<string, string> = {}
    response.headers.forEach((value, key) => {
      outHeaders[key.toLowerCase()] = value
    })
    const text = await response.text()
    return { status: response.status, headers: outHeaders, body: text }
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'erreur réseau'
    throw new ProviderError('NETWORK', `Impossible de joindre le serveur distant (${reason}).`)
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function requestJson<T = unknown>(
  transport: HttpTransport,
  method: string,
  url: string,
  headers: Record<string, string>,
  payload?: unknown,
  retries: number = 3,
): Promise<{ status: number; headers: Record<string, string>; data: T }> {
  const reqHeaders: Record<string, string> = { ...headers }
  let body: string | undefined
  if (payload !== undefined) {
    body = JSON.stringify(payload)
    if (!reqHeaders['Content-Type']) reqHeaders['Content-Type'] = 'application/json'
  }

  let attempt = 0
  let resp: HttpResponse
  for (;;) {
    resp = await transport(method, url, reqHeaders, body)
    if (resp.status === 429 && attempt + 1 < retries) {
      attempt += 1
      const retryAfter = Number.parseFloat(resp.headers['retry-after'] ?? '')
      const delaySec = Number.isFinite(retryAfter)
        ? Math.min(Math.max(retryAfter, 0.1), 5)
        : 0.5 * attempt
      await sleep(delaySec * 1000)
      continue
    }
    break
  }

  if (resp.status === 401 || resp.status === 403) {
    throw new ProviderError(
      'AUTH',
      'Jeton refusé ou permissions insuffisantes sur le fournisseur distant.',
      resp.status,
    )
  }
  if (resp.status === 404) {
    throw new ProviderError(
      'NOT_FOUND',
      'Projet, dépôt ou ressource introuvable sur le fournisseur distant.',
      resp.status,
    )
  }
  if (resp.status >= 400) {
    let detail = ''
    if (resp.body) {
      try {
        const errObj = JSON.parse(resp.body) as { message?: unknown }
        if (typeof errObj?.message === 'string') {
          detail = ` (${errObj.message})`
        } else if (errObj?.message && typeof errObj.message === 'object') {
          detail = ` (${Object.keys(errObj.message as object).join(', ')})`
        }
      } catch {
        // Ignoré
      }
    }
    throw new ProviderError(
      'HTTP_ERROR',
      `Erreur HTTP ${resp.status} renvoyée par le fournisseur distant${detail}.`,
      resp.status,
    )
  }

  if (!resp.body || resp.status === 204) {
    return { status: resp.status, headers: resp.headers, data: null as T }
  }
  try {
    return {
      status: resp.status,
      headers: resp.headers,
      data: JSON.parse(resp.body) as T,
    }
  } catch {
    throw new ProviderError(
      'INVALID_RESPONSE',
      'Réponse JSON invalide du fournisseur distant.',
      resp.status,
    )
  }
}

export interface RemoteProvider {
  readonly name: RemoteProviderName
  readonly canReadValues: boolean
  verifyToken(): Promise<string>
  listRemote(target: string, scope: string): Promise<SyncVariableRecord[]>
  applyPlan(
    target: string,
    scope: string,
    localVars: SyncVariableRecord[],
    planItems: SyncPlanItem[],
  ): Promise<SyncApplySummary>
}

