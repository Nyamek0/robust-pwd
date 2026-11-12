import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  CreateProjectInput,
  CredentialMeta,
  DotenvExportFormat,
  DotenvImportSummary,
  DotenvPreview,
  ProjectMeta,
  RemoteProviderName,
  SecretGeneratorSpec,
  SecretsState,
  UpsertVariableInput,
  VariableMeta,
} from '@shared/secretsTypes'
import type { LockReason } from '@shared/types'
import { formatShortDate } from '../../lib/format'
import { AuthScreen } from '../AuthScreen'
import { Brand } from '../Brand'
import type { ToastKind } from '../Toasts'
import {
  CloudIcon,
  CodeIcon,
  CopyIcon,
  DownloadIcon,
  EditIcon,
  EyeIcon,
  EyeOffIcon,
  LockIcon,
  PlusIcon,
  SearchIcon,
  TrashIcon,
  UploadIcon,
  XIcon,
} from '../icons'
import { ExportEnvDialog } from './ExportEnvDialog'
import { ImportEnvDialog } from './ImportEnvDialog'
import { ProjectDialog } from './ProjectDialog'
import { RemoteSyncDialog } from './RemoteSyncDialog'
import { VariableDialog } from './VariableDialog'

const secretsApi = window.robustPwd.secrets
const mainApi = window.robustPwd

type Phase = 'loading' | 'setup' | 'locked' | 'unlocked'

type Props = {
  pushToast: (kind: ToastKind, message: string) => void
  workspaceSwitcher: React.ReactNode
}

