/**
 * Fournisseur GitHub Actions (secrets de dépôt ou d'environnement, REST API 2022-11-28).
 * Jumeau de `robust_pwd/providers/github.py`.
 *
 * Implémente `crypto_box_seal` (X25519 + Blake2b-24 + XSalsa20-Poly1305) avec `node:crypto`
 * sans aucune dépendance native externe.
 */

import { createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync } from 'node:crypto'
import type { SyncApplySummary, SyncPlanItem } from '../../shared/secretsTypes'
import type { SyncVariableRecord } from '../sync'
import {
  defaultTransport,
  ProviderError,
  requestJson,
  type HttpTransport,
  type RemoteProvider,
} from './base'

const X25519_SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex')
const X25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b656e04220420', 'hex')
const SALSA_SIGMA = [0x61707865, 0x3320646e, 0x79622d32, 0x6b206574]

const BLAKE2B_IV = [
  0x6a09e667f3bcc908n,
  0xbb67ae8584caa73bn,
  0x3c6ef372fe94f82bn,
  0xa54ff53a5f1d36f1n,
  0x510e527fade682d1n,
  0x9b05688c2b3e6c1fn,
  0x1f83d9abfb41bd6bn,
  0x5be0cd19137e2179n,
]

const BLAKE2B_SIGMA = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
  [14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3],
  [11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4],
  [7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8],
  [9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13],
  [2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9],
  [12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11],
  [13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10],
  [6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5],
  [10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0],
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
  [14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3],
]

const MASK64 = 0xffffffffffffffffn

function rotr64(x: bigint, n: number): bigint {
  return ((x >> BigInt(n)) | (x << BigInt(64 - n))) & MASK64
}

/** Blake2b avec digest de 24 octets sur une entrée de 64 octets (`epk || pk`). */
function blake2b24(input64: Buffer): Buffer {
  const h = BLAKE2B_IV.slice()
  h[0] ^= 0x01010018n
  const m = new Array<bigint>(16).fill(0n)
  for (let i = 0; i < 8; i += 1) {
    m[i] = input64.readBigUInt64LE(i * 8)
  }
  const v = [...h, ...BLAKE2B_IV]
  v[12] ^= BigInt(input64.length)
  v[14] ^= MASK64

  const G = (a: number, b: number, c: number, d: number, x: bigint, y: bigint): void => {
    v[a] = (v[a] + v[b] + x) & MASK64
    v[d] = rotr64(v[d] ^ v[a], 32)
    v[c] = (v[c] + v[d]) & MASK64
    v[b] = rotr64(v[b] ^ v[c], 24)
    v[a] = (v[a] + v[b] + y) & MASK64
    v[d] = rotr64(v[d] ^ v[a], 16)
    v[c] = (v[c] + v[d]) & MASK64
    v[b] = rotr64(v[b] ^ v[c], 63)
  }

  for (let r = 0; r < 12; r += 1) {
    const s = BLAKE2B_SIGMA[r]
    G(0, 4, 8, 12, m[s[0]], m[s[1]])
    G(1, 5, 9, 13, m[s[2]], m[s[3]])
    G(2, 6, 10, 14, m[s[4]], m[s[5]])
    G(3, 7, 11, 15, m[s[6]], m[s[7]])
    G(0, 5, 10, 15, m[s[8]], m[s[9]])
    G(1, 6, 11, 12, m[s[10]], m[s[11]])
    G(2, 7, 8, 13, m[s[12]], m[s[13]])
    G(3, 4, 9, 14, m[s[14]], m[s[15]])
  }

  const out = Buffer.alloc(24)
  for (let i = 0; i < 3; i += 1) {
    out.writeBigUInt64LE((h[i] ^ v[i] ^ v[i + 8]) & MASK64, i * 8)
  }
  return out
}

function rotl32(x: number, n: number): number {
  return ((x << n) | (x >>> (32 - n))) >>> 0
}

function quarter(s: number[], a: number, b: number, c: number, d: number): void {
  s[b] = (s[b] ^ rotl32((s[a] + s[d]) >>> 0, 7)) >>> 0
  s[c] = (s[c] ^ rotl32((s[b] + s[a]) >>> 0, 9)) >>> 0
  s[d] = (s[d] ^ rotl32((s[c] + s[b]) >>> 0, 13)) >>> 0
  s[a] = (s[a] ^ rotl32((s[d] + s[c]) >>> 0, 18)) >>> 0
}

