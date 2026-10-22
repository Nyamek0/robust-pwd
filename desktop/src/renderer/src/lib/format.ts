import type { PasswordStyle } from '@shared/types'

const fullDate = new Intl.DateTimeFormat('fr-FR', {
  day: '2-digit',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
})

const shortDate = new Intl.DateTimeFormat('fr-FR', {
  day: '2-digit',
  month: 'short',
  year: 'numeric',
})

function toDate(iso: string): Date | null {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? null : date
}

export function formatDate(iso: string): string {
  const date = toDate(iso)
  return date ? fullDate.format(date) : iso
}

export function formatShortDate(iso: string): string {
  const date = toDate(iso)
  return date ? shortDate.format(date) : iso
}

export function maskPassword(length: number): string {
  return '•'.repeat(Math.max(8, Math.min(length, 28)))
}

export function styleName(style: PasswordStyle): string {
  if (style === 'apple') return 'Apple'
  if (style === 'google') return 'Google'
  return 'Importé'
}
