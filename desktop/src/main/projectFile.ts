/**
 * Fichier projet `.robust-pwd.json` et vérification `.gitignore` (voir `docs/secrets-format.md`, §4).
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { VaultError } from './crypto'
import { validateEnvName, validateProjectName } from './secretsVault'

export const PROJECT_FILENAME = '.robust-pwd.json'

export interface ProjectFileConfig {
  project: string
  environment: string
}

export function parseProjectFile(raw: string, source?: string): ProjectFileConfig {
  const loc = source ? ` (${source})` : ''
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new VaultError('INVALID', `Fichier ${PROJECT_FILENAME} illisible${loc}.`)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new VaultError('INVALID', `Fichier ${PROJECT_FILENAME} invalide${loc}.`)
  }
  const obj = parsed as Record<string, unknown>
  const project = validateProjectName(typeof obj.project === 'string' ? obj.project : '')
  const environment =
    typeof obj.environment === 'string' && obj.environment.trim()
      ? validateEnvName(obj.environment)
      : 'local'
  return { project, environment }
}

export function findProjectFile(
  startDir: string = process.cwd(),
): { path: string; config: ProjectFileConfig } | null {
  let current = resolve(startDir)
  for (;;) {
    const candidate = join(current, PROJECT_FILENAME)
    if (existsSync(candidate) && statSync(candidate).isFile()) {
      const text = readFileSync(candidate, 'utf8')
      return { path: candidate, config: parseProjectFile(text, candidate) }
    }
    if (existsSync(join(current, '.git'))) {
      return null
    }
    const parent = dirname(current)
    if (parent === current) return null
    current = parent
  }
}

export function writeProjectFile(
  project: string,
  environment: string = 'local',
  directory: string = process.cwd(),
): string {
  const cleanProject = validateProjectName(project)
  const cleanEnv = validateEnvName(environment)
  const target = join(resolve(directory), PROJECT_FILENAME)
  const payload = JSON.stringify({ project: cleanProject, environment: cleanEnv }, null, 2) + '\n'
  writeFileSync(target, payload, 'utf8')
  return target
}

/**
 * Retourne `true` si `filePath` est ignoré par Git, `false` s'il se trouve dans un
 * dépôt Git sans être ignoré, ou `null` hors dépôt Git / si `git` est indisponible.
 */
export function isGitIgnored(filePath: string): boolean | null {
  const resolved = resolve(filePath)
  const cwd = existsSync(dirname(resolved)) ? dirname(resolved) : process.cwd()
  try {
    const inside = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd,
      encoding: 'utf8',
      timeout: 3000,
    })
    if (inside.status !== 0 || inside.stdout.trim() !== 'true') return null
    const check = spawnSync('git', ['check-ignore', '-q', resolved], {
      cwd,
      timeout: 3000,
    })
    if (check.status === 0) return true
    if (check.status === 1) return false
    return null
  } catch {
    return null
  }
}