function salsa20Core(state: number[]): number[] {
  const s = state.slice()
  for (let i = 0; i < 10; i += 1) {
    quarter(s, 0, 4, 8, 12)
    quarter(s, 5, 9, 13, 1)
    quarter(s, 10, 14, 2, 6)
    quarter(s, 15, 3, 7, 11)
    quarter(s, 0, 1, 2, 3)
    quarter(s, 5, 6, 7, 4)
    quarter(s, 10, 11, 8, 9)
    quarter(s, 15, 12, 13, 14)
  }
  return s
}

function hsalsa20(key32: Buffer, nonce16: Buffer): Buffer {
  const k = new Array<number>(8)
  for (let i = 0; i < 8; i += 1) k[i] = key32.readUInt32LE(i * 4)
  const n = new Array<number>(4)
  for (let i = 0; i < 4; i += 1) n[i] = nonce16.readUInt32LE(i * 4)

  const state = [
    SALSA_SIGMA[0], k[0], k[1], k[2],
    k[3], SALSA_SIGMA[1], n[0], n[1],
    n[2], n[3], SALSA_SIGMA[2], k[4],
    k[5], k[6], k[7], SALSA_SIGMA[3],
  ]
  const y = salsa20Core(state)
  const out = Buffer.alloc(32)
  const indices = [0, 5, 10, 15, 6, 7, 8, 9]
  for (let i = 0; i < 8; i += 1) {
    out.writeUInt32LE(y[indices[i]] >>> 0, i * 4)
  }
  return out
}

function salsa20Stream(key32: Buffer, nonce8: Buffer, length: number): Buffer {
  const k = new Array<number>(8)
  for (let i = 0; i < 8; i += 1) k[i] = key32.readUInt32LE(i * 4)
  const n0 = nonce8.readUInt32LE(0)
  const n1 = nonce8.readUInt32LE(4)

  const out = Buffer.alloc(Math.ceil(length / 64) * 64)
  let counter = 0
  let offset = 0
  while (offset < length) {
    const state = [
      SALSA_SIGMA[0], k[0], k[1], k[2],
      k[3], SALSA_SIGMA[1], n0, n1,
      counter >>> 0, 0, SALSA_SIGMA[2], k[4],
      k[5], k[6], k[7], SALSA_SIGMA[3],
    ]
    const y = salsa20Core(state)
    for (let i = 0; i < 16; i += 1) {
      out.writeUInt32LE(((y[i] + state[i]) >>> 0), offset + i * 4)
    }
    offset += 64
    counter += 1
  }
  return out.subarray(0, length)
}

function readLEBigInt(buf: Buffer): bigint {
  let result = 0n
  for (let i = buf.length - 1; i >= 0; i -= 1) {
    result = (result << 8n) | BigInt(buf[i])
  }
  return result
}

function writeLE16(value: bigint): Buffer {
  const out = Buffer.alloc(16)
  let v = value
  for (let i = 0; i < 16; i += 1) {
    out[i] = Number(v & 0xffn)
    v >>= 8n
  }
  return out
}

function poly1305Mac(msg: Buffer, key32: Buffer): Buffer {
  const r = readLEBigInt(key32.subarray(0, 16)) & 0x0ffffffc0ffffffc0ffffffc0fffffffn
  const s = readLEBigInt(key32.subarray(16, 32))
  const p = (1n << 130n) - 5n
  let acc = 0n
  for (let i = 0; i < msg.length; i += 16) {
    const slice = msg.subarray(i, Math.min(i + 16, msg.length))
    const block = Buffer.concat([slice, Buffer.from([1])])
    acc = ((acc + readLEBigInt(block)) * r) % p
  }
  return writeLE16((acc + s) & ((1n << 128n) - 1n))
}

