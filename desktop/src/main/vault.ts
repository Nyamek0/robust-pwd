import { EventEmitter } from 'node:events'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type {
  AddEntryInput,
  EntryMeta,
  ImportedPassword,
  LockReason,
  PasswordStyle,
} from '../shared/types'
import { createSalt, decryptWithMaster, deriveKey, encryptWithKey, VaultError } from './crypto'
import { MAX_IMPORT_ENTRIES } from './importer'

export const AUTO_LOCK_MS = 5 * 60 * 1000
export const MIN_MASTER_LENGTH = 8
const MAX_MASTER_LENGTH = 1024
const MAX_LABEL_LENGTH = 80
const MAX_PASSWORD_LENGTH = 256
const MIN_PASSWORD_LENGTH = 4

interface EntryRecord {
  id: number
  label: string
  password: string
  style: PasswordStyle
  created_at: string
}

interface VaultFile {
  entries: EntryRecord[]
}

export function defaultVaultPath(): string {
  return process.env.ROBUST_PWD_VAULT?.trim() || join(homedir(), '.robust-pwd', 'vault.enc')
}

/**
 * Coffre local compatible octet pour octet avec pwdgen.py.
 *
 * L'état déchiffré ne quitte jamais ce module : l'interface ne reçoit que les
 * métadonnées, et le mot de passe d'une entrée sur demande explicite.
 */
export class VaultService extends EventEmitter {
  private key: Buffer | null = null
  private salt: Buffer | null = null
  private data: VaultFile | null = null
  private idleTimer: ReturnType<typeof setTimeout> | null = null

  constructor(
    readonly vaultPath: string = defaultVaultPath(),
    private readonly autoLockMs: number = AUTO_LOCK_MS,
  ) {
    super()
  }

  get unlocked(): boolean {
    return this.data !== null
  }

  exists(): boolean {
    return existsSync(this.vaultPath)
  }

  status(): { exists: boolean; unlocked: boolean; autoLockSeconds: number } {
    return {
      exists: this.exists(),
      unlocked: this.unlocked,
      autoLockSeconds: Math.round(this.autoLockMs / 1000),
    }
  }

  async create(master: string): Promise<EntryMeta[]> {
    if (this.exists()) {
      throw new VaultError('EXISTS', 'Un coffre existe déjà à cet emplacement.')
    }
    const clean = validateMaster(master)
    const salt = createSalt()
    const key = await deriveKey(clean, salt)

    this.key = key
    this.salt = salt
    this.data = { entries: [] }
    this.persist()
    this.scheduleAutoLock()
    return []
  }

  async unlock(master: string): Promise<EntryMeta[]> {
    if (!this.exists()) {
      throw new VaultError('NO_VAULT', 'Aucun coffre trouvé. Créez-en un d’abord.')
    }
    if (typeof master !== 'string' || master.length === 0) {
      throw new VaultError('BAD_MASTER', 'Mot de passe maître incorrect.')
    }
    if (master.length > MAX_MASTER_LENGTH) {
      throw new VaultError('BAD_MASTER', 'Mot de passe maître incorrect.')
    }

    let blob: Buffer
    try {
      blob = readFileSync(this.vaultPath)
    } catch {
      throw new VaultError('CORRUPT', 'Impossible de lire le fichier du coffre.')
    }

    const { plaintext, key, salt } = await decryptWithMaster(blob, master)

    let parsed: unknown
    try {
      parsed = JSON.parse(plaintext.toString('utf8'))
    } catch {
      key.fill(0)
      throw new VaultError('CORRUPT', 'Le contenu du coffre est illisible.')
    }

    let file: VaultFile
    try {
      file = parseVaultFile(parsed)
    } catch {
      key.fill(0)
      throw new VaultError('CORRUPT', 'Le contenu du coffre est invalide.')
    }

    this.key = key
    this.salt = salt
    this.data = file
    this.scheduleAutoLock()
    return this.list()
  }

  lock(reason: LockReason = 'manual'): void {
    this.clearAutoLock()
    if (this.key) this.key.fill(0)
    this.key = null
    this.salt = null
    this.data = null
    this.emit('locked', reason)
  }

  /** Prolonge le verrouillage automatique après une interaction utilisateur. */
  touch(): void {
    if (this.unlocked) this.scheduleAutoLock()
  }

  list(): EntryMeta[] {
    return this.requireData()
      .entries.map(toMeta)
      .sort((a, b) => b.id - a.id)
  }

  async add(input: AddEntryInput): Promise<EntryMeta> {
    const data = this.requireData()
    const label = typeof input?.label === 'string' ? input.label.trim() : ''
    if (!label || label.length > MAX_LABEL_LENGTH) {
      throw new VaultError('INVALID', `Le mot clé est obligatoire (${MAX_LABEL_LENGTH} caractères max).`)
    }

    if (
      typeof input?.password !== 'string' ||
      input.password.length < MIN_PASSWORD_LENGTH ||
      input.password.length > MAX_PASSWORD_LENGTH
    ) {
      throw new VaultError('INVALID', 'Mot de passe invalide.')
    }

    if (!isPasswordStyle(input.style)) {
      throw new VaultError('INVALID', 'Style de mot de passe invalide.')
    }

    const entry: EntryRecord = {
      id: nextId(data),
      label,
      password: input.password,
      style: input.style,
      created_at: localIsoTimestamp(),
    }

    data.entries.push(entry)
    this.persist()
    this.touch()
    return toMeta(entry)
  }

  reveal(id: number): string {
    const entry = this.findEntry(id)
    this.touch()
    return entry.password
  }

