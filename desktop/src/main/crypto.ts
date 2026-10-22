import { createCipheriv, createDecipheriv, pbkdf2, randomBytes } from 'node:crypto'
import { promisify } from 'node:util'

const pbkdf2Async = promisify(pbkdf2)

export const PBKDF2_ITERATIONS = 600_000
const KEY_LENGTH = 32
const SALT_LENGTH = 16
const NONCE_LENGTH = 12
const TAG_LENGTH = 16

export class VaultError extends Error {
  constructor(
    readonly code:
      | 'NO_VAULT'
      | 'EXISTS'
      | 'BAD_MASTER'
      | 'CORRUPT'
      | 'LOCKED'
      | 'WEAK_MASTER'
      | 'NOT_FOUND'
      | 'INVALID',
    message: string,
  ) {
    super(message)
    this.name = 'VaultError'
  }
}

export function createSalt(): Buffer {
  return randomBytes(SALT_LENGTH)
}

/**
 * Dérivation identique à pwdgen.py : PBKDF2-HMAC-SHA256, 600 000 itérations,
 * 32 octets de clé.
 */
export async function deriveKey(master: string, salt: Buffer): Promise<Buffer> {
  return (await pbkdf2Async(master, salt, PBKDF2_ITERATIONS, KEY_LENGTH, 'sha256')) as Buffer
}

/**
 * Format binaire compatible avec le coffre Python :
 * salt (16) | nonce (12) | ciphertext | tag GCM (16)
 */
export function encryptWithKey(plaintext: Buffer, key: Buffer, salt: Buffer): Buffer {
  const nonce = randomBytes(NONCE_LENGTH)
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
  return Buffer.concat([salt, nonce, ciphertext, cipher.getAuthTag()])
}

export async function decryptWithMaster(
  blob: Buffer,
  master: string,
): Promise<{ plaintext: Buffer; key: Buffer; salt: Buffer }> {
  if (blob.length < SALT_LENGTH + NONCE_LENGTH + TAG_LENGTH) {
    throw new VaultError('CORRUPT', 'Le fichier du coffre est incomplet ou corrompu.')
  }

  const salt = blob.subarray(0, SALT_LENGTH)
  const nonce = blob.subarray(SALT_LENGTH, SALT_LENGTH + NONCE_LENGTH)
  const tag = blob.subarray(blob.length - TAG_LENGTH)
  const ciphertext = blob.subarray(SALT_LENGTH + NONCE_LENGTH, blob.length - TAG_LENGTH)

  const key = await deriveKey(master, salt)

  try {
    const decipher = createDecipheriv('aes-256-gcm', key, nonce)
    decipher.setAuthTag(tag)
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()])
    return { plaintext, key, salt }
  } catch {
    key.fill(0)
    throw new VaultError('BAD_MASTER', 'Mot de passe maître incorrect.')
  }
}
