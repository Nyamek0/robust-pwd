import { useEffect, useState } from 'react'
import type {
  CredentialMeta,
  ProjectMeta,
  PullSummary,
  RemoteProviderName,
  SyncAction,
  SyncApplySummary,
  SyncPlan,
} from '@shared/secretsTypes'
import { Modal } from '../Modal'
import { CloudIcon, DownloadIcon, RefreshIcon, UploadIcon, XIcon } from '../icons'

type Props = {
  open: boolean
  project: ProjectMeta
  environment: string
  credentials: CredentialMeta[]
  onClose: () => void
  onLogin: (
    provider: RemoteProviderName,
    token: string,
    host: string,
  ) => Promise<{ ok: true; identity: string } | { ok: false; error: string }>
  onLogout: (provider: RemoteProviderName, host: string) => Promise<string | null>
  onLink: (
    provider: RemoteProviderName,
    target: string,
    host: string,
  ) => Promise<string | null>
  onUnlink: () => Promise<string | null>
  onSetScope: (scope: string | null) => Promise<string | null>
  onPlan: (prune: boolean) => Promise<{ ok: true; plan: SyncPlan } | { ok: false; error: string }>
  onApply: (
    prune: boolean,
  ) => Promise<{ ok: true; summary: SyncApplySummary } | { ok: false; error: string }>
  onPull: (
    overwrite: boolean,
  ) => Promise<{ ok: true; summary: PullSummary } | { ok: false; error: string }>
}

const DEFAULT_HOSTS: Record<RemoteProviderName, string> = {
  gitlab: 'https://gitlab.com',
  github: 'https://api.github.com',
}

const ACTION_LABELS: Record<SyncAction, string> = {
  create: '+ Créer',
  update: '~ Modifier',
  overwrite: '~ Écraser',
  delete: '− Supprimer',
  keep: 'Conserver',
  unchanged: '= Identique',
}

