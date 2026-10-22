import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { VaultError } from '../src/main/crypto'
import { generateApple, generateGoogle } from '../src/main/generator'
import { VaultService } from '../src/main/vault'
import { entropyForStyle } from '../src/shared/entropy'

const MASTER = 'correct horse battery staple'
const PYTHON = process.platform === 'win32' ? 'python' : 'python3'
const PYTHON_AVAILABLE =
  spawnSync(PYTHON, ['-c', 'import cryptography'], { encoding: 'utf8' }).status === 0

let directory: string
const vaultPath = () => join(directory, 'vault.enc')

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'robust-pwd-'))
})

afterEach(() => {
  rmSync(directory, { recursive: true, force: true })
})

describe('générateurs', () => {
  it('produit des mots de passe Apple au bon format', () => {
    for (let index = 0; index < 50; index += 1) {
      const password = generateApple()
      expect(password).toMatch(/^[a-z]{5}-[a-z0-9]{6}-[a-zA-Z]{5}$/)
      const thirdGroup = password.split('-')[2]
      expect(thirdGroup).toMatch(/[A-Z]/)
      expect(thirdGroup.replace(/[A-Z]/, '').length).toBe(4)
      expect(password.replace(/-/g, '').match(/\d/g)).toHaveLength(1)
    }
  })

  it('produit des mots de passe Google longs et variés', () => {
    for (let index = 0; index < 50; index += 1) {
      const password = generateGoogle(24)
      expect(password).toHaveLength(24)
      expect(password).toMatch(/[A-Z]/)
      expect(password).toMatch(/[a-z]/)
      expect(password).toMatch(/\d/)
      expect(password).toMatch(/[!@#$%^&*]/)
    }
  })

  it('borne la longueur Google', () => {
    expect(generateGoogle(2)).toHaveLength(12)
    expect(generateGoogle(500)).toHaveLength(48)
  })

  it('estime une entropie plausible', () => {
    expect(entropyForStyle(18, 'apple').bits).toBeGreaterThan(55)
    expect(entropyForStyle(18, 'apple').level).toBe(2)
    expect(entropyForStyle(18, 'google').level).toBe(4)
  })
})

describe('coffre', () => {
  it('crée, enregistre, relit et supprime des entrées', async () => {
    const vault = new VaultService(vaultPath())
    expect(vault.exists()).toBe(false)

    await vault.create(MASTER)
    expect(vault.exists()).toBe(true)
    expect(vault.unlocked).toBe(true)
    expect(vault.list()).toEqual([])

    const added = await vault.add({
      label: 'GitHub',
      password: 'Kj#9mLpQ2$vXn8!wR#',
      style: 'google',
    })
    expect(added.id).toBe(1)
    expect(added.length).toBe(18)
    expect(vault.reveal(added.id)).toBe('Kj#9mLpQ2$vXn8!wR#')

    const second = await vault.add({
      label: 'Café ☕',
      password: generateApple(),
      style: 'apple',
    })
    expect(second.id).toBe(2)
    expect(vault.list().map((entry) => entry.label)).toEqual(['Café ☕', 'GitHub'])

    // Un nouveau service (comme un redémarrage de l'app) doit tout relire.
    const reopened = new VaultService(vaultPath())
    const entries = await reopened.unlock(MASTER)
    expect(entries).toHaveLength(2)
    expect(reopened.reveal(1)).toBe('Kj#9mLpQ2$vXn8!wR#')

    reopened.remove(1)
    expect(reopened.list()).toHaveLength(1)
    const again = new VaultService(vaultPath())
    await again.unlock(MASTER)
    expect(again.list().map((entry) => entry.label)).toEqual(['Café ☕'])
  })

  it('refuse un mauvais mot de passe maître', async () => {
    const vault = new VaultService(vaultPath())
    await vault.create(MASTER)

    const other = new VaultService(vaultPath())
    await expect(other.unlock('mauvais')).rejects.toMatchObject({ code: 'BAD_MASTER' })
    expect(other.unlocked).toBe(false)
  })

  it('rejette un fichier corrompu', async () => {
    const vault = new VaultService(vaultPath())
    await vault.create(MASTER)

    const { writeFileSync, readFileSync } = await import('node:fs')
    const blob = readFileSync(vaultPath())
    blob[blob.length - 1] ^= 0xff
    writeFileSync(vaultPath(), blob)

    const other = new VaultService(vaultPath())
    await expect(other.unlock(MASTER)).rejects.toMatchObject({ code: 'BAD_MASTER' })
  })

  it('protège le fichier et le dossier', async () => {
    if (process.platform === 'win32') return
    const vault = new VaultService(vaultPath())
    await vault.create(MASTER)
    await vault.add({ label: 'Test', password: 'Abcdef1!', style: 'google' })

    expect(statSync(vaultPath()).mode & 0o777).toBe(0o600)
    expect(statSync(directory).mode & 0o777).toBe(0o700)
  })

  it('verrouille et efface la clé', async () => {
    const vault = new VaultService(vaultPath())
    await vault.create(MASTER)
    const events: string[] = []
    vault.on('locked', (reason: string) => events.push(reason))

    vault.lock('manual')
    expect(vault.unlocked).toBe(false)
    expect(events).toEqual(['manual'])
    expect(() => vault.list()).toThrow(VaultError)
    expect(() => vault.list()).toThrow(/verrouillé/)
  })

  it('se verrouille automatiquement après inactivité', async () => {
    const vault = new VaultService(vaultPath(), 40)
    await vault.create(MASTER)

    const reason = await new Promise<string>((resolve) => {
      vault.once('locked', resolve)
    })
    expect(reason).toBe('idle')
    expect(vault.unlocked).toBe(false)
  })

  it('refuse de créer deux fois et valide les entrées', async () => {
    const vault = new VaultService(vaultPath())
    await vault.create(MASTER)
    await expect(vault.create(MASTER)).rejects.toMatchObject({ code: 'EXISTS' })

    await expect(vault.add({ label: '', password: 'Abcdef1!', style: 'apple' })).rejects.toMatchObject({
      code: 'INVALID',
    })
    await expect(vault.add({ label: 'x', password: 'a', style: 'apple' })).rejects.toMatchObject({
      code: 'INVALID',
    })
    await expect(
      vault.add({ label: 'x', password: 'Abcdef1!', style: 'nope' as 'apple' }),
    ).rejects.toMatchObject({ code: 'INVALID' })
  })

  it('importe des mots de passe existants en une seule écriture', async () => {
    const vault = new VaultService(vaultPath())
    await vault.create(MASTER)
    await vault.add({ label: 'GitHub', password: 'Abcdef1!', style: 'google' })

    const result = vault.importMany([
      { label: 'GitHub', password: 'Abcdef1!' },
      { label: 'Banque', password: 'Kj#9mLpQ2$vXn8!wR#' },
      { label: 'Café ☕', password: 'xovuk-8Nevqe-hidwuf' },
      { label: 'x'.repeat(81), password: 'Abcdef1!' },
      { label: '', password: 'Abcdef1!' },
    ])

    expect(result).toEqual({ added: 2, skipped: 3 })
    const customEntries = vault.list().filter((entry) => entry.style === 'custom')
    expect(customEntries.map((entry) => entry.label)).toEqual(['Café ☕', 'Banque'])

    const reopened = new VaultService(vaultPath())
    await reopened.unlock(MASTER)
    expect(reopened.list()).toHaveLength(3)
    const banque = reopened.list().find((entry) => entry.label === 'Banque')
    expect(banque?.style).toBe('custom')
    expect(banque && reopened.reveal(banque.id)).toBe('Kj#9mLpQ2$vXn8!wR#')
  })

  it('accepte un style personnalisé pour une saisie manuelle', async () => {
    const vault = new VaultService(vaultPath())
    await vault.create(MASTER)

    const entry = await vault.add({ label: 'Ancien compte', password: 'abcd', style: 'custom' })
    expect(entry.style).toBe('custom')
    expect(vault.reveal(entry.id)).toBe('abcd')
  })

  it('refuse un import vide', async () => {
    const vault = new VaultService(vaultPath())
    await vault.create(MASTER)
    expect(() => vault.importMany([])).toThrow(VaultError)
  })

  it('exige un mot de passe maître suffisant', async () => {
    const vault = new VaultService(vaultPath())
    await expect(vault.create('court')).rejects.toMatchObject({ code: 'WEAK_MASTER' })
  })
})

describe.skipIf(!PYTHON_AVAILABLE)('compatibilité avec pwdgen.py', () => {
  function runPython(code: string, args: string[]): string {
    const result = spawnSync(PYTHON, ['-c', code, ...args], { encoding: 'utf8' })
    if (result.status !== 0) {
      throw new Error(`${PYTHON} a échoué : ${result.stderr}`)
    }
    return result.stdout
  }

  it('lit un coffre écrit par le CLI Python', async () => {
    runPython(
      [
        'import sys',
        'from pathlib import Path',
        'sys.path.insert(0, sys.argv[1])',
        'import pwdgen',
        'pwdgen.VAULT_PATH = Path(sys.argv[2])',
        'pwdgen._save_vault({"entries": [',
        '  {"id": 7, "label": "GitHub", "password": "Kj#9mLpQ2$vXn8!wR#", "style": "google",',
        '   "created_at": "2026-10-22T12:00:00"}',
        ']}, sys.argv[3])',
      ].join('\n'),
      [fileURLToPath(new URL('../..', import.meta.url)), vaultPath(), MASTER],
    )

    const vault = new VaultService(vaultPath())
    const entries = await vault.unlock(MASTER)
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ id: 7, label: 'GitHub', style: 'google', length: 18 })
    expect(vault.reveal(7)).toBe('Kj#9mLpQ2$vXn8!wR#')
  })

  it('écrit un coffre lisible par le CLI Python', async () => {
    const vault = new VaultService(vaultPath())
    await vault.create(MASTER)
    await vault.add({ label: 'Café ☕', password: 'xovuk-8Nevqe-hidwuf', style: 'apple' })
    vault.importMany([{ label: 'GitHub', password: 'Kj#9mLpQ2$vXn8!wR#' }])

    const output = runPython(
      [
        'import json, sys',
        'from pathlib import Path',
        'sys.path.insert(0, sys.argv[1])',
        'import pwdgen',
        'pwdgen.VAULT_PATH = Path(sys.argv[2])',
        'print(json.dumps(pwdgen._load_vault(sys.argv[3])))',
      ].join('\n'),
      [fileURLToPath(new URL('../..', import.meta.url)), vaultPath(), MASTER],
    )

    const parsed = JSON.parse(output) as { entries: Array<Record<string, string>> }
    expect(parsed.entries).toHaveLength(2)
    const cafe = parsed.entries.find((entry) => entry.label === 'Café ☕')
    expect(cafe?.password).toBe('xovuk-8Nevqe-hidwuf')
    expect(cafe?.style).toBe('apple')
    const imported = parsed.entries.find((entry) => entry.label === 'GitHub')
    expect(imported?.password).toBe('Kj#9mLpQ2$vXn8!wR#')
    expect(imported?.style).toBe('custom')
  })
})
