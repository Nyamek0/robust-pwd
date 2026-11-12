import type { RemoteProviderName } from '../../shared/secretsTypes'
import {
  defaultTransport,
  ProviderError,
  type HttpResponse,
  type HttpTransport,
  type RemoteProvider,
} from './base'
import { GitHubProvider, openSealedBox, sealBox } from './github'
import { GitLabProvider } from './gitlab'

export function createProvider(
  provider: RemoteProviderName,
  host: string,
  token: string,
  transport: HttpTransport = defaultTransport,
): RemoteProvider {
  if (provider === 'gitlab') return new GitLabProvider(host, token, transport)
  if (provider === 'github') return new GitHubProvider(host, token, transport)
  throw new ProviderError('INVALID', `Fournisseur inconnu : ${String(provider)}`)
}

export {
  defaultTransport,
  GitHubProvider,
  GitLabProvider,
  openSealedBox,
  ProviderError,
  sealBox,
  type HttpResponse,
  type HttpTransport,
  type RemoteProvider,
}