export function RemoteSyncDialog({
  open,
  project,
  environment,
  credentials,
  onClose,
  onLogin,
  onLogout,
  onLink,
  onUnlink,
  onSetScope,
  onPlan,
  onApply,
  onPull,
}: Props) {
  const currentEnv = project.environments.find((e) => e.name === environment)
  const [tab, setTab] = useState<'config' | 'sync'>('config')
  const [provider, setProvider] = useState<RemoteProviderName>('gitlab')
  const [host, setHost] = useState(DEFAULT_HOSTS.gitlab)
  const [target, setTarget] = useState('')
  const [token, setToken] = useState('')
  const [scopeInput, setScopeInput] = useState('')
  const [prune, setPrune] = useState(false)
  const [confirmPrune, setConfirmPrune] = useState(false)
  const [plan, setPlan] = useState<SyncPlan | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [info, setInfo] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    const initialProvider = project.remote?.provider ?? 'gitlab'
    setProvider(initialProvider)
    setHost(project.remote?.host ?? DEFAULT_HOSTS[initialProvider])
    setTarget(project.remote?.target ?? '')
    setToken('')
    setScopeInput(currentEnv?.remoteScope ?? '')
    setPrune(false)
    setConfirmPrune(false)
    setPlan(null)
    setError(null)
    setInfo(null)
    setTab(project.remote && currentEnv?.remoteScope ? 'sync' : 'config')
  }, [open, project, currentEnv])

  const normalizedHost = host.trim().replace(/\/+$/, '') || DEFAULT_HOSTS[provider]
  const hasSavedToken = credentials.some(
    (c) => c.provider === provider && c.host === normalizedHost,
  )

  function handleProviderChange(next: RemoteProviderName) {
    setProvider(next)
    setHost(DEFAULT_HOSTS[next])
    setError(null)
    setInfo(null)
  }

  async function handleSaveToken() {
    if (busy || !token.trim()) return
    setError(null)
    setInfo(null)
    setBusy(true)
    const res = await onLogin(provider, token.trim(), normalizedHost)
    setBusy(false)
    if (!res.ok) {
      setError(res.error)
      return
    }
    setToken('')
    setInfo(`Connecté à ${provider} en tant que « ${res.identity} ».`)
  }

  async function handleRemoveToken() {
    if (busy) return
    setError(null)
    setInfo(null)
    setBusy(true)
    const err = await onLogout(provider, normalizedHost)
    setBusy(false)
    if (err) {
      setError(err)
      return
    }
    setInfo('Jeton supprimé du coffre.')
  }

  async function handleSaveLink() {
    if (busy) return
    setError(null)
    setInfo(null)
    setBusy(true)
    const err = await onLink(provider, target.trim(), normalizedHost)
    if (!err) {
      const nextScope = scopeInput.trim() || null
      const scopeErr = await onSetScope(nextScope)
      setBusy(false)
      if (scopeErr) {
        setError(scopeErr)
        return
      }
      setInfo('Configuration distante enregistrée.')
      if (nextScope) {
        setTab('sync')
        void loadPlan(prune)
      }
    } else {
      setBusy(false)
      setError(err)
    }
  }

  async function handleUnlink() {
    if (busy) return
    setError(null)
    setInfo(null)
    setBusy(true)
    const err = await onUnlink()
    setBusy(false)
    if (err) {
      setError(err)
      return
    }
    setTarget('')
    setPlan(null)
    setInfo('Liaison distante supprimée.')
  }

  async function loadPlan(nextPrune: boolean) {
    setError(null)
    setInfo(null)
    setConfirmPrune(false)
    setBusy(true)
    const res = await onPlan(nextPrune)
    setBusy(false)
    if (!res.ok) {
      setPlan(null)
      setError(res.error)
      return
    }
    setPlan(res.plan)
  }

  async function handleApply() {
    if (busy || !plan) return
    if (plan.counts.delete > 0 && !confirmPrune) {
      setConfirmPrune(true)
      return
    }
    setError(null)
    setInfo(null)
    setBusy(true)
    const res = await onApply(prune)
    setBusy(false)
    if (!res.ok) {
      setError(res.error)
      return
    }
    setConfirmPrune(false)
    setInfo(
      `Synchronisé : ${res.summary.created} créée(s), ${res.summary.updated} mise(s) à jour, ${res.summary.deleted} supprimée(s).`,
    )
    void loadPlan(prune)
  }

  async function handlePull() {
    if (busy) return
    setError(null)
    setInfo(null)
    setBusy(true)
    const res = await onPull(true)
    setBusy(false)
    if (!res.ok) {
      setError(res.error)
      return
    }
    setInfo(
      `Récupéré depuis GitLab : ${res.summary.added} ajoutée(s), ${res.summary.updated} mise(s) à jour.`,
    )
    void loadPlan(prune)
  }

  const actionableCount = plan
    ? plan.counts.create + plan.counts.update + plan.counts.overwrite + plan.counts.delete
    : 0

  return (
    <Modal open={open} label="Synchronisation CI/CD" onClose={onClose}>
      <div className="modal-head">
        <div className="modal-head-icon">
          <CloudIcon size={20} />
        </div>
        <div>
          <h2>Synchronisation CI/CD · {project.name}</h2>
          <p>
            Environnement « {environment} » · requêtes HTTPS exécutées par le processus
            principal uniquement sur votre demande.
          </p>
        </div>
        <button
          type="button"
          className="icon-btn"
          onClick={onClose}
          aria-label="Fermer"
        >
          <XIcon size={18} />
        </button>
      </div>

      <div className="modal-body">
        <div className="mode-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'config'}
            onClick={() => setTab('config')}
          >
            Configuration
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'sync'}
            onClick={() => {
              setTab('sync')
              void loadPlan(prune)
            }}
          >
            Plan & Envoi
          </button>
        </div>

        {tab === 'config' && (
          <>
            <div className="segmented" role="group" aria-label="Fournisseur">
              <button
                type="button"
                aria-pressed={provider === 'gitlab'}
                onClick={() => handleProviderChange('gitlab')}
              >
                GitLab CI/CD
              </button>
              <button
                type="button"
                aria-pressed={provider === 'github'}
                onClick={() => handleProviderChange('github')}
              >
                GitHub Actions
              </button>
            </div>

            <label className="field">
              <span>Hôte HTTPS</span>
              <input
                className="input input-mono"
                value={host}
                onChange={(event) => setHost(event.target.value)}
                placeholder={DEFAULT_HOSTS[provider]}
                spellCheck={false}
              />
            </label>

            <div className="field">
              <div className="section-head">
                <span>
                  Jeton ({hasSavedToken ? 'enregistré dans secrets.enc' : 'aucun jeton'})
                </span>
                {hasSavedToken && (
                  <button
                    type="button"
                    className="btn btn-sm btn-danger"
                    onClick={() => void handleRemoveToken()}
                    disabled={busy}
                  >
                    Oublier le jeton
                  </button>
                )}
              </div>
              <div className="inline-input-row">
                <input
                  className="input input-mono"
                  type="password"
                  value={token}
                  onChange={(event) => setToken(event.target.value)}
                  placeholder={
                    provider === 'gitlab'
                      ? 'glpat-… (scope api)'
                      : 'github_pat_… (Secrets: Read & Write)'
                  }
                  spellCheck={false}
                />
                <button
                  type="button"
                  className="btn"
                  onClick={() => void handleSaveToken()}
                  disabled={busy || !token.trim()}
                >
                  Vérifier & enregistrer
                </button>
              </div>
            </div>

            <label className="field">
              <span>
                {provider === 'gitlab'
                  ? 'Projet GitLab (groupe/projet)'
                  : 'Dépôt GitHub (propriétaire/dépôt)'}
              </span>
              <input
                className="input input-mono"
                value={target}
                onChange={(event) => setTarget(event.target.value)}
                placeholder={provider === 'gitlab' ? 'mon-groupe/mon-api' : 'octocat/mon-api'}
                spellCheck={false}
              />
            </label>

            <label className="field">
              <span>Portée distante pour l’environnement « {environment} »</span>
              <div className="inline-input-row">
                <input
                  className="input input-mono"
                  value={scopeInput}
                  onChange={(event) => setScopeInput(event.target.value)}
                  placeholder={
                    provider === 'gitlab'
                      ? '* (toutes) ou nom de portée (ex. production)'
                      : '* (secrets du dépôt) ou environnement GitHub'
                  }
                  spellCheck={false}
                />
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => setScopeInput('*')}
                >
                  *
                </button>
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => setScopeInput(environment)}
                >
                  {environment}
                </button>
              </div>
            </label>

            <div className="inline-input-row">
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => void handleSaveLink()}
                disabled={busy || !target.trim()}
              >
                Enregistrer la liaison
              </button>
              {project.remote && (
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => void handleUnlink()}
                  disabled={busy}
                >
                  Délier le projet
                </button>
              )}
            </div>
          </>
        )}

        {tab === 'sync' && (
          <>
            <div className="sync-toolbar">
              <label className="check-pill">
                <input
                  type="checkbox"
                  checked={prune}
                  onChange={(event) => {
                    const next = event.target.checked
                    setPrune(next)
                    void loadPlan(next)
                  }}
                />
                <span>Supprimer à distance les variables absentes localement (prune)</span>
              </label>
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => void loadPlan(prune)}
                disabled={busy}
              >
                <RefreshIcon size={13} /> Actualiser
              </button>
            </div>

            {plan && (
              <div className="sync-plan">
                <div className="sync-plan-head">
                  <span>
                    <strong>{plan.provider}</strong> · {plan.target} (portée{' '}
                    <code>{plan.scope}</code>)
                  </span>
                  <span>
                    {plan.counts.create} à créer · {plan.counts.update + plan.counts.overwrite}{' '}
                    à mettre à jour · {plan.counts.delete} à supprimer
                  </span>
                </div>

                {plan.items.length === 0 ? (
                  <p className="form-hint">Aucune variable dans cet environnement.</p>
                ) : (
                  <div className="sync-plan-list">
                    {plan.items.map((item) => (
                      <div key={item.key} className="sync-plan-row">
                        <span className={`sync-badge sync-${item.action}`}>
                          {ACTION_LABELS[item.action]}
                        </span>
                        <span className="input-mono">{item.key}</span>
                      </div>
                    ))}
                  </div>
                )}

                {plan.errors.length > 0 && (
                  <div className="form-error" role="alert">
                    {plan.errors.map((err) => (
                      <div key={err}>✗ {err}</div>
                    ))}
                  </div>
                )}

                {confirmPrune && (
                  <p className="auth-warning" role="alert">
                    Confirmez-vous la suppression définitive de {plan.counts.delete} variable(s)
                    sur {plan.provider} ? Cliquez à nouveau sur « Appliquer le plan » pour
                    confirmer.
                  </p>
                )}
              </div>
            )}
          </>
        )}

        {info && <p className="form-hint">{info}</p>}
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
      </div>

      <div className="modal-actions">
        <button type="button" className="btn btn-ghost" onClick={onClose}>
          Fermer
        </button>
        {tab === 'sync' && project.remote?.provider === 'gitlab' && (
          <button
            type="button"
            className="btn"
            onClick={() => void handlePull()}
            disabled={busy}
          >
            <DownloadIcon size={15} /> Récupérer de GitLab
          </button>
        )}
        {tab === 'sync' && (
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => void handleApply()}
            disabled={
              busy || !plan || plan.errors.length > 0 || actionableCount === 0
            }
          >
            <UploadIcon size={15} />{' '}
            {confirmPrune ? 'Confirmer et envoyer' : 'Appliquer le plan'}
          </button>
        )}
      </div>
    </Modal>
  )
}

