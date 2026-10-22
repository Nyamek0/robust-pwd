import { randomInt } from 'node:crypto'
import { GOOGLE_DEFAULT_LENGTH, GOOGLE_MAX_LENGTH, GOOGLE_MIN_LENGTH } from '../shared/constants'
import type { GenerateRequest, PasswordStyle } from '../shared/types'
import { VaultError } from './crypto'

const VOWELS = 'aeiou'
const CONSONANTS = 'bcdfghjklmnpqrstvwxyz'
const SYMBOLS = '!@#$%^&*'
const GOOGLE_ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789' + SYMBOLS

function pick(pool: string): string {
  return pool[randomInt(pool.length)]
}

/** Équivalent de `_apple_group` dans pwdgen.py. */
function appleGroup(length: number): string {
  let out = ''
  for (let i = 0; i < length; i += 1) {
    out += i % 2 === 0 ? pick(CONSONANTS) : pick(VOWELS)
  }
  return out
}

/** Style Apple : xxx-xxxxx-xxxxx prononçable (ex. bazal-nur5uh-jaAat). */
export function generateApple(): string {
  const first = appleGroup(5)
  const middle = [...appleGroup(5)]
  middle.splice(randomInt(middle.length + 1), 0, String(randomInt(10)))
  const third = [...appleGroup(5)]
  const upperIndex = randomInt(third.length)
  third[upperIndex] = third[upperIndex].toUpperCase()
  return `${first}-${middle.join('')}-${third.join('')}`
}

/** Style Google : aléatoire fort, avec au moins une majuscule, minuscule, chiffre et symbole. */
export function generateGoogle(length: number = GOOGLE_DEFAULT_LENGTH): string {
  const size = clampLength(length)
  const chars = [
    pick('ABCDEFGHIJKLMNOPQRSTUVWXYZ'),
    pick('abcdefghijklmnopqrstuvwxyz'),
    pick('0123456789'),
    pick(SYMBOLS),
  ]
  while (chars.length < size) chars.push(pick(GOOGLE_ALPHABET))

  for (let i = chars.length - 1; i > 0; i -= 1) {
    const j = randomInt(i + 1)
    ;[chars[i], chars[j]] = [chars[j], chars[i]]
  }
  return chars.join('')
}

function clampLength(length: number): number {
  if (!Number.isFinite(length)) return GOOGLE_DEFAULT_LENGTH
  return Math.min(GOOGLE_MAX_LENGTH, Math.max(GOOGLE_MIN_LENGTH, Math.trunc(length)))
}

export function generatePassword(request: GenerateRequest): string {
  const style: PasswordStyle | undefined = request?.style
  if (style === 'apple') return generateApple()
  if (style === 'google') return generateGoogle(request.length)
  throw new VaultError('INVALID', 'Style de mot de passe inconnu.')
}
