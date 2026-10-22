export type PasswordStyle = 'apple' | 'google' | 'custom'

export type GenerateStyle = 'apple' | 'google'

export type LockReason = 'idle' | 'manual' | 'quit'

export interface EntryMeta {
  id: number
  label: string
  style: PasswordStyle
  createdAt: string
  length: number
}

export interface VaultStatus {
  exists: boolean
  unlocked: boolean
  autoLockSeconds: number
}

export interface UnlockResult {
  entries: EntryMeta[]
  autoLockSeconds: number
}

export interface AddEntryInput {
  label: string
  password: string
  style: PasswordStyle
}

export interface ImportedPassword {
  label: string
  password: string
}

export interface ImportSummary {
  added: number
  skipped: number
  cancelled: boolean
}

export interface GenerateRequest {
  style: GenerateStyle
  length?: number
}

export type IpcResult<T> = { ok: true; data: T } | { ok: false; error: string }

export interface DesktopApi {
  platform: string
  status: () => Promise<IpcResult<VaultStatus>>
  createVault: (master: string) => Promise<IpcResult<UnlockResult>>
  unlock: (master: string) => Promise<IpcResult<UnlockResult>>
  lock: () => Promise<IpcResult<null>>
  list: () => Promise<IpcResult<EntryMeta[]>>
  add: (input: AddEntryInput) => Promise<IpcResult<EntryMeta>>
  reveal: (id: number) => Promise<IpcResult<string>>
  remove: (id: number) => Promise<IpcResult<null>>
  copyEntry: (id: number) => Promise<IpcResult<number>>
  copyText: (text: string) => Promise<IpcResult<number>>
  generate: (request: GenerateRequest) => Promise<IpcResult<string>>
  importFile: () => Promise<IpcResult<ImportSummary>>
  touch: () => Promise<void>
  onLocked: (callback: (reason: LockReason) => void) => () => void
}
