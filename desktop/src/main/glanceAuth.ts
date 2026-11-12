import { app } from 'electron'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { GlanceStatus } from '../shared/types'

export class GlanceError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GlanceError'
  }
}

interface RawStatusResponse {
  ok: boolean
  enrolled?: boolean
  hasSecret?: boolean
  model?: string
  error?: string
}

interface RawEnrollResponse {
  ok: boolean
  samples?: number
  model?: string
  error?: string
}

interface RawVerifyResponse {
  ok: boolean
  matched?: boolean
  similarity?: number
  model?: string
  master?: string | null
  error?: string
}

export function resolveGlanceBinary(): string | null {
  if (process.platform !== 'darwin') return null

  const candidates = [
    join(process.resourcesPath, 'bin', 'glance-auth'),
    join(app.getAppPath(), 'native', 'glance-auth', '.build', 'release', 'glance-auth'),
    join(app.getAppPath(), 'native', 'glance-auth', '.build', 'debug', 'glance-auth'),
    join(__dirname, '../../native/glance-auth/.build/release/glance-auth'),
    join(__dirname, '../../native/glance-auth/.build/debug/glance-auth'),
  ]

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

function runGlanceCli<T>(
  binary: string,
  args: string[],
  stdinInput?: string,
  timeoutMs = 20_000,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      reject(new GlanceError('Délai dépassé lors de la reconnaissance faciale.'))
    }, timeoutMs)

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })

    child.on('error', (error) => {
      clearTimeout(timer)
      reject(new GlanceError(`Impossible de lancer glance-auth : ${error.message}`))
    })

    child.on('close', () => {
      clearTimeout(timer)
      const lastLine = stdout
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .pop()

      if (!lastLine) {
        reject(new GlanceError(stderr.trim() || 'Aucune réponse de glance-auth.'))
        return
      }

      try {
        resolve(JSON.parse(lastLine) as T)
      } catch {
        reject(new GlanceError(`Réponse invalide de glance-auth : ${lastLine}`))
      }
    })

    if (stdinInput !== undefined) {
      child.stdin.write(stdinInput)
    }
    child.stdin.end()
  })
}

export async function getGlanceStatus(): Promise<GlanceStatus> {
  if (process.platform !== 'darwin') {
    return { supported: false, available: false, enrolled: false, hasSecret: false }
  }

  const binary = resolveGlanceBinary()
  if (!binary) {
    return { supported: true, available: false, enrolled: false, hasSecret: false }
  }

  try {
    const res = await runGlanceCli<RawStatusResponse>(binary, ['status'], undefined, 5_000)
    return {
      supported: true,
      available: Boolean(res.ok),
      enrolled: Boolean(res.enrolled),
      hasSecret: Boolean(res.hasSecret),
      model: res.model,
    }
  } catch {
    return { supported: true, available: false, enrolled: false, hasSecret: false }
  }
}

export async function enrollGlanceFace(master: string): Promise<{ samples: number; model: string }> {
  const binary = resolveGlanceBinary()
  if (!binary) {
    throw new GlanceError('Le helper natif glance-auth est introuvable (compilez desktop/native/glance-auth).')
  }

  const res = await runGlanceCli<RawEnrollResponse>(
    binary,
    ['enroll', '--samples', '5', '--timeout', '15'],
    `${master}\n`,
    20_000,
  )

  if (!res.ok) {
    throw new GlanceError(res.error || 'Échec de l’enregistrement facial.')
  }

  return {
    samples: res.samples ?? 0,
    model: res.model ?? 'arcface',
  }
}

export async function verifyGlanceFace(): Promise<{ master: string; similarity: number }> {
  const binary = resolveGlanceBinary()
  if (!binary) {
    throw new GlanceError('Le helper natif glance-auth est introuvable.')
  }

  const res = await runGlanceCli<RawVerifyResponse>(
    binary,
    ['verify', '--timeout', '10'],
    undefined,
    15_000,
  )

  if (!res.ok || !res.matched || !res.master) {
    throw new GlanceError(res.error || 'Visage non reconnu. Utilisez votre mot de passe maître.')
  }

  return {
    master: res.master,
    similarity: res.similarity ?? 0,
  }
}

export async function clearGlanceFace(): Promise<void> {
  const binary = resolveGlanceBinary()
  if (!binary) return
  await runGlanceCli<{ ok: boolean }>(binary, ['clear'], undefined, 5_000)
}

