import type { GenerateStyle, PasswordStyle } from './types'

const APPLE_CONSONANT_BITS = Math.log2(21)
const APPLE_VOWEL_BITS = Math.log2(5)
const GOOGLE_ALPHABET_SIZE = 26 + 26 + 10 + 8

export interface Strength {
  /** Entropie approximative en bits. */
  bits: number
  label: string
  /** 1 (faible) → 4 (excellent). */
  level: number
}

const APPLE_BITS =
  3 * (3 * APPLE_CONSONANT_BITS + 2 * APPLE_VOWEL_BITS) + Math.log2(10) + Math.log2(7) + Math.log2(5)

/** Entropie d'un mot de passe généré, à partir de sa longueur (sans le connaître). */
export function entropyForStyle(length: number, style: GenerateStyle): Strength {
  const bits = style === 'apple' ? APPLE_BITS : length * Math.log2(GOOGLE_ALPHABET_SIZE)
  return { bits, ...strengthFromBits(bits) }
}

/** Estimation alignée sur les générateurs Apple / Google du projet. */
export function estimateEntropy(password: string, style: PasswordStyle): Strength {
  if (style === 'custom') return estimatePasswordStrength(password)
  return entropyForStyle(password.length, style)
}

/** Estimation naïve d'un mot de passe saisi ou importé (longueur × classes de caractères). */
export function estimatePasswordStrength(password: string): Strength {
  if (!password) return { bits: 0, ...strengthFromBits(0) }

  let pool = 0
  if (/[a-z]/.test(password)) pool += 26
  if (/[A-Z]/.test(password)) pool += 26
  if (/\d/.test(password)) pool += 10
  if (/[^A-Za-z0-9]/.test(password)) pool += 33

  const bits = password.length * Math.log2(Math.max(pool, 2))
  return { bits, ...strengthFromBits(bits) }
}

export function strengthFromBits(bits: number): Omit<Strength, 'bits'> {
  if (bits >= 100) return { label: 'Excellent', level: 4 }
  if (bits >= 75) return { label: 'Fort', level: 3 }
  if (bits >= 55) return { label: 'Bon', level: 2 }
  if (bits >= 40) return { label: 'Moyen', level: 1 }
  return { label: 'Faible', level: 1 }
}

/** Estimation pour un mot de passe maître saisi à la main. */
export function estimateMasterStrength(password: string): Strength {
  return estimatePasswordStrength(password)
}
