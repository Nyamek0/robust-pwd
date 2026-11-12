import { app, shell } from 'electron'
import type { UpdateInfo } from '../shared/types'

const RELEASES_API_URL = 'https://api.github.com/repos/Nyamek0/robust-pwd/releases/latest'
const RELEASES_PAGE_PREFIX = 'https://github.com/Nyamek0/robust-pwd/releases/'

function parseSemver(raw: string): [number, number, number] | null {
  const cleaned = raw.trim().replace(/^v/i, '').split('-')[0]
  const parts = cleaned.split('.')
  if (parts.length < 2 || parts.length > 3) return null
  const nums = parts.map((part) => Number(part))
  if (nums.some((n) => !Number.isInteger(n) || n < 0)) return null
  return [nums[0] ?? 0, nums[1] ?? 0, nums[2] ?? 0]
}

export function isNewerVersion(latestTag: string, currentVersion: string): boolean {
  const latest = parseSemver(latestTag)
  const current = parseSemver(currentVersion)
  if (!latest || !current) return false

  for (let i = 0; i < 3; i += 1) {
    if (latest[i] > current[i]) return true
    if (latest[i] < current[i]) return false
  }
  return false
}

export async function checkForReleaseUpdate(): Promise<UpdateInfo | null> {
  const currentVersion = app.getVersion()

  try {
    const response = await fetch(RELEASES_API_URL, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'robust-pwd-desktop',
      },
      signal: AbortSignal.timeout(5_000),
    })
    if (!response.ok) return null

    const data = (await response.json()) as {
      tag_name?: unknown
      html_url?: unknown
      name?: unknown
      draft?: unknown
      prerelease?: unknown
    }

    if (data.draft === true || data.prerelease === true) return null
    if (typeof data.tag_name !== 'string' || typeof data.html_url !== 'string') return null
    if (!data.html_url.startsWith(RELEASES_PAGE_PREFIX)) return null

    if (!isNewerVersion(data.tag_name, currentVersion)) return null

    return {
      currentVersion,
      latestVersion: data.tag_name.replace(/^v/i, ''),
      releaseUrl: data.html_url,
      releaseName: typeof data.name === 'string' && data.name.trim() ? data.name.trim() : undefined,
    }
  } catch {
    return null
  }
}

export async function openExternalReleaseUrl(url: string): Promise<void> {
  if (!url.startsWith(RELEASES_PAGE_PREFIX)) {
    throw new Error('URL de release non autorisée.')
  }
  await shell.openExternal(url)
}

