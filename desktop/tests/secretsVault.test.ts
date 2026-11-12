import { spawnSync } from 'node:child_process'
import { generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { generateSecret } from '../src/main/generator'
import { findProjectFile, isGitIgnored, writeProjectFile } from '../src/main/projectFile'
import {
  GitHubProvider,
  GitLabProvider,
  openSealedBox,
  sealBox,
  type HttpResponse,
} from '../src/main/providers'
import { SecretsService } from '../src/main/secretsVault'
import { buildSyncPlan, validateForProvider } from '../src/main/sync'
import { VaultService } from '../src/main/vault'

const MASTER = 'correct horse battery staple'
const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url))
const PYTHON = process.platform === 'win32' ? 'python' : 'python3'
const PYTHON_AVAILABLE =
  spawnSync(PYTHON, ['-c', 'import cryptography'], { encoding: 'utf8' }).status === 0

let directory: string
const secretsPath = () => join(directory, 'secrets.enc')
const pwdPath = () => join(directory, 'vault.enc')

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'robust-pwd-secrets-'))
})

afterEach(() => {
  rmSync(directory, { recursive: true, force: true })
})

describe('générateur de secrets applicatifs', () => {
  it('produit des secrets hex, base64, uuid et google valides', () => {
    expect(generateSecret('hex:32')).toMatch(/^[0-9a-f]{64}$/)
    expect(generateSecret('hex:16')).toMatch(/^[0-9a-f]{32}$/)
    expect(generateSecret('base64:32')).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(generateSecret('uuid')).toMatch(/^[0-9a-f-]{36}$/)
    expect(generateSecret('google:32')).toHaveLength(32)
  })
})

describe('coffre de secrets (SecretsService)', () => {
  it('crée, gère projets/environnements/variables et change le mot de passe maître', async () => {
    const service = new SecretsService(secretsPath())
    expect(service.exists()).toBe(false)

    const initial = await service.create(MASTER)
    expect(initial.projects).toEqual([])
    expect(service.unlocked).toBe(true)

    const proj = service.addProject({ name: 'mon-api', description: 'Backend' })
    expect(proj.id).toBe(1)
    expect(proj.environments.map((e) => e.name)).toEqual(['local', 'staging', 'production'])

    const updated = service.upsertVariable({
      projectId: proj.id,
      environment: 'local',
      key: 'DATABASE_URL',
      value: 'postgresql://localhost/app',
      masked: true,
    })
    const localEnv = updated.environments.find((e) => e.name === 'local')
    expect(localEnv?.variables).toHaveLength(1)
    expect(localEnv?.variables[0]).toMatchObject({
      key: 'DATABASE_URL',
      length: 26,
      masked: true,
    })
    expect(service.revealVariable(proj.id, 'local', 'DATABASE_URL')).toBe(
      'postgresql://localhost/app',
    )

    await service.changePassword(MASTER, 'new-strong-master-pass')
    service.lock()
    await expect(service.unlock(MASTER)).rejects.toMatchObject({ code: 'BAD_MASTER' })
    const state = await service.unlock('new-strong-master-pass')
    expect(state.projects).toHaveLength(1)
  })

  it('empêche d’ouvrir vault.enc comme secrets.enc et inversement', async () => {
    const pwdVault = new VaultService(pwdPath())
    await pwdVault.create(MASTER)
    pwdVault.lock()

    const secVault = new SecretsService(secretsPath())
    await secVault.create(MASTER)
    secVault.lock()

    const wrongSecrets = new SecretsService(pwdPath())
    await expect(wrongSecrets.unlock(MASTER)).rejects.toMatchObject({ code: 'WRONG_KIND' })

    const wrongPwd = new VaultService(secretsPath())
    await expect(wrongPwd.unlock(MASTER)).rejects.toMatchObject({ code: 'WRONG_KIND' })
  })
})

describe('fichier .robust-pwd.json et gitignore', () => {
  it('écrit et retrouve .robust-pwd.json en remontant les dossiers', () => {
    writeFileSync(join(directory, '.git'), '')
    writeProjectFile('mon-api', 'staging', directory)
    const nested = join(directory, 'a', 'b')
    mkdtempSync(join(tmpdir(), 'unused-'))
    const found = findProjectFile(directory)
    expect(found?.config).toEqual({ project: 'mon-api', environment: 'staging' })
    expect(nested).toBeTruthy()
  })

  it('vérifie si un chemin est ignoré par Git', () => {
    expect(isGitIgnored(join(REPO_ROOT, '.env'))).toBe(true)
    expect(isGitIgnored(join(REPO_ROOT, 'README.md'))).toBe(false)
  })
})