export function SecretsWorkspace({ pushToast, workspaceSwitcher }: Props) {
  const [phase, setPhase] = useState<Phase>('loading')
  const [projects, setProjects] = useState<ProjectMeta[]>([])
  const [credentials, setCredentials] = useState<CredentialMeta[]>([])
  const [autoLockSeconds, setAutoLockSeconds] = useState(300)
  const [selectedProjectId, setSelectedProjectId] = useState<number | null>(null)
  const [selectedEnv, setSelectedEnv] = useState<string>('local')
  const [projectSearch, setProjectSearch] = useState('')
  const [varSearch, setVarSearch] = useState('')
  const [revealedValues, setRevealedValues] = useState<Record<string, string>>({})
  const [newEnvName, setNewEnvName] = useState('')
  const [addingEnv, setAddingEnv] = useState(false)

  // Dialog states
  const [projectDialogOpen, setProjectDialogOpen] = useState(false)
  const [editingProject, setEditingProject] = useState<ProjectMeta | null>(null)
  const [varDialogOpen, setVarDialogOpen] = useState(false)
  const [editingVar, setEditingVar] = useState<VariableMeta | null>(null)
  const [editingVarValue, setEditingVarValue] = useState('')
  const [importOpen, setImportOpen] = useState(false)
  const [exportOpen, setExportOpen] = useState(false)
  const [remoteOpen, setRemoteOpen] = useState(false)

  const searchRef = useRef<HTMLInputElement>(null)

  const applyState = useCallback((state: SecretsState) => {
    setProjects(state.projects)
    setCredentials(state.credentials)
    setAutoLockSeconds(state.autoLockSeconds)
  }, [])

  const replaceProject = useCallback((updated: ProjectMeta) => {
    setProjects((current) => {
      const exists = current.some((p) => p.id === updated.id)
      if (!exists) return [...current, updated]
      return current.map((p) => (p.id === updated.id ? updated : p))
    })
  }, [])

  useEffect(() => {
    let alive = true
    void (async () => {
      const status = await secretsApi.status()
      if (!alive) return
      if (!status.ok) {
        pushToast('error', status.error)
        setPhase('locked')
        return
      }
      setAutoLockSeconds(status.data.autoLockSeconds)
      if (!status.data.exists) {
        setPhase('setup')
        return
      }
      if (!status.data.unlocked) {
        setPhase('locked')
        return
      }
      const state = await secretsApi.state()
      if (!alive) return
      if (state.ok) {
        applyState(state.data)
        setPhase('unlocked')
      } else {
        setPhase('locked')
      }
    })()
    return () => {
      alive = false
    }
  }, [applyState, pushToast])

  useEffect(
    () =>
      secretsApi.onLocked((reason: LockReason) => {
        setProjects([])
        setCredentials([])
        setRevealedValues({})
        setProjectDialogOpen(false)
        setVarDialogOpen(false)
        setImportOpen(false)
        setExportOpen(false)
        setRemoteOpen(false)
        setPhase('locked')
        if (reason === 'idle') {
          pushToast('info', 'Coffre de secrets verrouillé automatiquement après inactivité.')
        }
      }),
    [pushToast],
  )

  useEffect(() => {
    if (phase !== 'unlocked') return
    let last = 0
    const onActivity = () => {
      const now = Date.now()
      if (now - last < 15_000) return
      last = now
      void secretsApi.touch()
    }
    window.addEventListener('pointerdown', onActivity)
    window.addEventListener('keydown', onActivity)
    window.addEventListener('wheel', onActivity, { passive: true })
    return () => {
      window.removeEventListener('pointerdown', onActivity)
      window.removeEventListener('keydown', onActivity)
      window.removeEventListener('wheel', onActivity)
    }
  }, [phase])

  // Garde la sélection projet / environnement cohérente
  const selectedProject = useMemo(
    () => projects.find((p) => p.id === selectedProjectId) ?? projects[0] ?? null,
    [projects, selectedProjectId],
  )

  useEffect(() => {
    if (!selectedProject) {
      setSelectedProjectId(null)
      return
    }
    if (selectedProject.id !== selectedProjectId) {
      setSelectedProjectId(selectedProject.id)
    }
    if (
      selectedProject.environments.length > 0 &&
      !selectedProject.environments.some((e) => e.name === selectedEnv)
    ) {
      setSelectedEnv(selectedProject.environments[0].name)
    }
  }, [selectedProject, selectedProjectId, selectedEnv])

  useEffect(() => {
    setRevealedValues({})
  }, [selectedProjectId, selectedEnv])

  const handleSetup = useCallback(
    async (master: string): Promise<string | null> => {
      const res = await secretsApi.createVault(master)
      if (!res.ok) return res.error
      applyState(res.data)
      setPhase('unlocked')
      pushToast('success', 'Coffre de secrets créé (secrets.enc).')
      return null
    },
    [applyState, pushToast],
  )

  const handleUnlock = useCallback(
    async (master: string): Promise<string | null> => {
      const res = await secretsApi.unlock(master)
      if (!res.ok) return res.error
      applyState(res.data)
      setPhase('unlocked')
      return null
    },
    [applyState],
  )

  const handleLock = useCallback(async () => {
    const res = await secretsApi.lock()
    if (!res.ok) {
      pushToast('error', res.error)
      return
    }
    setProjects([])
    setRevealedValues({})
    setPhase('locked')
  }, [pushToast])

  const visibleProjects = useMemo(() => {
    const q = projectSearch.trim().toLowerCase()
    if (!q) return projects
    return projects.filter(
      (p) => p.name.toLowerCase().includes(q) || p.description.toLowerCase().includes(q),
    )
  }, [projects, projectSearch])

  const currentEnvMeta = useMemo(
    () => selectedProject?.environments.find((e) => e.name === selectedEnv) ?? null,
    [selectedProject, selectedEnv],
  )

  const visibleVariables = useMemo(() => {
    const list = currentEnvMeta?.variables ?? []
    const q = varSearch.trim().toLowerCase()
    if (!q) return list
    return list.filter((v) => v.key.toLowerCase().includes(q))
  }, [currentEnvMeta, varSearch])

  // Actions projets
  const handleCreateProject = useCallback(
    async (input: CreateProjectInput): Promise<string | null> => {
      const res = await secretsApi.addProject(input)
      if (!res.ok) return res.error
      replaceProject(res.data)
      setSelectedProjectId(res.data.id)
      setSelectedEnv(res.data.environments[0]?.name ?? 'local')
      pushToast('success', `Projet « ${res.data.name} » créé.`)
      return null
    },
    [pushToast, replaceProject],
  )

  const handleRenameProject = useCallback(
    async (projectId: number, name: string, description: string): Promise<string | null> => {
      const res = await secretsApi.renameProject(projectId, name, description)
      if (!res.ok) return res.error
      replaceProject(res.data)
      pushToast('success', `Projet « ${res.data.name} » mis à jour.`)
      return null
    },
    [pushToast, replaceProject],
  )

  const handleDeleteProject = useCallback(
    async (project: ProjectMeta) => {
      if (!window.confirm(`Supprimer définitivement le projet « ${project.name} » ?`)) return
      const res = await secretsApi.removeProject(project.id)
      if (!res.ok) {
        pushToast('error', res.error)
        return
      }
      setProjects((current) => current.filter((p) => p.id !== project.id))
      pushToast('success', `Projet « ${project.name} » supprimé.`)
    },
    [pushToast],
  )

  const handleAddEnv = useCallback(async () => {
    if (!selectedProject || !newEnvName.trim()) return
    const res = await secretsApi.addEnvironment(selectedProject.id, newEnvName.trim())
    if (!res.ok) {
      pushToast('error', res.error)
      return
    }
    replaceProject(res.data)
    setSelectedEnv(newEnvName.trim())
    setNewEnvName('')
    setAddingEnv(false)
    pushToast('success', `Environnement « ${newEnvName.trim()} » ajouté.`)
  }, [newEnvName, pushToast, replaceProject, selectedProject])

  const handleRemoveEnv = useCallback(
    async (envName: string) => {
      if (!selectedProject) return
      if (
        !window.confirm(
          `Supprimer l'environnement « ${envName} » du projet « ${selectedProject.name} » ?`,
        )
      ) {
        return
      }
      const res = await secretsApi.removeEnvironment(selectedProject.id, envName)
      if (!res.ok) {
        pushToast('error', res.error)
        return
      }
      replaceProject(res.data)
      pushToast('success', `Environnement « ${envName} » supprimé.`)
    },
    [pushToast, replaceProject, selectedProject],
  )

  // Actions variables
  const toggleRevealVar = useCallback(
    async (key: string) => {
      if (!selectedProject) return
      if (key in revealedValues) {
        setRevealedValues((current) => {
          const next = { ...current }
          delete next[key]
          return next
        })
        return
      }
      const res = await secretsApi.revealVariable(selectedProject.id, selectedEnv, key)
      if (!res.ok) {
        pushToast('error', res.error)
        return
      }
      setRevealedValues((current) => ({ ...current, [key]: res.data }))
    },
    [pushToast, revealedValues, selectedEnv, selectedProject],
  )

  const handleCopyVar = useCallback(
    async (key: string) => {
      if (!selectedProject) return
      const res = await secretsApi.copyVariable(selectedProject.id, selectedEnv, key)
      if (!res.ok) {
        pushToast('error', res.error)
        return
      }
      pushToast('success', `« ${key} » copié · presse-papier effacé dans ${res.data} s`)
    },
    [pushToast, selectedEnv, selectedProject],
  )

  const openEditVariable = useCallback(
    async (variable: VariableMeta) => {
      if (!selectedProject) return
      const res = await secretsApi.revealVariable(selectedProject.id, selectedEnv, variable.key)
      if (!res.ok) {
        pushToast('error', res.error)
        return
      }
      setEditingVar(variable)
      setEditingVarValue(res.data)
      setVarDialogOpen(true)
    },
    [pushToast, selectedEnv, selectedProject],
  )

  const handleSaveVariable = useCallback(
    async (input: UpsertVariableInput): Promise<string | null> => {
      const res = await secretsApi.upsertVariable(input)
      if (!res.ok) return res.error
      replaceProject(res.data)
      setRevealedValues((current) => {
        if (!(input.key in current)) return current
        return { ...current, [input.key]: input.value }
      })
      pushToast('success', `Variable « ${input.key} » enregistrée.`)
      return null
    },
    [pushToast, replaceProject],
  )

  const handleRemoveVariable = useCallback(
    async (key: string) => {
      if (!selectedProject) return
      if (!window.confirm(`Supprimer la variable « ${key} » de ${selectedEnv} ?`)) return
      const res = await secretsApi.removeVariable(selectedProject.id, selectedEnv, key)
      if (!res.ok) {
        pushToast('error', res.error)
        return
      }
      replaceProject(res.data)
      pushToast('success', `Variable « ${key} » supprimée.`)
    },
    [pushToast, replaceProject, selectedEnv, selectedProject],
  )

  const handleGenerateSecret = useCallback(
    async (spec: SecretGeneratorSpec): Promise<string | null> => {
      const res = await secretsApi.generateSecret(spec)
      if (!res.ok) {
        pushToast('error', res.error)
        return null
      }
      return res.data
    },
    [pushToast],
  )

  // Import / Export .env
  const handlePreviewDotenv = useCallback(async (text: string): Promise<DotenvPreview | null> => {
    const res = await secretsApi.previewDotenv(text)
    return res.ok ? res.data : null
  }, [])

  const refreshState = useCallback(async () => {
    const state = await secretsApi.state()
    if (state.ok) applyState(state.data)
  }, [applyState])

  const handleImportText = useCallback(
    async (text: string, overwrite: boolean): Promise<DotenvImportSummary | string> => {
      if (!selectedProject) return 'Aucun projet sélectionné.'
      const res = await secretsApi.importDotenvText(
        selectedProject.id,
        selectedEnv,
        text,
        overwrite,
      )
      if (!res.ok) return res.error
      await refreshState()
      pushToast(
        'success',
        `Import .env : ${res.data.added} ajoutée(s), ${res.data.updated} modifiée(s), ${res.data.skipped} ignorée(s).`,
      )
      return res.data
    },
    [pushToast, refreshState, selectedEnv, selectedProject],
  )

  const handleImportFile = useCallback(
    async (overwrite: boolean): Promise<DotenvImportSummary | string> => {
      if (!selectedProject) return 'Aucun projet sélectionné.'
      const res = await secretsApi.importDotenvFile(selectedProject.id, selectedEnv, overwrite)
      if (!res.ok) return res.error
      if (!res.data.cancelled) {
        await refreshState()
        pushToast(
          'success',
          `Import .env : ${res.data.added} ajoutée(s), ${res.data.updated} modifiée(s), ${res.data.skipped} ignorée(s).`,
        )
      }
      return res.data
    },
    [pushToast, refreshState, selectedEnv, selectedProject],
  )

  const handleRenderExport = useCallback(
    async (format: DotenvExportFormat): Promise<string | null> => {
      if (!selectedProject) return null
      const res = await secretsApi.exportDotenvText(selectedProject.id, selectedEnv, format)
      if (!res.ok) {
        pushToast('error', res.error)
        return null
      }
      return res.data
    },
    [pushToast, selectedEnv, selectedProject],
  )

  const handleCopyRendered = useCallback(
    async (text: string) => {
      const res = await mainApi.copyText(text)
      if (!res.ok) {
        pushToast('error', res.error)
        return
      }
      pushToast('success', `Export copié · presse-papier effacé dans ${res.data} s`)
    },
    [pushToast],
  )

  const handleSaveExportFile = useCallback(
    async (format: DotenvExportFormat) => {
      if (!selectedProject) return
      const res = await secretsApi.exportDotenvFile(selectedProject.id, selectedEnv, format)
      if (!res.ok) {
        pushToast('error', res.error)
        return
      }
      if (res.data.cancelled) return
      if (res.data.gitIgnored === false) {
        pushToast(
          'error',
          `Exporté dans ${res.data.path} — ATTENTION : ce fichier n'est pas dans .gitignore !`,
        )
      } else {
        pushToast('success', `Exporté dans ${res.data.path} (permissions 600).`)
      }
    },
    [pushToast, selectedEnv, selectedProject],
  )

  // Raccourcis clavier (⌘N nouvelle variable, ⌘L verrouiller, ⌘F rechercher)
  useEffect(() => {
    if (phase !== 'unlocked') return
    const onKeyDown = (event: KeyboardEvent) => {
      const mod = event.metaKey || event.ctrlKey
      if (!mod) return
      const key = event.key.toLowerCase()
      if (key === 'n') {
        event.preventDefault()
        if (selectedProject) {
          setEditingVar(null)
          setEditingVarValue('')
          setVarDialogOpen(true)
        } else {
          setEditingProject(null)
          setProjectDialogOpen(true)
        }
      } else if (key === 'l') {
        event.preventDefault()
        void handleLock()
      } else if (key === 'f') {
        event.preventDefault()
        searchRef.current?.focus()
        searchRef.current?.select()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [phase, handleLock, selectedProject])

  if (phase === 'loading') {
    return (
      <div className="boot">
        <Brand large />
        <div className="boot-bar" aria-hidden="true">
          <span />
        </div>
        <p>Ouverture du coffre de secrets…</p>
      </div>
    )
  }

  if (phase === 'setup' || phase === 'locked') {
    return (
      <div className="app-shell">
        <header className="topbar">
          <Brand />
          {workspaceSwitcher}
          <div className="topbar-spacer" />
        </header>
        <AuthScreen
          mode={phase}
          variant="secrets"
          onSubmit={phase === 'setup' ? handleSetup : handleUnlock}
        />
      </div>
    )
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <Brand />
        {workspaceSwitcher}
        <div className="topbar-spacer" />
        <button
          type="button"
          className="btn btn-ghost"
          onClick={() => void handleLock()}
          title="Verrouiller le coffre de secrets (⌘L)"
        >
          <LockIcon size={16} /> Verrouiller
        </button>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => {
            setEditingProject(null)
            setProjectDialogOpen(true)
          }}
        >
          <PlusIcon size={16} /> Nouveau projet
        </button>
      </header>

      <div className="workspace">
        <aside className="sidebar">
          <div className="search">
            <SearchIcon size={16} className="search-icon" />
            <input
              ref={searchRef}
              className="search-input"
              value={projectSearch}
              onChange={(event) => setProjectSearch(event.target.value)}
              placeholder="Rechercher un projet…"
              aria-label="Rechercher un projet"
              spellCheck={false}
            />
            {projectSearch && (
              <button
                type="button"
                className="icon-btn search-clear"
                onClick={() => setProjectSearch('')}
                aria-label="Effacer"
              >
                <XIcon size={14} />
              </button>
            )}
          </div>

          <div className="entry-list" role="list" aria-label="Projets">
            {projects.length === 0 && (
              <div className="list-empty">
                <p>Aucun projet</p>
                <span>Créez un projet pour gérer ses variables .env et secrets CI/CD.</span>
              </div>
            )}

            {visibleProjects.map((project) => {
              const active = project.id === selectedProject?.id
              const totalVars = project.environments.reduce(
                (acc, env) => acc + env.variableCount,
                0,
              )
              return (
                <div
                  key={project.id}
                  role="listitem"
                  className={`entry ${active ? 'is-active' : ''}`}
                >
                  <button
                    type="button"
                    className="entry-main"
                    onClick={() => setSelectedProjectId(project.id)}
                    aria-current={active}
                  >
                    <span className="avatar custom">
                      {project.name.charAt(0).toUpperCase()}
                    </span>
                    <span className="entry-text">
                      <span className="entry-label">{project.name}</span>
                      <span className="entry-meta">
                        {project.environments.length} env · {totalVars} var
                        {project.remote ? ` · ${project.remote.provider}` : ''}
                      </span>
                    </span>
                  </button>
                </div>
              )
            })}
          </div>

          <footer className="sidebar-foot">
            <span className="foot-item">
              {projects.length} projet{projects.length > 1 ? 's' : ''}
            </span>
            <span className="foot-sep" aria-hidden="true" />
            <span className="foot-item">
              verrouillage auto · {Math.round(autoLockSeconds / 60)} min
            </span>
          </footer>
        </aside>

        <main className="detail secrets-main">
          {selectedProject ? (
            <div className="detail-card secrets-card">
              <div className="detail-head">
                <div className="avatar avatar-lg custom">
                  {selectedProject.name.charAt(0).toUpperCase()}
                </div>
                <div className="detail-title">
                  <h1>{selectedProject.name}</h1>
                  <p className="detail-sub">
                    {selectedProject.description && <span>{selectedProject.description} · </span>}
                    <span>Modifié {formatShortDate(selectedProject.updatedAt)}</span>
                    {selectedProject.remote && (
                      <span className="pill pill-google">
                        {selectedProject.remote.provider} : {selectedProject.remote.target}
                      </span>
                    )}
                  </p>
                </div>
                <div className="secret-actions">
                  <button
                    type="button"
                    className="icon-btn"
                    title="Modifier le projet"
                    onClick={() => {
                      setEditingProject(selectedProject)
                      setProjectDialogOpen(true)
                    }}
                  >
                    <EditIcon size={17} />
                  </button>
                  <button
                    type="button"
                    className="icon-btn icon-btn-danger"
                    title="Supprimer le projet"
                    onClick={() => void handleDeleteProject(selectedProject)}
                  >
                    <TrashIcon size={17} />
                  </button>
                </div>
              </div>

              {/* Onglets d'environnements */}
              <div className="env-bar">
                <div className="env-tabs" role="tablist" aria-label="Environnements">
                  {selectedProject.environments.map((env) => (
                    <button
                      key={env.name}
                      type="button"
                      role="tab"
                      aria-selected={env.name === selectedEnv}
                      className={`env-tab ${env.name === selectedEnv ? 'is-active' : ''}`}
                      onClick={() => setSelectedEnv(env.name)}
                    >
                      <span>{env.name}</span>
                      <span className="env-count">{env.variableCount}</span>
                    </button>
                  ))}
                  {addingEnv ? (
                    <span className="env-add-inline">
                      <input
                        className="input input-mono env-input"
                        value={newEnvName}
                        onChange={(event) => setNewEnvName(event.target.value)}
                        placeholder="nom-env"
                        autoFocus
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') void handleAddEnv()
                          if (event.key === 'Escape') setAddingEnv(false)
                        }}
                      />
                      <button
                        type="button"
                        className="btn btn-sm btn-primary"
                        onClick={() => void handleAddEnv()}
                      >
                        OK
                      </button>
                    </span>
                  ) : (
                    <button
                      type="button"
                      className="env-tab env-tab-add"
                      onClick={() => setAddingEnv(true)}
                      title="Ajouter un environnement"
                    >
                      <PlusIcon size={14} /> Env
                    </button>
                  )}
                </div>

                {selectedProject.environments.length > 1 && (
                  <button
                    type="button"
                    className="btn btn-sm btn-ghost"
                    onClick={() => void handleRemoveEnv(selectedEnv)}
                    title={`Supprimer l'environnement ${selectedEnv}`}
                  >
                    Supprimer « {selectedEnv} »
                  </button>
                )}
              </div>

              {/* Barre d'outils variables */}
              <div className="vars-toolbar">
                <div className="vars-search">
                  <SearchIcon size={15} className="search-icon" />
                  <input
                    className="search-input"
                    value={varSearch}
                    onChange={(event) => setVarSearch(event.target.value)}
                    placeholder={`Filtrer les clés de ${selectedEnv}…`}
                    spellCheck={false}
                  />
                </div>
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => setImportOpen(true)}
                >
                  <UploadIcon size={14} /> Importer .env
                </button>
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => setExportOpen(true)}
                >
                  <DownloadIcon size={14} /> Exporter
                </button>
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => setRemoteOpen(true)}
                >
                  <CloudIcon size={14} /> GitLab / GitHub
                </button>
                <button
                  type="button"
                  className="btn btn-sm btn-primary"
                  onClick={() => {
                    setEditingVar(null)
                    setEditingVarValue('')
                    setVarDialogOpen(true)
                  }}
                >
                  <PlusIcon size={14} /> Variable
                </button>
              </div>

              {/* Tableau des variables */}
              {visibleVariables.length === 0 ? (
                <div className="vars-empty">
                  <p>
                    {currentEnvMeta?.variableCount === 0
                      ? `Aucune variable dans « ${selectedEnv} »`
                      : 'Aucune clé ne correspond à ce filtre'}
                  </p>
                  <span>
                    Ajoutez une variable manuellement ou importez un fichier .env existant.
                  </span>
                </div>
              ) : (
                <div className="var-table" role="table" aria-label="Variables de l'environnement">
                  {visibleVariables.map((variable) => {
                    const isRevealed = variable.key in revealedValues
                    return (
                      <div key={variable.key} className="var-row" role="row">
                        <div className="var-key-col">
                          <span className="var-key input-mono">{variable.key}</span>
                          <div className="var-badges">
                            {variable.masked && <span className="pill pill-apple">masked</span>}
                            {variable.protected && (
                              <span className="pill pill-google">protected</span>
                            )}
                            {variable.type === 'file' && (
                              <span className="pill pill-custom">file</span>
                            )}
                          </div>
                        </div>

                        <div className="var-val-col input-mono">
                          {isRevealed ? (
                            <span className="var-val-revealed">
                              {revealedValues[variable.key]}
                            </span>
                          ) : (
                            <span className="var-val-masked">
                              •••••••••••• ({variable.length} car.)
                            </span>
                          )}
                        </div>

                        <div className="var-actions-col">
                          <button
                            type="button"
                            className="icon-btn"
                            onClick={() => void toggleRevealVar(variable.key)}
                            title={isRevealed ? 'Masquer' : 'Afficher'}
                            aria-label={isRevealed ? 'Masquer' : 'Afficher'}
                          >
                            {isRevealed ? <EyeOffIcon size={16} /> : <EyeIcon size={16} />}
                          </button>
                          <button
                            type="button"
                            className="icon-btn"
                            onClick={() => void handleCopyVar(variable.key)}
                            title="Copier la valeur"
                            aria-label={`Copier ${variable.key}`}
                          >
                            <CopyIcon size={16} />
                          </button>
                          <button
                            type="button"
                            className="icon-btn"
                            onClick={() => void openEditVariable(variable)}
                            title="Modifier"
                            aria-label={`Modifier ${variable.key}`}
                          >
                            <EditIcon size={16} />
                          </button>
                          <button
                            type="button"
                            className="icon-btn icon-btn-danger"
                            onClick={() => void handleRemoveVariable(variable.key)}
                            title="Supprimer"
                            aria-label={`Supprimer ${variable.key}`}
                          >
                            <TrashIcon size={16} />
                          </button>
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}

              <p className="hint">
                Astuce CLI : lancez votre application sans fichier .env sur disque avec{' '}
                <code>
                  robust-pwd secrets run {selectedProject.name} {selectedEnv} -- npm start
                </code>
              </p>
            </div>
          ) : (
            <div className="detail-empty">
              <div className="detail-orb">
                <CodeIcon size={26} />
              </div>
              <h2>Aucun projet sélectionné</h2>
              <p>
                Créez un projet pour stocker vos fichiers .env chiffrés et synchroniser vos
                secrets avec GitLab CI/CD ou GitHub Actions.
              </p>
              <div className="empty-actions">
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => {
                    setEditingProject(null)
                    setProjectDialogOpen(true)
                  }}
                >
                  <PlusIcon size={16} /> Créer un premier projet
                </button>
              </div>
            </div>
          )}
        </main>
      </div>

      <ProjectDialog
        open={projectDialogOpen}
        project={editingProject}
        onClose={() => setProjectDialogOpen(false)}
        onCreate={handleCreateProject}
        onRename={handleRenameProject}
      />

      {selectedProject && (
        <>
          <VariableDialog
            open={varDialogOpen}
            projectId={selectedProject.id}
            environment={selectedEnv}
            variable={editingVar}
            initialValue={editingVarValue}
            onClose={() => setVarDialogOpen(false)}
            onSave={handleSaveVariable}
            onGenerate={handleGenerateSecret}
          />

          <ImportEnvDialog
            open={importOpen}
            projectId={selectedProject.id}
            environment={selectedEnv}
            onClose={() => setImportOpen(false)}
            onPreview={handlePreviewDotenv}
            onImportText={handleImportText}
            onImportFile={handleImportFile}
          />

          <ExportEnvDialog
            open={exportOpen}
            environment={selectedEnv}
            onClose={() => setExportOpen(false)}
            onRenderText={handleRenderExport}
            onCopyRendered={(text) => void handleCopyRendered(text)}
            onSaveFile={handleSaveExportFile}
          />

          <RemoteSyncDialog
            open={remoteOpen}
            project={selectedProject}
            environment={selectedEnv}
            credentials={credentials}
            onClose={() => setRemoteOpen(false)}
            onLogin={async (
              provider: RemoteProviderName,
              token: string,
              host: string,
            ) => {
              const res = await secretsApi.loginRemote(provider, token, host)
              if (!res.ok) return { ok: false, error: res.error }
              setCredentials(res.data.credentials)
              return { ok: true, identity: res.data.identity }
            }}
            onLogout={async (provider: RemoteProviderName, host: string) => {
              const res = await secretsApi.logoutRemote(provider, host)
              if (!res.ok) return res.error
              setCredentials(res.data)
              return null
            }}
            onLink={async (
              provider: RemoteProviderName,
              target: string,
              host: string,
            ) => {
              const res = await secretsApi.linkRemote(
                selectedProject.id,
                provider,
                target,
                host,
              )
              if (!res.ok) return res.error
              replaceProject(res.data)
              return null
            }}
            onUnlink={async () => {
              const res = await secretsApi.unlinkRemote(selectedProject.id)
              if (!res.ok) return res.error
              replaceProject(res.data)
              return null
            }}
            onSetScope={async (scope: string | null) => {
              const res = await secretsApi.setRemoteScope(
                selectedProject.id,
                selectedEnv,
                scope,
              )
              if (!res.ok) return res.error
              replaceProject(res.data)
              return null
            }}
            onPlan={async (prune: boolean) => {
              const res = await secretsApi.planRemoteSync(
                selectedProject.id,
                selectedEnv,
                prune,
              )
              if (!res.ok) return { ok: false, error: res.error }
              return { ok: true, plan: res.data }
            }}
            onApply={async (prune: boolean) => {
              const res = await secretsApi.applyRemoteSync(
                selectedProject.id,
                selectedEnv,
                prune,
              )
              if (!res.ok) return { ok: false, error: res.error }
              return { ok: true, summary: res.data }
            }}
            onPull={async (overwrite: boolean) => {
              const res = await secretsApi.pullRemote(
                selectedProject.id,
                selectedEnv,
                overwrite,
              )
              if (!res.ok) return { ok: false, error: res.error }
              replaceProject(res.data.project)
              return { ok: true, summary: res.data.summary }
            }}
          />
        </>
      )}
    </div>
  )
}
