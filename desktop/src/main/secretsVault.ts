/**
 * Coffre local de secrets applicatifs (`~/.robust-pwd/secrets.enc`),
 * compatible octet pour octet avec `robust_pwd/secrets_vault.py` (voir `docs/secrets-format.md`).
 *
 * Les valeurs des variables et les jetons des fournisseurs ne quittent jamais ce module
 * vers le renderer sans action explicite (`revealVariable`, `copyVariable`).
 */

import { EventEmitter } from 'node:events'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type {
  CreateProjectInput,
  CredentialMeta,
  EnvironmentMeta,
  ProjectMeta,
  RemoteLink,
  RemoteProviderName,
  SecretsState,
  UpsertVariableInput,
  VariableMeta,
  VariableType,
} from '../shared/secretsTypes'
import type { LockReason } from '../shared/types'
import { createSalt, decryptWithMaster, deriveKey, encryptWithKey, VaultError } from './crypto'
import type { DotenvVariable } from './dotenv'
import { AUTO_LOCK_MS, localIsoTimestamp, MIN_MASTER_LENGTH } from './vault'

export const SECRETS_KIND = 'robust-pwd/secrets'
export const SECRETS_VERSION = 1

const MAX_MASTER_LENGTH = 1024
const MAX_VAULT_BYTES = 10 * 1024 * 1024
const MAX_PROJECTS = 200
const MAX_ENVIRONMENTS = 20
const MAX_VARIABLES = 1000
const MAX_DESCRIPTION_LENGTH = 200
const MAX_VALUE_LENGTH = 65_536
const MAX_SCOPE_LENGTH = 255
const MAX_TOKEN_LENGTH = 512

export const DEFAULT_ENVIRONMENTS = ['local', 'staging', 'production'] as const
export const DEFAULT_HOSTS: Record<RemoteProviderName, string> = {
  gitlab: 'https://gitlab.com',
  github: 'https://api.github.com',
}

const PROJECT_NAME_RE = /^[A-Za-z0-9._-]{1,64}$/
const ENV_NAME_RE = /^[a-z0-9._-]{1,32}$/
const VAR_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]{0,254}$/
const TARGET_RE = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+$/

export interface VariableRecord {
  key: string
  value: string
  masked: boolean
  protected: boolean
  raw: boolean
  type: VariableType
  updated_at: string
  [extra: string]: unknown
}

export interface EnvironmentRecord {
  name: string
  remote_scope: string | null
  variables: VariableRecord[]
  [extra: string]: unknown
}

export interface RemoteRecord {
  provider: RemoteProviderName
  host: string
  target: string
  [extra: string]: unknown
}

export interface ProjectRecord {
  id: number
  name: string
  description: string
  created_at: string
  updated_at: string
  remote: RemoteRecord | null
  environments: EnvironmentRecord[]
  [extra: string]: unknown
}

export interface CredentialRecord {
  provider: RemoteProviderName
  host: string
  token: string
  added_at: string
  [extra: string]: unknown
}

export interface SecretsVaultFile {
  kind: typeof SECRETS_KIND
  version: typeof SECRETS_VERSION
  projects: ProjectRecord[]
  credentials: CredentialRecord[]
  [extra: string]: unknown
}

