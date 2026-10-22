import { BrowserWindow, clipboard, dialog, ipcMain, type IpcMainInvokeEvent } from 'electron'
import { readFile, stat } from 'node:fs/promises'
import type {
  AddEntryInput,
  EntryMeta,
  GenerateRequest,
  ImportSummary,
  IpcResult,
  UnlockResult,
} from '../shared/types'
import { VaultError } from './crypto'
import { generatePassword } from './generator'
import { ImportError, parseImportContent } from './importer'
import { VaultService } from './vault'

const CLIPBOARD_CLEAR_MS = 30_000
const MAX_COPY_LENGTH = 256
const MAX_IMPORT_BYTES = 5 * 1024 * 1024

let lastCopied: string | null = null
let clipboardTimer: ReturnType<typeof setTimeout> | null = null

async function copySensitive(text: string): Promise<number> {
  await clipboard.writeText(text)
  lastCopied = text
  if (clipboardTimer) clearTimeout(clipboardTimer)
  clipboardTimer = setTimeout(() => {
    void clearSensitiveClipboard()
  }, CLIPBOARD_CLEAR_MS)
  clipboardTimer.unref?.()
  return CLIPBOARD_CLEAR_MS / 1000
}

/** Efface le presse-papier uniquement s'il contient encore notre secret. */
export async function clearSensitiveClipboard(): Promise<void> {
  const secret = lastCopied
  lastCopied = null
  if (clipboardTimer) {
    clearTimeout(clipboardTimer)
    clipboardTimer = null
  }
  if (secret === null) return

  try {
    if ((await clipboard.readText()) === secret) {
      clipboard.clear()
    }
  } catch {
    // Presse-papier indisponible : rien à faire.
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof VaultError || error instanceof ImportError) return error.message
  return 'Une erreur inattendue est survenue.'
}

function success<T>(data: T): IpcResult<T> {
  return { ok: true, data }
}

function failure(error: unknown): IpcResult<never> {
  return { ok: false, error: errorMessage(error) }
}

/**
 * Enveloppe un handler IPC : les exceptions ne traversent jamais la frontière,
 * elles deviennent un résultat `{ ok: false, error }` lisible par l'interface.
 */
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

export function registerIpc(vault: VaultService): void {
  const unlockedResult = (entries: EntryMeta[]): UnlockResult => ({
    entries,
    autoLockSeconds: Math.round(vault.status().autoLockSeconds),
  })

  handle('vault:status', () => vault.status())
  handle('vault:create', async (master: string) => unlockedResult(await vault.create(master)))
  handle('vault:unlock', async (master: string) => unlockedResult(await vault.unlock(master)))
  handle('vault:lock', () => {
    vault.lock('manual')
    return null
  })
  handle('vault:list', () => vault.list())

  handle('vault:add', async (input: AddEntryInput) => vault.add(input))
  handle('vault:reveal', (id: number) => vault.reveal(id))
  handle('vault:remove', (id: number) => {
    vault.remove(id)
    return null
  })

  handle('vault:copy-entry', async (id: number) => copySensitive(vault.reveal(id)))
  handle('vault:copy-text', async (text: string) => {
    if (typeof text !== 'string' || text.length === 0 || text.length > MAX_COPY_LENGTH) {
      throw new VaultError('INVALID', 'Contenu à copier invalide.')
    }
    return copySensitive(text)
  })

  handle('vault:generate', (request: GenerateRequest) => generatePassword(request))

  handle('vault:import-file', async (): Promise<ImportSummary> => {
    const options: Electron.OpenDialogOptions = {
      title: 'Importer des mots de passe',
      buttonLabel: 'Importer',
      properties: ['openFile'],
      filters: [
        { name: 'Fichiers de mots de passe', extensions: ['csv', 'tsv', 'json', 'txt'] },
        { name: 'Tous les fichiers', extensions: ['*'] },
      ],
    }

    const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    const selection = window
      ? await dialog.showOpenDialog(window, options)
      : await dialog.showOpenDialog(options)

    if (selection.canceled || selection.filePaths.length === 0) {
      return { added: 0, skipped: 0, cancelled: true }
    }

    const filePath = selection.filePaths[0]
    const info = await stat(filePath)
    if (info.size > MAX_IMPORT_BYTES) {
      throw new ImportError('Fichier trop volumineux (5 Mo maximum).')
    }

    const content = await readFile(filePath, 'utf8')
    const entries = parseImportContent(content, filePath)
    if (entries.length === 0) {
      throw new ImportError('Aucun mot de passe exploitable trouvé dans ce fichier.')
    }

    return { ...vault.importMany(entries), cancelled: false }
  })

  ipcMain.handle('vault:touch', () => {
    vault.touch()
  })
}