describe('plan de synchronisation et fournisseurs', () => {
  it('calcule les plans GitLab et GitHub et valide les contraintes', () => {
    const gitlabPlan = buildSyncPlan({
      provider: 'gitlab',
      target: 'grp/app',
      environment: 'production',
      scope: 'production',
      localVars: [
        { key: 'A', value: '12345678', masked: true },
        { key: 'B', value: 'changed' },
      ],
      remoteVars: [
        { key: 'A', value: '12345678', masked: true },
        { key: 'B', value: 'old' },
        { key: 'C', value: 'orphan' },
      ],
      prune: true,
    })
    expect(gitlabPlan.errors).toEqual([])
    expect(gitlabPlan.items.map((i) => [i.key, i.action])).toEqual([
      ['B', 'update'],
      ['C', 'delete'],
      ['A', 'unchanged'],
    ])

    expect(
      validateForProvider('gitlab', [{ key: 'SHORT', value: 'abc', masked: true }]),
    ).toHaveLength(1)
    expect(
      validateForProvider('github', [{ key: 'GITHUB_BAD', value: 'ok' }]),
    ).toHaveLength(1)
  })

  it('pilote GitLabProvider et GitHubProvider avec transport simulé', async () => {
    const glCalls: string[] = []
    const glTransport = async (method: string, url: string): Promise<HttpResponse> => {
      glCalls.push(`${method} ${url}`)
      if (url.endsWith('/user')) {
        return { status: 200, headers: {}, body: JSON.stringify({ username: 'alice' }) }
      }
      if (method === 'GET' && url.includes('/variables')) {
        return {
          status: 200,
          headers: {},
          body: JSON.stringify([
            {
              key: 'A',
              value: '1',
              environment_scope: 'production',
              masked: false,
              protected: false,
              raw: true,
              variable_type: 'env_var',
            },
          ]),
        }
      }
      return { status: 200, headers: {}, body: '{}' }
    }

    const gl = new GitLabProvider('https://gitlab.example.com', 'glpat-1', glTransport)
    expect(await gl.verifyToken()).toBe('alice')
    expect(await gl.listRemote('grp/app', 'production')).toHaveLength(1)
    const glRes = await gl.applyPlan(
      'grp/app',
      'production',
      [{ key: 'NEW', value: 'val' }],
      [{ key: 'NEW', action: 'create', masked: false, protected: false, raw: true, type: 'env_var' }],
    )
    expect(glRes.created).toBe(1)

    // GitHub + boîte scellée
    const kp = generateKeyPairSync('x25519')
    const pubDer = kp.publicKey.export({ type: 'spki', format: 'der' }) as Buffer
    const privDer = kp.privateKey.export({ type: 'pkcs8', format: 'der' }) as Buffer
    const pubB64 = pubDer.subarray(pubDer.length - 32).toString('base64')
    const privRaw = privDer.subarray(privDer.length - 32)

    let sentEncrypted = ''
    const ghTransport = async (
      method: string,
      url: string,
      _headers: Record<string, string>,
      body?: string,
    ): Promise<HttpResponse> => {
      if (url.endsWith('/user')) {
        return { status: 200, headers: {}, body: JSON.stringify({ login: 'octocat' }) }
      }
      if (url.endsWith('/public-key')) {
        return {
          status: 200,
          headers: {},
          body: JSON.stringify({ key_id: 'k1', key: pubB64 }),
        }
      }
      if (method === 'PUT' && body) {
        sentEncrypted = (JSON.parse(body) as { encrypted_value: string }).encrypted_value
        return { status: 204, headers: {}, body: '' }
      }
      return { status: 200, headers: {}, body: JSON.stringify({ secrets: [] }) }
    }

    const gh = new GitHubProvider('https://api.github.com', 'ghp_1', ghTransport)
    expect(await gh.verifyToken()).toBe('octocat')
    await gh.applyPlan(
      'owner/repo',
      '*',
      [{ key: 'SECRET_KEY', value: 'hello-github' }],
      [
        {
          key: 'SECRET_KEY',
          action: 'create',
          masked: true,
          protected: false,
          raw: true,
          type: 'env_var',
        },
      ],
    )
    expect(openSealedBox(sentEncrypted, privRaw).toString('utf8')).toBe('hello-github')
  })
})