export function defaultSecretsVaultPath(): string {
  return (
    process.env.ROBUST_PWD_SECRETS_VAULT?.trim() || join(homedir(), '.robust-pwd', 'secrets.enc')
  )
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export function validateMaster(master: string): string {
  if (typeof master !== 'string' || master.length < MIN_MASTER_LENGTH) {
    throw new VaultError(
      'WEAK_MASTER',
      `Le mot de passe maître doit contenir au moins ${MIN_MASTER_LENGTH} caractères.`,
    )
  }
  if (master.length > MAX_MASTER_LENGTH) {
    throw new VaultError('INVALID', 'Le mot de passe maître est trop long.')
  }
  return master
}

export function validateProjectName(name: string): string {
  const clean = typeof name === 'string' ? name.trim() : ''
  if (!PROJECT_NAME_RE.test(clean)) {
    throw new VaultError(
      'INVALID',
      'Nom de projet invalide (1–64 caractères parmi A-Z, a-z, 0-9, ., _, -).',
    )
  }
  return clean
}

export function validateEnvName(name: string): string {
  const clean = typeof name === 'string' ? name.trim() : ''
  if (!ENV_NAME_RE.test(clean)) {
    throw new VaultError(
      'INVALID',
      'Nom d’environnement invalide (1–32 caractères parmi a-z, 0-9, ., _, -).',
    )
  }
  return clean
}

export function validateVarKey(key: string): string {
  const clean = typeof key === 'string' ? key.trim() : ''
  if (!VAR_KEY_RE.test(clean)) {
    throw new VaultError(
      'INVALID',
      'Clé de variable invalide (lettres, chiffres et _, ne commence pas par un chiffre).',
    )
  }
  return clean
}

export function validateVarValue(value: string): string {
  if (typeof value !== 'string') {
    throw new VaultError('INVALID', 'Valeur de variable invalide.')
  }
  if (value.length > MAX_VALUE_LENGTH) {
    throw new VaultError('INVALID', `La valeur dépasse la limite de ${MAX_VALUE_LENGTH} caractères.`)
  }
  return value
}

export function validateProvider(provider: unknown): RemoteProviderName {
  const clean = typeof provider === 'string' ? provider.trim().toLowerCase() : ''
  if (clean === 'gitlab' || clean === 'github') return clean
  throw new VaultError(
    'INVALID',
    `Fournisseur inconnu : « ${String(provider)} » (attendu : gitlab, github).`,
  )
}

export function normalizeHost(host: string | undefined | null, provider: RemoteProviderName): string {
  const raw = (host ?? '').trim().replace(/\/+$/, '') || DEFAULT_HOSTS[provider]
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    throw new VaultError('INVALID', 'L’hôte distant doit être une URL HTTPS valide.')
  }
  if (parsed.protocol !== 'https:' || !parsed.host || parsed.search || parsed.hash) {
    throw new VaultError('INVALID', 'L’hôte distant doit être une URL HTTPS valide.')
  }
  return raw
}

export function validateRemoteTarget(target: string, provider: RemoteProviderName): string {
  const clean = typeof target === 'string' ? target.trim().replace(/^\/+|\/+$/g, '') : ''
  if (!TARGET_RE.test(clean)) {
    throw new VaultError('INVALID', 'Cible distante invalide (attendu : groupe/projet ou owner/repo).')
  }
  if (provider === 'github' && clean.split('/').length !== 2) {
    throw new VaultError('INVALID', 'Un dépôt GitHub s’écrit « propriétaire/dépôt ».')
  }
  return clean
}

export function validateRemoteScope(scope: string | null | undefined): string | null {
  if (scope === null || scope === undefined) return null
  if (typeof scope !== 'string') {
    throw new VaultError('INVALID', 'Portée distante invalide.')
  }
  const clean = scope.trim()
  if (!clean || clean.toLowerCase() === 'none') return null
  if (clean.length > MAX_SCOPE_LENGTH) {
    throw new VaultError('INVALID', 'Portée distante trop longue.')
  }
  return clean
}

function isVariableType(value: unknown): value is VariableType {
  return value === 'env_var' || value === 'file'
}

// ---------------------------------------------------------------------------
// Service principal
// ---------------------------------------------------------------------------

export class SecretsService extends EventEmitter {
  private key: Buffer | null = null
  private salt: Buffer | null = null
  private data: SecretsVaultFile | null = null
  private idleTimer: ReturnType<typeof setTimeout> | null = null