function x25519Shared(privateKeyRaw32: Buffer, publicKeyRaw32: Buffer): Buffer {
  const priv = createPrivateKey({
    key: Buffer.concat([X25519_PKCS8_PREFIX, privateKeyRaw32]),
    format: 'der',
    type: 'pkcs8',
  })
  const pub = createPublicKey({
    key: Buffer.concat([X25519_SPKI_PREFIX, publicKeyRaw32]),
    format: 'der',
    type: 'spki',
  })
  return diffieHellman({ privateKey: priv, publicKey: pub })
}

/**
 * Chiffre `plaintext` au format libsodium `crypto_box_seal` attendu par GitHub Actions.
 */
export function sealBox(plaintext: Buffer, recipientPublicKeyB64: string): string {
  let recipientBytes: Buffer
  try {
    recipientBytes = Buffer.from(recipientPublicKeyB64, 'base64')
  } catch {
    throw new ProviderError('INVALID_KEY', 'Clé publique GitHub invalide.')
  }
  if (recipientBytes.length !== 32) {
    throw new ProviderError('INVALID_KEY', 'Clé publique GitHub de longueur invalide.')
  }

  const kp = generateKeyPairSync('x25519')
  const ephPubDer = kp.publicKey.export({ type: 'spki', format: 'der' }) as Buffer
  const ephPrivDer = kp.privateKey.export({ type: 'pkcs8', format: 'der' }) as Buffer
  const ephPk = ephPubDer.subarray(ephPubDer.length - 32)
  const ephSk = ephPrivDer.subarray(ephPrivDer.length - 32)

  const shared = x25519Shared(ephSk, recipientBytes)
  const firstKey = hsalsa20(shared, Buffer.alloc(16))
  const nonce = blake2b24(Buffer.concat([ephPk, recipientBytes]))
  const subkey = hsalsa20(firstKey, nonce.subarray(0, 16))
  const stream = salsa20Stream(subkey, nonce.subarray(16, 24), 32 + plaintext.length)
  const polyKey = stream.subarray(0, 32)
  const cipher = Buffer.alloc(plaintext.length)
  for (let i = 0; i < plaintext.length; i += 1) {
    cipher[i] = plaintext[i] ^ stream[32 + i]
  }
  const tag = poly1305Mac(cipher, polyKey)
  return Buffer.concat([ephPk, tag, cipher]).toString('base64')
}

/**
 * Déchiffre une boîte scellée (utilisé par les tests unitaires et de compatibilité).
 */
export function openSealedBox(sealedB64: string, recipientPrivateKeyRaw32: Buffer): Buffer {
  const raw = Buffer.from(sealedB64, 'base64')
  if (raw.length < 48) {
    throw new Error('Boîte scellée trop courte.')
  }
  const ephPk = raw.subarray(0, 32)
  const tag = raw.subarray(32, 48)
  const cipher = raw.subarray(48)

  const privObj = createPrivateKey({
    key: Buffer.concat([X25519_PKCS8_PREFIX, recipientPrivateKeyRaw32]),
    format: 'der',
    type: 'pkcs8',
  })
  const pubDer = createPublicKey(privObj).export({ type: 'spki', format: 'der' }) as Buffer
  const pkBytes = pubDer.subarray(pubDer.length - 32)

  const shared = x25519Shared(recipientPrivateKeyRaw32, ephPk)
  const firstKey = hsalsa20(shared, Buffer.alloc(16))
  const nonce = blake2b24(Buffer.concat([ephPk, pkBytes]))
  const subkey = hsalsa20(firstKey, nonce.subarray(0, 16))
  const stream = salsa20Stream(subkey, nonce.subarray(16, 24), 32 + cipher.length)
  const expectedTag = poly1305Mac(cipher, stream.subarray(0, 32))
  if (!expectedTag.equals(tag)) {
    throw new Error('Authentification Poly1305 échouée.')
  }
  const plain = Buffer.alloc(cipher.length)
  for (let i = 0; i < cipher.length; i += 1) {
    plain[i] = cipher[i] ^ stream[32 + i]
  }
  return plain
}

export class GitHubProvider implements RemoteProvider {
  readonly name = 'github' as const
  readonly canReadValues = false
  private readonly host: string