describe.skipIf(!PYTHON_AVAILABLE)('compatibilité croisée avec Python (secrets.enc + sealed box)', () => {
  function runPython(code: string, args: string[]): string {
    const result = spawnSync(PYTHON, ['-c', code, ...args], { encoding: 'utf8' })
    if (result.status !== 0) {
      throw new Error(`${PYTHON} a échoué : ${result.stderr}`)
    }
    return result.stdout
  }

  it('lit un coffre secrets.enc écrit par Python et inversement', async () => {
    runPython(
      [
        'import sys',
        'from pathlib import Path',
        'sys.path.insert(0, sys.argv[1])',
        'from robust_pwd import secrets_vault as sv',
        'path = Path(sys.argv[2])',
        'doc = sv.create_secrets_vault(sys.argv[3], path)',
        'sv.add_project(doc, "api-core", description="Partagé")',
        'sv.set_variable(doc, "api-core", "production", "JWT_SECRET", "s3cr3t-value", masked=True)',
        'sv.link_remote(doc, "api-core", "gitlab", "mon-groupe/api-core")',
        'sv.set_remote_scope(doc, "api-core", "production", "production")',
        'sv.save_secrets_vault(doc, sys.argv[3], path)',
      ].join('\n'),
      [REPO_ROOT, secretsPath(), MASTER],
    )

    const service = new SecretsService(secretsPath())
    const state = await service.unlock(MASTER)
    expect(state.projects).toHaveLength(1)
    expect(state.projects[0].name).toBe('api-core')
    expect(state.projects[0].remote).toEqual({
      provider: 'gitlab',
      host: 'https://gitlab.com',
      target: 'mon-groupe/api-core',
    })
    expect(service.revealVariable(1, 'production', 'JWT_SECRET')).toBe('s3cr3t-value')

    // Ajout côté Desktop puis relecture côté Python
    service.upsertVariable({
      projectId: 1,
      environment: 'local',
      key: 'PORT',
      value: '4000',
    })

    const out = runPython(
      [
        'import json, sys',
        'from pathlib import Path',
        'sys.path.insert(0, sys.argv[1])',
        'from robust_pwd import secrets_vault as sv',
        'doc = sv.load_secrets_vault(sys.argv[3], Path(sys.argv[2]))',
        'var = sv.get_variable(doc, "api-core", "local", "PORT")',
        'print(json.dumps(var))',
      ].join('\n'),
      [REPO_ROOT, secretsPath(), MASTER],
    )
    expect(JSON.parse(out)).toMatchObject({ key: 'PORT', value: '4000' })
  })

  it('chiffre une boîte scellée GitHub en TS lisible par Python et inversement', () => {
    const kp = generateKeyPairSync('x25519')
    const pubDer = kp.publicKey.export({ type: 'spki', format: 'der' }) as Buffer
    const privDer = kp.privateKey.export({ type: 'pkcs8', format: 'der' }) as Buffer
    const pubB64 = pubDer.subarray(pubDer.length - 32).toString('base64')
    const privRaw = privDer.subarray(privDer.length - 32)

    const sealedByTs = sealBox(Buffer.from('depuis-ts ☕', 'utf8'), pubB64)
    const openedByPy = runPython(
      [
        'import base64, sys',
        'sys.path.insert(0, sys.argv[1])',
        'from robust_pwd.providers import open_sealed_box, seal_box',
        'plain = open_sealed_box(sys.argv[2], base64.b64decode(sys.argv[3])).decode("utf-8")',
        're_sealed = seal_box("depuis-python 🚀".encode("utf-8"), sys.argv[4])',
        'print(plain)',
        'print(re_sealed)',
      ].join('\n'),
      [REPO_ROOT, sealedByTs, privRaw.toString('base64'), pubB64],
    )
      .trim()
      .split('\n')

    expect(openedByPy[0]).toBe('depuis-ts ☕')
    expect(openSealedBox(openedByPy[1], privRaw).toString('utf8')).toBe('depuis-python 🚀')
  })
})

