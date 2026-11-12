import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type {
  CreateProjectInput,
  DotenvExportFormat,
  RemoteProviderName,
  SecretsDesktopApi,
  UpsertVariableInput,
} from '../shared/secretsTypes'
import type {
  AddEntryInput,
  DesktopApi,
  GenerateRequest,
  IpcResult,
  LockReason,
} from '../shared/types'

const secretsApi: SecretsDesktopApi = {
  status: () => ipcRenderer.invoke('secrets:status'),
  createVault: (master: string) => ipcRenderer.invoke('secrets:create', master),
  unlock: (master: string) => ipcRenderer.invoke('secrets:unlock', master),
  lock: () => ipcRenderer.invoke('secrets:lock'),
  changePassword: (currentMaster: string, newMaster: string) =>
    ipcRenderer.invoke('secrets:passwd', currentMaster, newMaster),
  state: () => ipcRenderer.invoke('secrets:state'),

  addProject: (input: CreateProjectInput) => ipcRenderer.invoke('secrets:projects:add', input),
  renameProject: (projectId: number, name: string, description?: string) =>
    ipcRenderer.invoke('secrets:projects:rename', projectId, name, description),
  removeProject: (projectId: number) => ipcRenderer.invoke('secrets:projects:remove', projectId),

  addEnvironment: (projectId: number, envName: string) =>
    ipcRenderer.invoke('secrets:envs:add', projectId, envName),
  removeEnvironment: (projectId: number, envName: string) =>
    ipcRenderer.invoke('secrets:envs:remove', projectId, envName),

  upsertVariable: (input: UpsertVariableInput) => ipcRenderer.invoke('secrets:vars:upsert', input),
  removeVariable: (projectId: number, environment: string, key: string) =>
    ipcRenderer.invoke('secrets:vars:remove', projectId, environment, key),
  revealVariable: (projectId: number, environment: string, key: string) =>
    ipcRenderer.invoke('secrets:vars:reveal', projectId, environment, key),
  copyVariable: (projectId: number, environment: string, key: string) =>
    ipcRenderer.invoke('secrets:vars:copy', projectId, environment, key),
  generateSecret: (spec: string) => ipcRenderer.invoke('secrets:vars:generate', spec),

  previewDotenv: (text: string) => ipcRenderer.invoke('secrets:dotenv:preview', text),
  importDotenvText: (
    projectId: number,
    environment: string,
    text: string,
    overwrite: boolean,
  ) =>
    ipcRenderer.invoke('secrets:dotenv:import-text', projectId, environment, text, overwrite),
  importDotenvFile: (projectId: number, environment: string, overwrite: boolean) =>
    ipcRenderer.invoke('secrets:dotenv:import-file', projectId, environment, overwrite),
  exportDotenvText: (projectId: number, environment: string, format: DotenvExportFormat) =>
    ipcRenderer.invoke('secrets:dotenv:export-text', projectId, environment, format),
  exportDotenvFile: (projectId: number, environment: string, format: DotenvExportFormat) =>
    ipcRenderer.invoke('secrets:dotenv:export-file', projectId, environment, format),

  loginRemote: (provider: RemoteProviderName, token: string, host?: string) =>
    ipcRenderer.invoke('secrets:remote:login', provider, token, host),
  logoutRemote: (provider: RemoteProviderName, host?: string) =>
    ipcRenderer.invoke('secrets:remote:logout', provider, host),
  linkRemote: (
    projectId: number,
    provider: RemoteProviderName,
    target: string,
    host?: string,
  ) => ipcRenderer.invoke('secrets:remote:link', projectId, provider, target, host),
  unlinkRemote: (projectId: number) => ipcRenderer.invoke('secrets:remote:unlink', projectId),
  setRemoteScope: (projectId: number, environment: string, scope: string | null) =>
    ipcRenderer.invoke('secrets:remote:scope', projectId, environment, scope),
  planRemoteSync: (projectId: number, environment: string, prune: boolean) =>
    ipcRenderer.invoke('secrets:remote:plan', projectId, environment, prune),
  applyRemoteSync: (projectId: number, environment: string, prune: boolean) =>
    ipcRenderer.invoke('secrets:remote:apply', projectId, environment, prune),
  pullRemote: (projectId: number, environment: string, overwrite: boolean) =>
    ipcRenderer.invoke('secrets:remote:pull', projectId, environment, overwrite),

  touch: () => ipcRenderer.invoke('secrets:touch'),
  onLocked: (callback: (reason: LockReason) => void) => {
    const listener = (_event: IpcRendererEvent, reason: LockReason) => callback(reason)
    ipcRenderer.on('secrets:locked', listener)
    return () => {
      ipcRenderer.removeListener('secrets:locked', listener)
    }
  },
}

const api: DesktopApi = {
  platform: process.platform,

  status: () => ipcRenderer.invoke('vault:status'),
  createVault: (master: string) => ipcRenderer.invoke('vault:create', master),
  unlock: (master: string) => ipcRenderer.invoke('vault:unlock', master),
  lock: () => ipcRenderer.invoke('vault:lock'),
  list: () => ipcRenderer.invoke('vault:list'),

  add: (input: AddEntryInput) => ipcRenderer.invoke('vault:add', input),
  reveal: (id: number) => ipcRenderer.invoke('vault:reveal', id),
  remove: (id: number) => ipcRenderer.invoke('vault:remove', id),
  copyEntry: (id: number) => ipcRenderer.invoke('vault:copy-entry', id),
  copyText: (text: string) => ipcRenderer.invoke('vault:copy-text', text),

  generate: (request: GenerateRequest): Promise<IpcResult<string>> =>
    ipcRenderer.invoke('vault:generate', request),

  importFile: () => ipcRenderer.invoke('vault:import-file'),

  touch: () => ipcRenderer.invoke('vault:touch'),

  onLocked: (callback: (reason: LockReason) => void) => {
    const listener = (_event: IpcRendererEvent, reason: LockReason) => callback(reason)
    ipcRenderer.on('vault:locked', listener)
    return () => {
      ipcRenderer.removeListener('vault:locked', listener)
    }
  },

  secrets: secretsApi,
}

contextBridge.exposeInMainWorld('robustPwd', api)
