/**
 * Canaux IPC `secrets:*` pour le coffre de secrets applicatifs (`secrets.enc`).
 */

import { BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent } from 'electron'
import { chmod, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type {
  CreateProjectInput,
  CredentialMeta,
  DotenvExportFileSummary,
  DotenvExportFormat,
  DotenvImportSummary,
  DotenvPreview,
  ProjectMeta,
  PullSummary,
  RemoteProviderName,
  SecretsState,
  SyncApplySummary,
  SyncPlan,
  UpsertVariableInput,
} from '../shared/secretsTypes'
import type { IpcResult } from '../shared/types'
import { VaultError } from './crypto'
import * as dotenv from './dotenv'
import { generateSecret } from './generator'
import { copySensitive } from './ipc'
import { isGitIgnored } from './projectFile'
import { createProvider, ProviderError } from './providers'
import { normalizeHost, SecretsService, validateProvider } from './secretsVault'
import { buildSyncPlan } from './sync'

const MAX_DOTENV_BYTES = 5 * 1024 * 1024

function errorMessage(error: unknown): string {
  if (error instanceof VaultError || error instanceof ProviderError) return error.message
  return 'Une erreur inattendue est survenue.'
}

function success<T>(data: T): IpcResult<T> {
  return { ok: true, data }
}

function failure(error: unknown): IpcResult<never> {
  return { ok: false, error: errorMessage(error) }
}

function handle<Args extends unknown[], T>(
  channel: string,
  handler: (...args: Args) => T | Promise<T>,
): void {
  ipcMain.handle(channel, async (_event: IpcMainInvokeEvent, ...args: unknown[]) => {
    try {
      return success(await handler(...(args as Args)))
    } catch (error) {
      return failure(error)
    }
  })
}

async function writeExportFileAtomic(filePath: string, content: string): Promise<void> {
  const dir = dirname(filePath)
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const tempPath = `${filePath}.${process.pid}.tmp`
  await writeFile(tempPath, content, { encoding: 'utf8', mode: 0o600 })
  await rename(tempPath, filePath)
  try {
    await chmod(filePath, 0o600)
  } catch {
    // Windows : ignoré
  }
}

export function registerSecretsIpc(secrets: SecretsService): void {
  handle('secrets:status', () => secrets.status())
  handle('secrets:create', (master: string): Promise<SecretsState> => secrets.create(master))
  handle('secrets:unlock', (master: string): Promise<SecretsState> => secrets.unlock(master))
  handle('secrets:lock', () => {
    secrets.lock('manual')
    return null
  })
  handle('secrets:passwd', async (currentMaster: string, newMaster: string) => {
    await secrets.changePassword(currentMaster, newMaster)
    return null
  })
  handle('secrets:state', (): SecretsState => secrets.state())

  // Projets et environnements
  handle('secrets:projects:add', (input: CreateProjectInput): ProjectMeta =>
    secrets.addProject(input),
  )
  handle(
    'secrets:projects:rename',
    (projectId: number, name: string, description?: string): ProjectMeta =>
      secrets.renameProject(projectId, name, description),
  )
  handle('secrets:projects:remove', (projectId: number) => {
    secrets.removeProject(projectId)
    return null
  })
  handle('secrets:envs:add', (projectId: number, envName: string): ProjectMeta =>
    secrets.addEnvironment(projectId, envName),
  )
  handle('secrets:envs:remove', (projectId: number, envName: string): ProjectMeta =>
    secrets.removeEnvironment(projectId, envName),
  )

  // Variables
  handle('secrets:vars:upsert', (input: UpsertVariableInput): ProjectMeta =>
    secrets.upsertVariable(input),
  )
  handle(
    'secrets:vars:remove',
    (projectId: number, environment: string, key: string): ProjectMeta =>
      secrets.removeVariable(projectId, environment, key),
  )
  handle('secrets:vars:reveal', (projectId: number, environment: string, key: string): string =>
    secrets.revealVariable(projectId, environment, key),
  )
  handle(
    'secrets:vars:copy',
    async (projectId: number, environment: string, key: string): Promise<number> =>
      copySensitive(secrets.revealVariable(projectId, environment, key)),
  )
  handle('secrets:vars:generate', (spec: string): string => generateSecret(spec))

  // .env import / export
  handle('secrets:dotenv:preview', (text: string): DotenvPreview => {
    if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > MAX_DOTENV_BYTES) {
      throw new VaultError('INVALID', 'Contenu .env trop volumineux.')
    }
    const parsed = dotenv.parse(text)
    return {
      variables: parsed.variables.map((v) => ({ key: v.key, length: v.value.length })),
      duplicates: parsed.duplicates,
      invalidLines: parsed.invalid_lines,
    }
  })

  handle(
    'secrets:dotenv:import-text',
    (
      projectId: number,
      environment: string,
      text: string,
      overwrite: boolean,
    ): DotenvImportSummary => {
      if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > MAX_DOTENV_BYTES) {
        throw new VaultError('INVALID', 'Contenu .env trop volumineux.')
      }
      const parsed = dotenv.parse(text)
      if (parsed.variables.length === 0) {
        throw new VaultError('INVALID', 'Aucune variable valide trouvée dans ce contenu .env.')
      }
      const counts = secrets.importVariables(
        projectId,
        environment,
        parsed.variables,
        Boolean(overwrite),
      )
      return {
        ...counts,
        duplicates: parsed.duplicates,
        invalidLines: parsed.invalid_lines,
        cancelled: false,
      }
    },
  )

  handle(
    'secrets:dotenv:import-file',
    async (
      projectId: number,
      environment: string,
      overwrite: boolean,
    ): Promise<DotenvImportSummary> => {
      const options: Electron.OpenDialogOptions = {
        title: 'Importer un fichier .env',
        buttonLabel: 'Importer',
        properties: ['openFile', 'showHiddenFiles'],
        filters: [
          { name: 'Fichiers .env', extensions: ['env', 'txt', '*'] },
          { name: 'Tous les fichiers', extensions: ['*'] },
        ],
      }
      const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
      const selection = window
        ? await dialog.showOpenDialog(window, options)
        : await dialog.showOpenDialog(options)

      if (selection.canceled || selection.filePaths.length === 0) {
        return {
          added: 0,
          updated: 0,
          skipped: 0,
          duplicates: [],
          invalidLines: [],
          cancelled: true,
        }
      }

      const filePath = selection.filePaths[0]
      const info = await stat(filePath)
      if (info.size > MAX_DOTENV_BYTES) {
        throw new VaultError('INVALID', 'Fichier .env trop volumineux (5 Mo maximum).')
      }

      const content = await readFile(filePath, 'utf8')
      const parsed = dotenv.parse(content)
      if (parsed.variables.length === 0) {
        throw new VaultError('INVALID', 'Aucune variable valide trouvée dans ce fichier .env.')
      }
      const counts = secrets.importVariables(
        projectId,
        environment,
        parsed.variables,
        Boolean(overwrite),
      )
      return {
        ...counts,
        duplicates: parsed.duplicates,
        invalidLines: parsed.invalid_lines,
        cancelled: false,
      }
    },
  )

  handle(
    'secrets:dotenv:export-text',
    (projectId: number, environment: string, format: DotenvExportFormat): string => {
      const vars = secrets.getVariablesRaw(projectId, environment)
      return dotenv.serialize(
        vars.map((v) => ({ key: v.key, value: v.value })),
        format,
      )
    },
  )

  handle(
    'secrets:dotenv:export-file',
    async (
      projectId: number,
      environment: string,
      format: DotenvExportFormat,
    ): Promise<DotenvExportFileSummary> => {
      const vars = secrets.getVariablesRaw(projectId, environment)
      const rendered = dotenv.serialize(
        vars.map((v) => ({ key: v.key, value: v.value })),
        format,
      )
      const defaultName =
        format === 'json'
          ? `${environment}.secrets.json`
          : format === 'shell'
            ? `${environment}.env.sh`
            : `.env.${environment}`

      const options: Electron.SaveDialogOptions = {
        title: 'Exporter les variables',
        buttonLabel: 'Exporter',
        defaultPath: defaultName,
        properties: ['showHiddenFiles', ' showOverwriteConfirmation' as never],
      }
      const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
      const selection = window
        ? await dialog.showSaveDialog(window, options)
        : await dialog.showSaveDialog(options)

      if (selection.canceled || !selection.filePath) {
        return { path: '', gitIgnored: null, cancelled: true }
      }

      await writeExportFileAtomic(selection.filePath, rendered)
      const gitIgnored = isGitIgnored(selection.filePath)
      return {
        path: selection.filePath,
        gitIgnored,
        cancelled: false,
      }
    },
  )

  // Fournisseurs distants (GitLab, GitHub)
  handle(
    'secrets:remote:login',
    async (
      provider: RemoteProviderName,
      token: string,
      host?: string,
    ): Promise<{ identity: string; credentials: CredentialMeta[] }> => {
      const cleanProvider = validateProvider(provider)
      const cleanHost = normalizeHost(host, cleanProvider)
      const cleanToken = typeof token === 'string' ? token.trim() : ''
      if (!cleanToken) {
        throw new VaultError('INVALID', 'Le jeton ne peut pas être vide.')
      }
      const client = createProvider(cleanProvider, cleanHost, cleanToken)
      const identity = await client.verifyToken()
      const credentials = secrets.saveCredential(cleanProvider, cleanToken, cleanHost)
      return { identity, credentials }
    },
  )

  handle(
    'secrets:remote:logout',
    (provider: RemoteProviderName, host?: string): CredentialMeta[] =>
      secrets.removeCredential(provider, host),
  )

  handle(
    'secrets:remote:link',
    (
      projectId: number,
      provider: RemoteProviderName,
      target: string,
      host?: string,
    ): ProjectMeta => secrets.linkRemote(projectId, provider, target, host),
  )

  handle('secrets:remote:unlink', (projectId: number): ProjectMeta =>
    secrets.unlinkRemote(projectId),
  )

  handle(
    'secrets:remote:scope',
    (projectId: number, environment: string, scope: string | null): ProjectMeta =>
      secrets.setRemoteScope(projectId, environment, scope),
  )

  const resolveRemoteContext = (projectId: number, environment: string) => {
    const project = secrets.getProjectRecord(projectId)
    if (!project.remote) {
      throw new VaultError('INVALID', 'Ce projet n’est relié à aucun fournisseur distant.')
    }
    const env = project.environments.find((e) => e.name === environment)
    if (!env) {
      throw new VaultError('NOT_FOUND', `Environnement « ${environment} » introuvable.`)
    }
    if (!env.remote_scope) {
      throw new VaultError(
        'INVALID',
        `L’environnement « ${environment} » n’a pas de portée distante configurée.`,
      )
    }
    const token = secrets.findCredentialToken(project.remote.provider, project.remote.host)
    if (!token) {
      throw new VaultError(
        'NOT_FOUND',
        `Aucun jeton enregistré pour ${project.remote.provider} (${project.remote.host}).`,
      )
    }
    const client = createProvider(project.remote.provider, project.remote.host, token)
    return { project, env, remote: project.remote, client, scope: env.remote_scope }
  }

  handle(
    'secrets:remote:plan',
    async (projectId: number, environment: string, prune: boolean): Promise<SyncPlan> => {
      const { env, remote, client, scope } = resolveRemoteContext(projectId, environment)
      const remoteVars = await client.listRemote(remote.target, scope)
      return buildSyncPlan({
        provider: remote.provider,
        target: remote.target,
        environment: env.name,
        scope,
        localVars: env.variables,
        remoteVars,
        prune: Boolean(prune),
      })
    },
  )

  handle(
    'secrets:remote:apply',
    async (projectId: number, environment: string, prune: boolean): Promise<SyncApplySummary> => {
      const { env, remote, client, scope } = resolveRemoteContext(projectId, environment)
      const remoteVars = await client.listRemote(remote.target, scope)
      const plan = buildSyncPlan({
        provider: remote.provider,
        target: remote.target,
        environment: env.name,
        scope,
        localVars: env.variables,
        remoteVars,
        prune: Boolean(prune),
      })
      if (plan.errors.length > 0) {
        throw new VaultError('INVALID', plan.errors.join(' '))
      }
      return client.applyPlan(remote.target, scope, env.variables, plan.items)
    },
  )

  handle(
    'secrets:remote:pull',
    async (
      projectId: number,
      environment: string,
      overwrite: boolean,
    ): Promise<{ project: ProjectMeta; summary: PullSummary }> => {
      const { env, remote, client, scope } = resolveRemoteContext(projectId, environment)
      if (!client.canReadValues) {
        throw new VaultError(
          'INVALID',
          `Le fournisseur « ${remote.provider} » ne permet pas de récupérer la valeur des secrets.`,
        )
      }
      const remoteVars = await client.listRemote(remote.target, scope)
      const { project, added, updated, skipped } = secrets.replaceEnvironmentFromRemote(
        projectId,
        env.name,
        remoteVars,
        Boolean(overwrite),
      )
      return { project, summary: { added, updated, skipped } }
    },
  )

  ipcMain.handle('secrets:touch', () => {
    secrets.touch()
  })
}

