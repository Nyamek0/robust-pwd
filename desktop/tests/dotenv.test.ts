import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parse, serialize, type DotenvVariable } from '../src/main/dotenv'
import type { DotenvExportFormat } from '../src/shared/secretsTypes'

const FIXTURES_DIR = fileURLToPath(new URL('../../tests/fixtures/dotenv', import.meta.url))

describe('dotenv (fixtures partagées avec Python)', () => {
  it('parse toutes les fixtures .env à l’identique du CLI Python', () => {
    const files = readdirSync(FIXTURES_DIR)
      .filter((name) => name.endsWith('.env') && !name.startsWith('serialize.'))
      .sort()
    expect(files.length).toBeGreaterThan(5)

    for (const file of files) {
      const content = readFileSync(join(FIXTURES_DIR, file), 'utf8')
      const expected = JSON.parse(
        readFileSync(join(FIXTURES_DIR, file.replace(/\.env$/, '.expected.json')), 'utf8'),
      )
      expect(parse(content), file).toEqual(expected)
    }
  })

  it('sérialise aux formats dotenv, shell et json à l’identique du CLI Python', () => {
    const input = JSON.parse(
      readFileSync(join(FIXTURES_DIR, 'serialize.input.json'), 'utf8'),
    ) as DotenvVariable[]

    const cases: Array<[DotenvExportFormat, string]> = [
      ['dotenv', 'serialize.expected.env'],
      ['shell', 'serialize.expected.sh'],
      ['json', 'serialize.expected.json'],
    ]

    for (const [format, filename] of cases) {
      const expected = readFileSync(join(FIXTURES_DIR, filename), 'utf8')
      expect(serialize(input, format), format).toBe(expected)
    }
  })

  it('garantit parse(serialize(vars)) == vars', () => {
    const input = JSON.parse(
      readFileSync(join(FIXTURES_DIR, 'serialize.input.json'), 'utf8'),
    ) as DotenvVariable[]
    const extended: DotenvVariable[] = [
      ...input,
      { key: 'TRAILING_BACKSLASH', value: 'a\\' },
      { key: 'CR', value: 'a\rb' },
      { key: 'SPACES', value: '  padded  ' },
    ]
    const roundtrip = parse(serialize(extended, 'dotenv'))
    expect(roundtrip.variables).toEqual(extended)
    expect(roundtrip.invalid_lines).toEqual([])
  })
})

