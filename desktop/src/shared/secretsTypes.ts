import type { IpcResult, LockReason, VaultStatus } from './types'

export type RemoteProviderName = 'gitlab' | 'github'

export type VariableType = 'env_var' | 'file'

export type DotenvExportFormat = 'dotenv' | 'shell' | 'json'

export type SyncAction = 'create' | 'update' | 'overwrite' | 'delete' | 'keep' | 'unchanged'

export type SecretGeneratorSpec = 'hex:32' | 'hex:16' | 'base64:32' | 'uuid' | 'google:32'

export interface RemoteLink {
  provider: RemoteProviderName
  host: string
  target: string
}

export interface VariableMeta {
  key: string
  length: number
  masked: boolean
  protected: boolean
  raw: boolean
  type: VariableType
  updatedAt: string
}

export interface EnvironmentMeta {
  name: string
  remoteScope: string | null
  variableCount: number
  variables: VariableMeta[]
}

export interface ProjectMeta {
  id: number
  name: string
  description: string
  createdAt: string
  updatedAt: string
  remote: RemoteLink | null
  environments: EnvironmentMeta[]
}

export interface CredentialMeta {
  provider: RemoteProviderName
  host: string
  addedAt: string
}

export interface SecretsState {
  projects: ProjectMeta[]
  credentials: CredentialMeta[]
  autoLockSeconds: number
}

export interface CreateProjectInput {
  name: string
  description?: string
  environments?: string[]
}

export interface UpsertVariableInput {
  projectId: number
  environment: string
  key: string
  value: string
  masked?: boolean
  protected?: boolean
  raw?: boolean
  type?: VariableType
}

export interface DotenvPreview {
  variables: Array<{ key: string; length: number }>
  duplicates: string[]
  invalidLines: number[]
}

export interface DotenvImportSummary {
  added: number
  updated: number
  skipped: number
  duplicates: string[]
  invalidLines: number[]
  cancelled: boolean
}

export interface DotenvExportFileSummary {
  path: string
  gitIgnored: boolean | null
  cancelled: boolean
}

export interface SyncPlanItem {
  key: string
  action: SyncAction
  masked: boolean
  protected: boolean
  raw: boolean
  type: VariableType
}

export interface SyncPlanCounts {
  create: number
  update: number
  overwrite: number
  delete: number
  keep: number
  unchanged: number
}

export interface SyncPlan {
  provider: RemoteProviderName
  target: string
  environment: string
  scope: string
  canReadValues: boolean
  items: SyncPlanItem[]
  errors: string[]
  counts: SyncPlanCounts
}

export interface SyncApplySummary {
  created: number
  updated: number
  deleted: number
}

export interface PullSummary {
  added: number
  updated: number
  skipped: number
}

export interface SecretsDesktopApi {
  status: () => Promise<IpcResult<VaultStatus>>
  createVault: (master: string) => Promise<IpcResult<SecretsState>>
  unlock: (master: string) => Promise<IpcResult<SecretsState>>
  lock: () => Promise<IpcResult<null>>
  changePassword: (currentMaster: string, newMaster: string) => Promise<IpcResult<null>>
  state: () => Promise<IpcResult<SecretsState>>

  addProject: (input: CreateProjectInput) => Promise<IpcResult<ProjectMeta>>
  renameProject: (
    projectId: number,
    name: string,
    description?: string,
  ) => Promise<IpcResult<ProjectMeta>>
  removeProject: (projectId: number) => Promise<IpcResult<null>>

  addEnvironment: (projectId: number, envName: string) => Promise<IpcResult<ProjectMeta>>
  removeEnvironment: (projectId: number, envName: string) => Promise<IpcResult<ProjectMeta>>

  upsertVariable: (input: UpsertVariableInput) => Promise<IpcResult<ProjectMeta>>
  removeVariable: (
    projectId: number,
    environment: string,
    key: string,
  ) => Promise<IpcResult<ProjectMeta>>
  revealVariable: (
    projectId: number,
    environment: string,
    key: string,
  ) => Promise<IpcResult<string>>
  copyVariable: (
    projectId: number,
    environment: string,
    key: string,
  ) => Promise<IpcResult<number>>
  generateSecret: (spec: string) => Promise<IpcResult<string>>

  previewDotenv: (text: string) => Promise<IpcResult<DotenvPreview>>
  importDotenvText: (
    projectId: number,
    environment: string,
    text: string,
    overwrite: boolean,
  ) => Promise<IpcResult<DotenvImportSummary>>
  importDotenvFile: (
    projectId: number,
    environment: string,
    overwrite: boolean,
  ) => Promise<IpcResult<DotenvImportSummary>>
  exportDotenvText: (
    projectId: number,
    environment: string,
    format: DotenvExportFormat,
  ) => Promise<IpcResult<string>>
  exportDotenvFile: (
    projectId: number,
    environment: string,
    format: DotenvExportFormat,
  ) => Promise<IpcResult<DotenvExportFileSummary>>

  loginRemote: (
    provider: RemoteProviderName,
    token: string,
    host?: string,
  ) => Promise<IpcResult<{ identity: string; credentials: CredentialMeta[] }>>
  logoutRemote: (
    provider: RemoteProviderName,
    host?: string,
  ) => Promise<IpcResult<CredentialMeta[]>>
  linkRemote: (
    projectId: number,
    provider: RemoteProviderName,
    target: string,
    host?: string,
  ) => Promise<IpcResult<ProjectMeta>>
  unlinkRemote: (projectId: number) => Promise<IpcResult<ProjectMeta>>
  setRemoteScope: (
    projectId: number,
    environment: string,
    scope: string | null,
  ) => Promise<IpcResult<ProjectMeta>>
  planRemoteSync: (
    projectId: number,
    environment: string,
    prune: boolean,
  ) => Promise<IpcResult<SyncPlan>>
  applyRemoteSync: (
    projectId: number,
    environment: string,
    prune: boolean,
  ) => Promise<IpcResult<SyncApplySummary>>
  pullRemote: (
    projectId: number,
    environment: string,
    overwrite: boolean,
  ) => Promise<IpcResult<{ project: ProjectMeta; summary: PullSummary }>>

  touch: () => Promise<void>
  onLocked: (callback: (reason: LockReason) => void) => () => void
}