  constructor(
    host: string,
    private readonly token: string,
    private readonly transport: HttpTransport = defaultTransport,
  ) {
    this.host = host.replace(/\/+$/, '')
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'robust-pwd/1.1',
    }
  }

  private secretsBase(target: string, scope: string): string {
    const parts = target.replace(/^\/+|\/+$/g, '').split('/')
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      throw new ProviderError('INVALID_TARGET', 'Un dépôt GitHub s’écrit « propriétaire/dépôt ».')
    }
    const base = `${this.host}/repos/${encodeURIComponent(parts[0])}/${encodeURIComponent(parts[1])}`
    if (scope === '*') return `${base}/actions/secrets`
    return `${base}/environments/${encodeURIComponent(scope)}/actions/secrets`
  }

  async verifyToken(): Promise<string> {
    const { data } = await requestJson<{ login?: unknown }>(
      this.transport,
      'GET',
      `${this.host}/user`,
      this.headers(),
    )
    if (!data || typeof data.login !== 'string' || !data.login) {
      throw new ProviderError('INVALID_RESPONSE', 'Réponse utilisateur GitHub invalide.')
    }
    return data.login
  }

  private async fetchPublicKey(target: string, scope: string): Promise<{ keyId: string; key: string }> {
    const base = this.secretsBase(target, scope)
    const { data } = await requestJson<{ key_id?: unknown; key?: unknown }>(
      this.transport,
      'GET',
      `${base}/public-key`,
      this.headers(),
    )
    if (!data || typeof data.key_id !== 'string' || typeof data.key !== 'string') {
      throw new ProviderError('INVALID_RESPONSE', 'Clé publique GitHub invalide.')
    }
    return { keyId: data.key_id, key: data.key }
  }

  async listRemote(target: string, scope: string): Promise<SyncVariableRecord[]> {
    const base = this.secretsBase(target, scope)
    let page = 1
    const collected: SyncVariableRecord[] = []

    for (;;) {
      const url = `${base}?per_page=100&page=${page}`
      const { data } = await requestJson<{ secrets?: unknown[] }>(
        this.transport,
        'GET',
        url,
        this.headers(),
      )
      if (!data || !Array.isArray(data.secrets)) {
        throw new ProviderError('INVALID_RESPONSE', 'Liste de secrets GitHub invalide.')
      }
      for (const raw of data.secrets) {
        if (!raw || typeof raw !== 'object') continue
        const name = (raw as { name?: unknown }).name
        if (typeof name !== 'string' || !name) continue
        collected.push({
          key: name,
          value: null,
          masked: true,
          protected: false,
          raw: true,
          type: 'env_var',
        })
      }
      if (data.secrets.length < 100) break
      page += 1
    }
    return collected
  }

  async applyPlan(
    target: string,
    scope: string,
    localVars: SyncVariableRecord[],
    planItems: SyncPlanItem[],
  ): Promise<SyncApplySummary> {
    const base = this.secretsBase(target, scope)
    const byUpper = new Map<string, SyncVariableRecord>()
    for (const v of localVars) byUpper.set(v.key.toUpperCase(), v)

    const needsKey = planItems.some(
      (item) =>
        item.action === 'create' || item.action === 'update' || item.action === 'overwrite',
    )
    let keyId = ''
    let pubKey = ''
    if (needsKey) {
      const fetched = await this.fetchPublicKey(target, scope)
      keyId = fetched.keyId
      pubKey = fetched.key
    }

    const summary: SyncApplySummary = { created: 0, updated: 0, deleted: 0 }
    for (const item of planItems) {
      const name = item.key.toUpperCase()
      const encodedName = encodeURIComponent(name)
      if (item.action === 'create' || item.action === 'update' || item.action === 'overwrite') {
        const variable = byUpper.get(name)
        if (!variable) continue
        const encrypted = sealBox(Buffer.from(variable.value ?? '', 'utf8'), pubKey)
        await requestJson(this.transport, 'PUT', `${base}/${encodedName}`, this.headers(), {
          encrypted_value: encrypted,
          key_id: keyId,
        })
        if (item.action === 'create') summary.created += 1
        else summary.updated += 1
      } else if (item.action === 'delete') {
        await requestJson(this.transport, 'DELETE', `${base}/${encodedName}`, this.headers())
        summary.deleted += 1
      }
    }
    return summary
  }
}