  constructor(
    readonly vaultPath: string = defaultSecretsVaultPath(),
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

  state(): SecretsState {
    const data = this.requireData()
    return {
      projects: data.projects.map(toProjectMeta),
      credentials: data.credentials.map(toCredentialMeta),
      autoLockSeconds: Math.round(this.autoLockMs / 1000),
    }
  }

  async create(master: string): Promise<SecretsState> {
    if (this.exists()) {
      throw new VaultError('EXISTS', 'Un coffre de secrets existe déjà à cet emplacement.')
    }
    const clean = validateMaster(master)
    const salt = createSalt()
    const key = await deriveKey(clean, salt)

    this.key = key
    this.salt = salt
    this.data = {
      kind: SECRETS_KIND,
      version: SECRETS_VERSION,
      projects: [],
      credentials: [],
    }
    this.persist()
    this.scheduleAutoLock()
    return this.state()
  }

  async unlock(master: string): Promise<SecretsState> {
    if (!this.exists()) {
      throw new VaultError('NO_VAULT', 'Aucun coffre de secrets trouvé. Créez-en un d’abord.')
    }
    if (typeof master !== 'string' || master.length === 0 || master.length > MAX_MASTER_LENGTH) {
      throw new VaultError('BAD_MASTER', 'Mot de passe maître incorrect.')
    }

    let blob: Buffer
    try {
      blob = readFileSync(this.vaultPath)
    } catch {
      throw new VaultError('CORRUPT', 'Impossible de lire le fichier du coffre de secrets.')
    }
    if (blob.length > MAX_VAULT_BYTES) {
      throw new VaultError('CORRUPT', 'Le fichier du coffre de secrets dépasse la taille maximale.')
    }

    const { plaintext, key, salt } = await decryptWithMaster(blob, master)

    let parsed: unknown
    try {
      parsed = JSON.parse(plaintext.toString('utf8'))
    } catch {
      key.fill(0)
      throw new VaultError('CORRUPT', 'Le contenu du coffre de secrets est illisible.')
    }

    let file: SecretsVaultFile
    try {
      file = parseSecretsVaultFile(parsed)
    } catch (error) {
      key.fill(0)
      if (error instanceof VaultError) throw error
      throw new VaultError('CORRUPT', 'Le contenu du coffre de secrets est invalide.')
    }

    this.key = key
    this.salt = salt
    this.data = file
    this.scheduleAutoLock()
    return this.state()
  }

  async changePassword(currentMaster: string, newMaster: string): Promise<void> {
    const data = this.requireData()
    const cleanNew = validateMaster(newMaster)
    let blob: Buffer
    try {
      blob = readFileSync(this.vaultPath)
    } catch {
      throw new VaultError('CORRUPT', 'Impossible de lire le fichier du coffre de secrets.')
    }
    const { key: verifiedKey } = await decryptWithMaster(blob, currentMaster)
    verifiedKey.fill(0)

    const newSalt = createSalt()
    const newKey = await deriveKey(cleanNew, newSalt)
    if (this.key) this.key.fill(0)
    this.key = newKey
    this.salt = newSalt
    this.data = data
    this.persist()
    this.touch()
  }

  lock(reason: LockReason = 'manual'): void {
    this.clearAutoLock()
    if (this.key) this.key.fill(0)
    this.key = null
    this.salt = null
    this.data = null
    this.emit('locked', reason)
  }

  touch(): void {
    if (this.unlocked) this.scheduleAutoLock()
  }

  // -------------------------------------------------------------------------
  // Projets et environnements
  // -------------------------------------------------------------------------

  addProject(input: CreateProjectInput): ProjectMeta {
    const data = this.requireData()
    const name = validateProjectName(input?.name ?? '')
    if (data.projects.some((p) => p.name === name)) {
      throw new VaultError('EXISTS', `Un projet « ${name} » existe déjà.`)
    }
    if (data.projects.length >= MAX_PROJECTS) {
      throw new VaultError('INVALID', `Limite de ${MAX_PROJECTS} projets atteinte.`)
    }
    const description = typeof input?.description === 'string' ? input.description.trim() : ''
    if (description.length > MAX_DESCRIPTION_LENGTH) {
      throw new VaultError('INVALID', `Description trop longue (${MAX_DESCRIPTION_LENGTH} caractères max).`)
    }

    const rawEnvs =
      Array.isArray(input?.environments) && input.environments.length > 0
        ? input.environments
        : [...DEFAULT_ENVIRONMENTS]
    if (rawEnvs.length > MAX_ENVIRONMENTS) {
      throw new VaultError('INVALID', `Maximum ${MAX_ENVIRONMENTS} environnements par projet.`)
    }
    const seen = new Set<string>()
    const environments: EnvironmentRecord[] = []
    for (const raw of rawEnvs) {
      const ename = validateEnvName(raw)
      if (seen.has(ename)) continue
      seen.add(ename)
      environments.push({ name: ename, remote_scope: null, variables: [] })
    }

    const now = localIsoTimestamp()
    const nextId = Math.max(0, ...data.projects.map((p) => p.id)) + 1
    const project: ProjectRecord = {
      id: nextId,
      name,
      description,
      created_at: now,
      updated_at: now,
      remote: null,
      environments,
    }
    data.projects.push(project)
    this.persist()
    this.touch()
    return toProjectMeta(project)
  }

  renameProject(projectId: number, newName: string, description?: string): ProjectMeta {
    const data = this.requireData()
    const project = this.findProject(projectId)
    const cleanName = validateProjectName(newName)
    if (
      cleanName !== project.name &&
      data.projects.some((candidate) => candidate.name === cleanName)
    ) {
      throw new VaultError('EXISTS', `Un projet « ${cleanName} » existe déjà.`)
    }
    project.name = cleanName
    if (description !== undefined) {
      const cleanDesc = typeof description === 'string' ? description.trim() : ''
      if (cleanDesc.length > MAX_DESCRIPTION_LENGTH) {
        throw new VaultError('INVALID', `Description trop longue (${MAX_DESCRIPTION_LENGTH} caractères max).`)
      }
      project.description = cleanDesc
    }
    project.updated_at = localIsoTimestamp()
    this.persist()
    this.touch()
    return toProjectMeta(project)
  }

  removeProject(projectId: number): void {
    const data = this.requireData()
    const project = this.findProject(projectId)
    data.projects = data.projects.filter((candidate) => candidate.id !== project.id)
    this.persist()
    this.touch()
  }

  addEnvironment(projectId: number, envName: string): ProjectMeta {
    const project = this.findProject(projectId)
    const cleanEnv = validateEnvName(envName)
    if (project.environments.some((e) => e.name === cleanEnv)) {
      throw new VaultError('EXISTS', `L’environnement « ${cleanEnv} » existe déjà.`)
    }
    if (project.environments.length >= MAX_ENVIRONMENTS) {
      throw new VaultError('INVALID', `Limite de ${MAX_ENVIRONMENTS} environnements atteinte.`)
    }
    project.environments.push({ name: cleanEnv, remote_scope: null, variables: [] })
    project.updated_at = localIsoTimestamp()
    this.persist()
    this.touch()
    return toProjectMeta(project)
  }

  removeEnvironment(projectId: number, envName: string): ProjectMeta {
    const project = this.findProject(projectId)
    const env = this.findEnvironment(project, envName)
    project.environments = project.environments.filter((e) => e.name !== env.name)
    project.updated_at = localIsoTimestamp()
    this.persist()
    this.touch()
    return toProjectMeta(project)
  }

  // -------------------------------------------------------------------------
  // Variables
  // -------------------------------------------------------------------------

  upsertVariable(input: UpsertVariableInput): ProjectMeta {
    const project = this.findProject(input?.projectId)
    const env = this.findEnvironment(project, input?.environment)
    const key = validateVarKey(input?.key)
    const value = validateVarValue(input?.value)
    const varType = input?.type ?? 'env_var'
    if (!isVariableType(varType)) {
      throw new VaultError('INVALID', `Type de variable invalide : ${String(varType)}`)
    }

    const now = localIsoTimestamp()
    const existing = env.variables.find((v) => v.key === key)
    if (existing) {
      existing.value = value
      if (input.masked !== undefined) existing.masked = Boolean(input.masked)
      if (input.protected !== undefined) existing.protected = Boolean(input.protected)
      if (input.raw !== undefined) existing.raw = Boolean(input.raw)
      if (input.type !== undefined) existing.type = varType
      existing.updated_at = now
    } else {
      if (env.variables.length >= MAX_VARIABLES) {
        throw new VaultError('INVALID', `Limite de ${MAX_VARIABLES} variables atteinte.`)
      }
      env.variables.push({
        key,
        value,
        masked: Boolean(input.masked ?? false),
        protected: Boolean(input.protected ?? false),
        raw: Boolean(input.raw ?? true),
        type: varType,
        updated_at: now,
      })
    }
    project.updated_at = now
    this.persist()
    this.touch()
    return toProjectMeta(project)
  }

  removeVariable(projectId: number, envName: string, key: string): ProjectMeta {
    const project = this.findProject(projectId)
    const env = this.findEnvironment(project, envName)
    const cleanKey = validateVarKey(key)
    const exists = env.variables.some((v) => v.key === cleanKey)
    if (!exists) {
      throw new VaultError('NOT_FOUND', `Variable « ${cleanKey} » introuvable.`)
    }
    env.variables = env.variables.filter((v) => v.key !== cleanKey)
    project.updated_at = localIsoTimestamp()
    this.persist()
    this.touch()
    return toProjectMeta(project)
  }

  revealVariable(projectId: number, envName: string, key: string): string {
    const project = this.findProject(projectId)
    const env = this.findEnvironment(project, envName)
    const cleanKey = validateVarKey(key)
    const found = env.variables.find((v) => v.key === cleanKey)
    if (!found) {
      throw new VaultError('NOT_FOUND', `Variable « ${cleanKey} » introuvable.`)
    }
    this.touch()
    return found.value
  }

  getVariablesRaw(projectId: number, envName: string): VariableRecord[] {
    const project = this.findProject(projectId)
    const env = this.findEnvironment(project, envName)
    this.touch()
    return env.variables.map((v) => ({ ...v }))
  }

  importVariables(
    projectId: number,
    envName: string,
    pairs: DotenvVariable[],
    overwrite: boolean = true,
  ): { added: number; updated: number; skipped: number } {
    const project = this.findProject(projectId)
    const env = this.findEnvironment(project, envName)
    const byKey = new Map<string, VariableRecord>()
    for (const v of env.variables) byKey.set(v.key, v)

    const now = localIsoTimestamp()
    let added = 0
    let updated = 0
    let skipped = 0

    for (const item of pairs) {
      const key = validateVarKey(item.key)
      const value = validateVarValue(item.value)
      const existing = byKey.get(key)
      if (existing) {
        if (!overwrite || existing.value === value) {
          skipped += 1
          continue
        }
        existing.value = value
        existing.updated_at = now
        updated += 1
      } else {
        if (env.variables.length >= MAX_VARIABLES) {
          throw new VaultError('INVALID', `Limite de ${MAX_VARIABLES} variables atteinte.`)
        }
        const record: VariableRecord = {
          key,
          value,
          masked: false,
          protected: false,
          raw: true,
          type: 'env_var',
          updated_at: now,
        }
        env.variables.push(record)
        byKey.set(key, record)
        added += 1
      }
    }

    if (added > 0 || updated > 0) {
      project.updated_at = now
      this.persist()
      this.touch()
    }
    return { added, updated, skipped }
  }

  // -------------------------------------------------------------------------
  // Fournisseurs distants
  // -------------------------------------------------------------------------

  linkRemote(
    projectId: number,
    provider: RemoteProviderName,
    target: string,
    host?: string,
  ): ProjectMeta {
    const project = this.findProject(projectId)
    const cleanProvider = validateProvider(provider)
    const cleanHost = normalizeHost(host, cleanProvider)
    const cleanTarget = validateRemoteTarget(target, cleanProvider)
    project.remote = {
      provider: cleanProvider,
      host: cleanHost,
      target: cleanTarget,
    }
    project.updated_at = localIsoTimestamp()
    this.persist()
    this.touch()
    return toProjectMeta(project)
  }

  unlinkRemote(projectId: number): ProjectMeta {
    const project = this.findProject(projectId)
    project.remote = null
    project.updated_at = localIsoTimestamp()
    this.persist()
    this.touch()
    return toProjectMeta(project)
  }

  setRemoteScope(projectId: number, envName: string, scope: string | null): ProjectMeta {
    const project = this.findProject(projectId)
    const env = this.findEnvironment(project, envName)
    env.remote_scope = validateRemoteScope(scope)
    project.updated_at = localIsoTimestamp()
    this.persist()
    this.touch()
    return toProjectMeta(project)
  }

  saveCredential(
    provider: RemoteProviderName,
    token: string,
    host?: string,
  ): CredentialMeta[] {
    const data = this.requireData()
    const cleanProvider = validateProvider(provider)
    const cleanHost = normalizeHost(host, cleanProvider)
    const cleanToken = typeof token === 'string' ? token.trim() : ''
    if (!cleanToken || cleanToken.length > MAX_TOKEN_LENGTH) {
      throw new VaultError('INVALID', 'Jeton distant invalide.')
    }
    const now = localIsoTimestamp()
    const existing = data.credentials.find(
      (c) => c.provider === cleanProvider && c.host === cleanHost,
    )
    if (existing) {
      existing.token = cleanToken
      existing.added_at = now
    } else {
      data.credentials.push({
        provider: cleanProvider,
        host: cleanHost,
        token: cleanToken,
        added_at: now,
      })
    }
    this.persist()
    this.touch()
    return data.credentials.map(toCredentialMeta)
  }

  removeCredential(provider: RemoteProviderName, host?: string): CredentialMeta[] {
    const data = this.requireData()
    const cleanProvider = validateProvider(provider)
    const cleanHost = normalizeHost(host, cleanProvider)
    data.credentials = data.credentials.filter(
      (c) => !(c.provider === cleanProvider && c.host === cleanHost),
    )
    this.persist()
    this.touch()
    return data.credentials.map(toCredentialMeta)
  }

  findCredentialToken(provider: RemoteProviderName, host?: string): string | null {
    const data = this.requireData()
    const cleanProvider = validateProvider(provider)
    const cleanHost = normalizeHost(host, cleanProvider)
    const envVar = cleanProvider === 'gitlab' ? 'GITLAB_TOKEN' : 'GITHUB_TOKEN'
    const fromEnv = process.env[envVar]?.trim()
    if (fromEnv) return fromEnv
    const cred = data.credentials.find(
      (c) => c.provider === cleanProvider && c.host === cleanHost,
    )
    return cred?.token ?? null
  }

  getProjectRecord(projectId: number): ProjectRecord {
    return this.findProject(projectId)
  }

  getProjectMeta(projectId: number): ProjectMeta {
    return toProjectMeta(this.findProject(projectId))
  }

  replaceEnvironmentFromRemote(
    projectId: number,
    envName: string,
    remoteVars: Array<{
      key: string
      value: string | null
      masked?: boolean
      protected?: boolean
      raw?: boolean
      type?: VariableType
    }>,
    overwrite: boolean,
  ): { project: ProjectMeta; added: number; updated: number; skipped: number } {
    const project = this.findProject(projectId)
    const env = this.findEnvironment(project, envName)
    const byKey = new Map<string, VariableRecord>()
    for (const v of env.variables) byKey.set(v.key, v)

    const now = localIsoTimestamp()
    let added = 0
    let updated = 0
    let skipped = 0

    for (const rvar of remoteVars) {
      const key = validateVarKey(rvar.key)
      const value = validateVarValue(rvar.value ?? '')
      const existing = byKey.get(key)
      if (existing) {
        if (!overwrite) {
          skipped += 1
          continue
        }
        existing.value = value
        existing.masked = Boolean(rvar.masked ?? false)
        existing.protected = Boolean(rvar.protected ?? false)
        existing.raw = Boolean(rvar.raw ?? true)
        existing.type = rvar.type ?? 'env_var'
        existing.updated_at = now
        updated += 1
      } else {
        if (env.variables.length >= MAX_VARIABLES) {
          throw new VaultError('INVALID', `Limite de ${MAX_VARIABLES} variables atteinte.`)
        }
        const record: VariableRecord = {
          key,
          value,
          masked: Boolean(rvar.masked ?? false),
          protected: Boolean(rvar.protected ?? false),
          raw: Boolean(rvar.raw ?? true),
          type: rvar.type ?? 'env_var',
          updated_at: now,
        }
        env.variables.push(record)
        byKey.set(key, record)
        added += 1
      }
    }

    if (added > 0 || updated > 0) {
      project.updated_at = now
      this.persist()
      this.touch()
    }
    return { project: toProjectMeta(project), added, updated, skipped }
  }

  // -------------------------------------------------------------------------
  // Utilitaires internes
  // -------------------------------------------------------------------------

  private findProject(projectId: number): ProjectRecord {
    if (!Number.isInteger(projectId)) {
      throw new VaultError('INVALID', 'Identifiant de projet invalide.')
    }
    const project = this.requireData().projects.find((p) => p.id === projectId)
    if (!project) {
      throw new VaultError('NOT_FOUND', 'Projet introuvable.')
    }
    return project
  }

  private findEnvironment(project: ProjectRecord, envName: string): EnvironmentRecord {
    const clean = typeof envName === 'string' ? envName.trim() : ''
    const env = project.environments.find((e) => e.name === clean)
    if (!env) {
      throw new VaultError(
        'NOT_FOUND',
        `Environnement « ${clean} » introuvable dans le projet « ${project.name} ».`,
      )
    }
    return env
  }

  private requireData(): SecretsVaultFile {
    if (!this.data) {
      throw new VaultError('LOCKED', 'Le coffre de secrets est verrouillé.')
    }
    return this.data
  }

  private persist(): void {
    const data = this.requireData()
    if (!this.key || !this.salt) {
      throw new VaultError('LOCKED', 'Le coffre de secrets est verrouillé.')
    }

    const payload = Buffer.from(JSON.stringify(data), 'utf8')
    if (payload.length > MAX_VAULT_BYTES) {
      throw new VaultError('INVALID', 'Le coffre de secrets dépasse la taille maximale autorisée.')
    }

    const directory = dirname(this.vaultPath)
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    trySetMode(directory, 0o700)

    const blob = encryptWithKey(payload, this.key, this.salt)
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

// ---------------------------------------------------------------------------
// Conversion et validation du document
// ---------------------------------------------------------------------------

function toVariableMeta(record: VariableRecord): VariableMeta {
  return {
    key: record.key,
    length: record.value.length,
    masked: record.masked,
    protected: record.protected,
    raw: record.raw,
    type: record.type,
    updatedAt: record.updated_at,
  }
}

function toEnvironmentMeta(record: EnvironmentRecord): EnvironmentMeta {
  return {
    name: record.name,
    remoteScope: record.remote_scope,
    variableCount: record.variables.length,
    variables: record.variables.map(toVariableMeta),
  }
}

function toProjectMeta(record: ProjectRecord): ProjectMeta {
  const remote: RemoteLink | null = record.remote
    ? {
        provider: record.remote.provider,
        host: record.remote.host,
        target: record.remote.target,
      }
    : null
  return {
    id: record.id,
    name: record.name,
    description: record.description,
    createdAt: record.created_at,
    updatedAt: record.updated_at,
    remote,
    environments: record.environments.map(toEnvironmentMeta),
  }
}

function toCredentialMeta(record: CredentialRecord): CredentialMeta {
  return {
    provider: record.provider,
    host: record.host,
    addedAt: record.added_at,
  }
}

function parseVariableRecord(raw: unknown): VariableRecord {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new VaultError('CORRUPT', 'Variable invalide dans le coffre.')
  }
  const obj = raw as Record<string, unknown>
  const key = validateVarKey(typeof obj.key === 'string' ? obj.key : '')
  const value = validateVarValue(typeof obj.value === 'string' ? obj.value : '')
  const type = obj.type ?? 'env_var'
  if (!isVariableType(type)) {
    throw new VaultError('CORRUPT', `Type de variable invalide : ${String(type)}`)
  }
  if (typeof obj.updated_at !== 'string' || !obj.updated_at) {
    throw new VaultError('CORRUPT', 'Horodatage de variable manquant.')
  }
  return {
    ...obj,
    key,
    value,
    masked: Boolean(obj.masked ?? false),
    protected: Boolean(obj.protected ?? false),
    raw: Boolean(obj.raw ?? true),
    type,
    updated_at: obj.updated_at,
  }
}

function parseEnvironmentRecord(raw: unknown): EnvironmentRecord {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new VaultError('CORRUPT', 'Environnement invalide dans le coffre.')
  }
  const obj = raw as Record<string, unknown>
  const name = validateEnvName(typeof obj.name === 'string' ? obj.name : '')
  const remote_scope = validateRemoteScope(
    obj.remote_scope === null || obj.remote_scope === undefined
      ? null
      : String(obj.remote_scope),
  )
  if (!Array.isArray(obj.variables) || obj.variables.length > MAX_VARIABLES) {
    throw new VaultError('CORRUPT', 'Liste de variables invalide.')
  }
  const seen = new Set<string>()
  const variables = obj.variables.map((item) => {
    const v = parseVariableRecord(item)
    if (seen.has(v.key)) {
      throw new VaultError('CORRUPT', `Clé de variable dupliquée : ${v.key}`)
    }
    seen.add(v.key)
    return v
  })
  return { ...obj, name, remote_scope, variables }
}

function parseRemoteRecord(raw: unknown): RemoteRecord | null {
  if (raw === null || raw === undefined) return null
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new VaultError('CORRUPT', 'Configuration distante invalide.')
  }
  const obj = raw as Record<string, unknown>
  const provider = validateProvider(obj.provider)
  const host = normalizeHost(typeof obj.host === 'string' ? obj.host : undefined, provider)
  const target = validateRemoteTarget(typeof obj.target === 'string' ? obj.target : '', provider)
  return { ...obj, provider, host, target }
}

