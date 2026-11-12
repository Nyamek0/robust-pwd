/**
 * Lecture et écriture de fichiers `.env` (voir `docs/secrets-format.md`, §3).
 *
 * Implémentation jumelle de `robust_pwd/dotenv.py` : les deux doivent produire
 * exactement les mêmes résultats sur `tests/fixtures/dotenv/`.
 */

import type { DotenvExportFormat } from '../shared/secretsTypes'
import { VaultError } from './crypto'

export interface DotenvVariable {
  key: string
  value: string
}

export interface DotenvParseResult {
  variables: DotenvVariable[]
  duplicates: string[]
  invalid_lines: number[]
}

const KEY_RE = /^([A-Za-z_][A-Za-z0-9_]*)[ \t]*=/
const EXPORT_RE = /^export[ \t]+/
const PLAIN_RE = /^[A-Za-z0-9_./:@%+,=-]*$/
const DQ_ESCAPES: Record<string, string> = {
  n: '\n',
  r: '\r',
  t: '\t',
  '"': '"',
  '\\': '\\',
}

function restIsComment(rest: string): boolean {
  const stripped = rest.replace(/^[ \t]+/, '')
  if (!stripped) return true
  return stripped.startsWith('#') && stripped.length < rest.length
}

function readQuoted(
  lines: string[],
  index: number,
  start: number,
  quote: '"' | "'",
): { value: string; endIndex: number; rest: string } | null {
  let out = ''
  let i = index
  let pos = start
  while (i < lines.length) {
    const line = lines[i]
    while (pos < line.length) {
      const ch = line[pos]
      if (quote === '"' && ch === '\\' && pos + 1 < line.length) {
        const nxt = line[pos + 1]
        out += nxt in DQ_ESCAPES ? DQ_ESCAPES[nxt] : ch + nxt
        pos += 2
        continue
      }
      if (ch === quote) {
        return { value: out, endIndex: i, rest: line.slice(pos + 1) }
      }
      out += ch
      pos += 1
    }
    out += '\n'
    i += 1
    pos = 0
  }
  return null
}

export function parse(text: string): DotenvParseResult {
  let normalized = text.startsWith('\ufeff') ? text.slice(1) : text
  normalized = normalized.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  const lines = normalized.split('\n')

  const values = new Map<string, string>()
  const order: string[] = []
  const duplicates: string[] = []
  const invalid: number[] = []

  const store = (key: string, value: string): void => {
    if (values.has(key)) {
      if (!duplicates.includes(key)) duplicates.push(key)
    } else {
      order.push(key)
    }
    values.set(key, value)
  }

  let i = 0
  while (i < lines.length) {
    const number = i + 1
    let line = lines[i].replace(/^[ \t]+/, '')
    if (!line || line.startsWith('#')) {
      i += 1
      continue
    }
    line = line.replace(EXPORT_RE, '')
    const match = KEY_RE.exec(line)
    if (!match) {
      invalid.push(number)
      i += 1
      continue
    }
    const key = match[1]
    const raw = line.slice(match[0].length)
    const stripped = raw.replace(/^[ \t]+/, '')

    if (stripped.startsWith('"') || stripped.startsWith("'")) {
      const quote = stripped[0] as '"' | "'"
      const offset = lines[i].length - stripped.length + 1
      const result = readQuoted(lines, i, offset, quote)
      if (!result) {
        invalid.push(number)
        i += 1
        continue
      }
      if (!restIsComment(result.rest)) {
        invalid.push(number)
        i = result.endIndex + 1
        continue
      }
      store(key, result.value)
      i = result.endIndex + 1
      continue
    }

    let cut = raw.length
    for (let pos = 0; pos < raw.length; pos += 1) {
      if (raw[pos] === '#' && pos > 0 && (raw[pos - 1] === ' ' || raw[pos - 1] === '\t')) {
        cut = pos
        break
      }
    }
    store(
      key,
      raw
        .slice(0, cut)
        .replace(/^[ \t]+/, '')
        .replace(/[ \t]+$/, ''),
    )
    i += 1
  }

  return {
    variables: order.map((key) => ({ key, value: values.get(key) ?? '' })),
    duplicates,
    invalid_lines: invalid,
  }
}

function formatValue(value: string): string {
  if (value === '') return ''
  if (PLAIN_RE.test(value)) return value
  if (!value.includes("'") && !value.includes('\n') && !value.includes('\r')) {
    return `'${value}'`
  }
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t')
  return `"${escaped}"`
}

export function serialize(
  variables: DotenvVariable[],
  format: DotenvExportFormat = 'dotenv',
): string {
  if (format === 'dotenv') {
    return variables.map((v) => `${v.key}=${formatValue(v.value)}\n`).join('')
  }
  if (format === 'shell') {
    return variables
      .map((v) => `export ${v.key}='${v.value.replace(/'/g, "'\\''")}'\n`)
      .join('')
  }
  if (format === 'json') {
    const obj: Record<string, string> = {}
    for (const v of variables) obj[v.key] = v.value
    return JSON.stringify(obj, null, 2) + '\n'
  }
  throw new VaultError('INVALID', `Format inconnu : « ${String(format)} » (attendu : dotenv, shell, json).`)
}

