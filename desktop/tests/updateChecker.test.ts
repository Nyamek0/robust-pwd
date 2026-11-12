import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getVersion: () => '1.1.0' },
  shell: { openExternal: vi.fn() },
}))

import { isNewerVersion } from '../src/main/updateChecker'

describe('isNewerVersion', () => {
  it('détecte les versions plus récentes avec ou sans préfixe v', () => {
    expect(isNewerVersion('v1.2.0', '1.1.0')).toBe(true)
    expect(isNewerVersion('1.1.1', '1.1.0')).toBe(true)
    expect(isNewerVersion('v2.0.0', '1.9.9')).toBe(true)
  })

  it('retourne false pour une version identique ou plus ancienne', () => {
    expect(isNewerVersion('v1.1.0', '1.1.0')).toBe(false)
    expect(isNewerVersion('1.0.9', '1.1.0')).toBe(false)
    expect(isNewerVersion('v1.1.0-beta.1', '1.1.0')).toBe(false)
  })

  it('retourne false sur des formats invalides', () => {
    expect(isNewerVersion('invalid', '1.1.0')).toBe(false)
    expect(isNewerVersion('v1.2.0', 'not-a-version')).toBe(false)
  })
})

