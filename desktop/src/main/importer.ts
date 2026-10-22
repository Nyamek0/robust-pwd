import type { ImportedPassword } from '../shared/types'

export const MAX_IMPORT_ENTRIES = 1000
const MAX_LABEL_LENGTH = 80
const MAX_PASSWORD_LENGTH = 256

const LABEL_KEYS = [
  'label',
  'name',
  'title',
  'site',
  'service',
  'application',
  'url',
  'website',
  'account',
  'login',
  'username',
  'identifier',
  'nom',
  'titre',
  'compte',
  'mot cle',
]

const PASSWORD_KEYS = [
  'password',
  'pass',
  'passwd',
  'pwd',
  'secret',
  'mot de passe',
  'mdp',
]

export class ImportError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ImportError'
  }
}

interface Row {
  label?: string
  password?: string
}

/**
 * Lit un export CSV, TSV ou JSON et retourne les couples (mot clé, mot de passe).
 * Aucun accès disque : la fonction est pure et testable.
 */
export function parseImportContent(content: string, filename = ''): ImportedPassword[] {
  const text = content.replace(/^\uFEFF/, '')
  if (!text.trim()) throw new ImportError('Le fichier est vide.')

  const looksLikeJson =
    /\.json$/i.test(filename) || text.trimStart().startsWith('{') || text.trimStart().startsWith('[')
  const rows = looksLikeJson ? parseJson(text) : parseCsv(text)

  const seen = new Set<string>()
  const entries: ImportedPassword[] = []

  for (const row of rows) {
    const label = (row.label ?? '').trim().slice(0, MAX_LABEL_LENGTH)
    const password = row.password ?? ''
    if (!label || !password || password.length > MAX_PASSWORD_LENGTH) continue

    const key = `${label.toLowerCase()}\u0000${password}`
    if (seen.has(key)) continue
    seen.add(key)

    entries.push({ label, password })
    if (entries.length > MAX_IMPORT_ENTRIES) {
      throw new ImportError(`${MAX_IMPORT_ENTRIES} entrées maximum par import.`)
    }
  }

  return entries
}

/* ------------------------------------------------------------------ */
/* JSON                                                               */
/* ------------------------------------------------------------------ */

function parseJson(text: string): Row[] {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    throw new ImportError('Fichier JSON invalide.')
  }

  let list: unknown[]
  if (Array.isArray(data)) {
    list = data
  } else if (isRecord(data) && Array.isArray(data.entries)) {
    list = data.entries
  } else if (isRecord(data) && Array.isArray(data.items)) {
    // Export Bitwarden : { items: [{ name, login: { password } }] }
    list = data.items
  } else {
    throw new ImportError(
      'Format JSON non reconnu. Attendu : un tableau, { "entries": [...] } ou { "items": [...] }.',
    )
  }

  return list.map(jsonRow)
}

function jsonRow(item: unknown): Row {
  if (!isRecord(item)) return {}

  const direct = normalizedStrings(item)
  const password = firstValue(direct, PASSWORD_KEYS)
  const label = firstValue(direct, LABEL_KEYS)

  if (password) return { label, password }

  if (isRecord(item.login)) {
    const nested = normalizedStrings(item.login)
    const nestedPassword = firstValue(nested, PASSWORD_KEYS)
    if (nestedPassword) return { label: label ?? firstValue(direct, ['name']), password: nestedPassword }
  }

  return { label, password }
}

function normalizedStrings(record: Record<string, unknown>): Record<string, string> {
  const output: Record<string, string> = {}
  for (const [key, value] of Object.entries(record)) {
    if (typeof value === 'string') output[normalizeKey(key)] = value
  }
  return output
}

function firstValue(record: Record<string, string>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key]
    if (value && value.trim()) return value
  }
  return undefined
}

/* ------------------------------------------------------------------ */
/* CSV / TSV                                                          */
/* ------------------------------------------------------------------ */

function parseCsv(text: string): Row[] {
  const delimiter = detectDelimiter(text)
  const records = parseDelimited(text, delimiter).filter((record) =>
    record.some((cell) => cell.trim() !== ''),
  )
  if (records.length === 0) return []

  const header = records[0].map(normalizeKey)
  const passwordIndex = header.findIndex(isPasswordKey)
  const labelIndex = header.findIndex((key) => LABEL_KEYS.includes(key))

  if (passwordIndex === -1) {
    if (labelIndex !== -1) {
      throw new ImportError(
        'Colonne de mot de passe introuvable (attendu : password, pass, secret, mot de passe…).',
      )
    }
    // Fichier sans en-tête : on suppose « libellé, mot de passe ».
    return records.map((record) => ({ label: record[0], password: record[1] }))
  }

  const labelColumn = labelIndex !== -1 ? labelIndex : header.findIndex((_, index) => index !== passwordIndex)

  return records.slice(1).map((record) => ({
    label: labelColumn >= 0 ? record[labelColumn] : undefined,
    password: record[passwordIndex],
  }))
}

function detectDelimiter(text: string): string {
  const firstLine = text.split(/\r?\n/).find((line) => line.trim() !== '') ?? ''
  const candidates = [',', ';', '\t']
  let best = ','
  let bestCount = 0

  for (const candidate of candidates) {
    const count = countOutsideQuotes(firstLine, candidate)
    if (count > bestCount) {
      best = candidate
      bestCount = count
    }
  }
  return best
}

function countOutsideQuotes(line: string, character: string): number {
  let insideQuotes = false
  let count = 0
  for (const current of line) {
    if (current === '"') insideQuotes = !insideQuotes
    else if (current === character && !insideQuotes) count += 1
  }
  return count
}

function parseDelimited(text: string, delimiter: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let insideQuotes = false
  let fieldStarted = false

  const endField = () => {
    row.push(field)
    field = ''
    fieldStarted = false
  }

  const endRow = () => {
    endField()
    rows.push(row)
    row = []
  }

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]

    if (insideQuotes) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          field += '"'
          index += 1
        } else {
          insideQuotes = false
        }
      } else {
        field += character
      }
      continue
    }

    if (character === '"' && !fieldStarted) {
      insideQuotes = true
      fieldStarted = true
    } else if (character === delimiter) {
      endField()
    } else if (character === '\n') {
      endRow()
    } else if (character === '\r') {
      if (text[index + 1] !== '\n') endRow()
    } else {
      field += character
      fieldStarted = true
    }
  }

  if (fieldStarted || field !== '' || row.length > 0) endRow()
  return rows
}

function isPasswordKey(key: string): boolean {
  return PASSWORD_KEYS.includes(key) || key.includes('password') || key.includes('mot de passe')
}

function normalizeKey(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