function parseProjectRecord(raw: unknown): ProjectRecord {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new VaultError('CORRUPT', 'Projet invalide dans le coffre.')
  }
  const obj = raw as Record<string, unknown>
  if (!Number.isInteger(obj.id) || (obj.id as number) < 1) {
    throw new VaultError('CORRUPT', 'Identifiant de projet invalide.')
  }
  const name = validateProjectName(typeof obj.name === 'string' ? obj.name : '')
  const description = typeof obj.description === 'string' ? obj.description : ''
  if (description.length > MAX_DESCRIPTION_LENGTH) {
    throw new VaultError('CORRUPT', 'Description de projet invalide.')
  }
  if (typeof obj.created_at !== 'string' || typeof obj.updated_at !== 'string') {
    throw new VaultError('CORRUPT', 'Horodatage de projet manquant.')
  }
  const remote = parseRemoteRecord(obj.remote)
  if (!Array.isArray(obj.environments) || obj.environments.length > MAX_ENVIRONMENTS) {
    throw new VaultError('CORRUPT', 'Liste d’environnements invalide.')
  }
  const seenEnvs = new Set<string>()
  const environments = obj.environments.map((item) => {
    const env = parseEnvironmentRecord(item)
    if (seenEnvs.has(env.name)) {
      throw new VaultError('CORRUPT', `Environnement dupliqué : ${env.name}`)
    }
    seenEnvs.add(env.name)
    return env
  })
  return {
    ...obj,
    id: obj.id as number,
    name,
    description,
    created_at: obj.created_at,
    updated_at: obj.updated_at,
    remote,
    environments,
  }
}

