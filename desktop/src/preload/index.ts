import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type {
  AddEntryInput,
  DesktopApi,
  GenerateRequest,
  IpcResult,
  LockReason,
} from '../shared/types'

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
}

contextBridge.exposeInMainWorld('robustPwd', api)