  /**
   * Importe des mots de passe existants en une seule écriture atomique.
   * Les doublons (même libellé + même mot de passe) et les entrées invalides
   * sont ignorés et comptés.
   */
  importMany(entries: ImportedPassword[]): { added: number; skipped: number } {
    const data = this.requireData()
    if (!Array.isArray(entries) || entries.length === 0) {
      throw new VaultError('INVALID', 'Aucune entrée à importer.')
    }
    if (entries.length > MAX_IMPORT_ENTRIES) {
      throw new VaultError('INVALID', `${MAX_IMPORT_ENTRIES} entrées maximum par import.`)
    }

    const known = new Set(
      data.entries.map((entry) => `${entry.label.toLowerCase()}\u0000${entry.password}`),
    )
    const createdAt = localIsoTimestamp()
    let nextIdentifier = nextId(data)
    let added = 0
    let skipped = 0

    for (const candidate of entries) {
      const label = typeof candidate?.label === 'string' ? candidate.label.trim() : ''
      const password = typeof candidate?.password === 'string' ? candidate.password : ''

      if (
        !label ||
        label.length > MAX_LABEL_LENGTH ||
        !password ||
        password.length > MAX_PASSWORD_LENGTH
      ) {
        skipped += 1
        continue
      }

      const key = `${label.toLowerCase()}\u0000${password}`
      if (known.has(key)) {
        skipped += 1
        continue
      }
      known.add(key)

      data.entries.push({
        id: nextIdentifier,
        label,
        password,
        style: 'custom',
        created_at: createdAt,
      })
      nextIdentifier += 1
      added += 1
    }

    if (added > 0) {
      this.persist()
      this.touch()
    }

    return { added, skipped }
  }

  remove(id: number): void {
    const data = this.requireData()
    const entry = this.findEntry(id)
    data.entries = data.entries.filter((candidate) => candidate.id !== entry.id)
    this.persist()
    this.touch()
  }

  private findEntry(id: number): EntryRecord {
    if (!Number.isInteger(id)) {
      throw new VaultError('INVALID', 'Identifiant invalide.')
    }
    const entry = this.requireData().entries.find((candidate) => candidate.id === id)
    if (!entry) {
      throw new VaultError('NOT_FOUND', 'Cette entrée n’existe plus.')
    }
    return entry
  }

  private requireData(): VaultFile {
    if (!this.data) {
      throw new VaultError('LOCKED', 'Le coffre est verrouillé.')
    }
    return this.data
  }

  private persist(): void {
    const data = this.requireData()
    if (!this.key || !this.salt) {
      throw new VaultError('LOCKED', 'Le coffre est verrouillé.')
    }

    const directory = dirname(this.vaultPath)
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    trySetMode(directory, 0o700)

    // On conserve le sel de la session : la clé est déjà dérivée, et le nonce
    // reste aléatoire à chaque écriture (indispensable pour AES-GCM).
    const blob = encryptWithKey(Buffer.from(JSON.stringify(data), 'utf8'), this.key, this.salt)

    const temporary = `${this.vaultPath}.${process.pid}.tmp`
    writeFileSync(temporary, blob, { mode: 0o600 })
    renameSync(temporary, this.vaultPath)
    trySetMode(this.vaultPath, 0o600)
  }

  private scheduleAutoLock(): void {
    this.clearAutoLock()
    if (this.autoLockMs <= 0) return
    this.idleTimer = setTimeout(() => this.lock('idle'), this.autoLockMs)
    this.idleTimer.unref?.()
  }

  private clearAutoLock(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer)
      this.idleTimer = null
    }
  }
}

function validateMaster(master: string): string {  if (typeof master !== 'string' || master.length < MIN_MASTER_LENGTH) {
    throw new VaultError(
      'WEAK_MASTER',
      `Le mot de passe maître doit contenir au moins ${MIN_MASTER_LENGTH} caractères.`,
    )
  }
  if (master.length > MAX_MASTER_LENGTH) {
    throw new VaultError('INVALID', 'Mot de passe maître trop long.')
  }
  return master
}

function nextId(data: VaultFile): number {
  return Math.max(0, ...data.entries.map((entry) => entry.id)) + 1
}

function isPasswordStyle(value: unknown): value is PasswordStyle {
  return value === 'apple' || value === 'google' || value === 'custom'
}

function toMeta(entry: EntryRecord): EntryMeta {
  return {
    id: entry.id,
    label: entry.label,
    style: entry.style,
    createdAt: entry.created_at,
    length: entry.password.length,
  }
}

function parseVaultFile(raw: unknown): VaultFile {
  if (!raw || typeof raw !== 'object' || !Array.isArray((raw as { entries?: unknown }).entries)) {
    throw new Error('invalid vault')
  }

  const entries = (raw as { entries: unknown[] }).entries.map((candidate) => {
    const entry = candidate as Partial<EntryRecord> | null
    if (
      !entry ||
      !Number.isInteger(entry.id) ||
      typeof entry.label !== 'string' ||
      typeof entry.password !== 'string' ||
      !isPasswordStyle(entry.style)
    ) {
      throw new Error('invalid entry')
    }
    return {
      id: entry.id as number,
      label: entry.label,
      password: entry.password,
      style: entry.style,
      created_at: typeof entry.created_at === 'string' ? entry.created_at : localIsoTimestamp(),
    }
  })

  return { entries }
}

/** Horodatage local au format de `datetime.isoformat(timespec="seconds")`. */
export function localIsoTimestamp(date: Date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  )
}

function trySetMode(path: string, mode: number): void {
  try {
    chmodSync(path, mode)
  } catch {
    // Systèmes de fichiers sans permissions POSIX (Windows) : on ignore.
  }
}