function parseCredentialRecord(raw: unknown): CredentialRecord {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new VaultError('CORRUPT', 'Identifiant distant invalide.')
  }
  const obj = raw as Record<string, unknown>
  const provider = validateProvider(obj.provider)
  const host = normalizeHost(typeof obj.host === 'string' ? obj.host : undefined, provider)
  const token = typeof obj.token === 'string' ? obj.token.trim() : ''
  if (!token || token.length > MAX_TOKEN_LENGTH) {
    throw new VaultError('CORRUPT', 'Jeton distant invalide.')
  }
  if (typeof obj.added_at !== 'string' || !obj.added_at) {
    throw new VaultError('CORRUPT', 'Horodatage de jeton manquant.')
  }
  return { ...obj, provider, host, token, added_at: obj.added_at }
}

export function parseSecretsVaultFile(raw: unknown): SecretsVaultFile {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new VaultError('CORRUPT', 'Le contenu du coffre de secrets est invalide.')
  }
  const obj = raw as Record<string, unknown>
  if (obj.kind !== SECRETS_KIND) {
    throw new VaultError(
      'WRONG_KIND',
      'Ce fichier n’est pas un coffre de secrets applicatifs (kind invalide).',
    )
  }
  if (obj.version !== SECRETS_VERSION) {
    throw new VaultError(
      'UNSUPPORTED_VERSION',
      `Version de coffre non prise en charge : ${String(obj.version)}.`,
    )
  }
  if (!Array.isArray(obj.projects) || obj.projects.length > MAX_PROJECTS) {
    throw new VaultError('CORRUPT', 'Liste des projets invalide.')
  }
  const seenIds = new Set<number>()
  const seenNames = new Set<string>()
  const projects = obj.projects.map((item) => {
    const proj = parseProjectRecord(item)
    if (seenIds.has(proj.id) || seenNames.has(proj.name)) {
      throw new VaultError('CORRUPT', `Projet en doublon : ${proj.name}`)
    }
    seenIds.add(proj.id)
    seenNames.add(proj.name)
    return proj
  })

  const rawCreds = obj.credentials === undefined ? [] : obj.credentials
  if (!Array.isArray(rawCreds)) {
    throw new VaultError('CORRUPT', 'Liste des identifiants invalide.')
  }
  const seenCreds = new Set<string>()
  const credentials = rawCreds.map((item) => {
    const cred = parseCredentialRecord(item)
    const key = `${cred.provider}\u0000${cred.host}`
    if (seenCreds.has(key)) {
      throw new VaultError('CORRUPT', `Jeton en doublon pour ${cred.provider} (${cred.host}).`)
    }
    seenCreds.add(key)
    return cred
  })

  return {
    ...obj,
    kind: SECRETS_KIND,
    version: SECRETS_VERSION,
    projects,
    credentials,
  }
}

function trySetMode(path: string, mode: number): void {
  try {
    chmodSync(path, mode)
  } catch {
    // Systèmes de fichiers sans permissions POSIX (Windows) : on ignore.
  }
}

