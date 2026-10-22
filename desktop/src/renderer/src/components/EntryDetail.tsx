import { useEffect, useState } from 'react'
import { entropyForStyle } from '@shared/entropy'
import type { EntryMeta } from '@shared/types'
import { StrengthMeter } from './StrengthMeter'
import { CopyIcon, EyeIcon, EyeOffIcon, TrashIcon } from './icons'
import { formatDate, maskPassword, styleName } from '../lib/format'

type Props = {
  entry: EntryMeta
  onCopy: (id: number) => void
  onReveal: (id: number) => Promise<string | null>
  onAskDelete: (entry: EntryMeta) => void
}

const HIDE_AFTER_MS = 30_000

export function EntryDetail({ entry, onCopy, onReveal, onAskDelete }: Props) {
  const [secret, setSecret] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const strength = entry.style === 'custom' ? null : entropyForStyle(entry.length, entry.style)

  useEffect(() => {
    setSecret(null)
    setLoading(false)
  }, [entry.id])

  useEffect(() => {
    if (!secret) return
    const timer = setTimeout(() => setSecret(null), HIDE_AFTER_MS)
    return () => clearTimeout(timer)
  }, [secret])

  async function toggle() {
    if (secret) {
      setSecret(null)
      return
    }
    if (loading) return
    setLoading(true)
    const value = await onReveal(entry.id)
    setLoading(false)
    if (value) setSecret(value)
  }

  return (
    <article className="detail-card" key={entry.id}>
      <header className="detail-head">
        <span className={`avatar avatar-lg ${entry.style}`}>{entry.label.charAt(0).toUpperCase()}</span>
        <div className="detail-title">
          <h1>{entry.label}</h1>
          <p className="detail-sub">
            <span className={`pill pill-${entry.style}`}>{styleName(entry.style)}</span>
            <span>créé le {formatDate(entry.createdAt)}</span>
          </p>
        </div>
        <button
          type="button"
          className="icon-btn icon-btn-danger"
          onClick={() => onAskDelete(entry)}
          aria-label={`Supprimer ${entry.label}`}
          title="Supprimer"
        >
          <TrashIcon size={18} />
        </button>
      </header>

      <div className="secret-box">
        <code className={`secret ${secret ? 'is-revealed' : 'is-masked'}`}>
          {secret ?? maskPassword(entry.length)}
        </code>
        <div className="secret-actions">
          <button
            type="button"
            className="icon-btn"
            onClick={() => void toggle()}
            aria-label={secret ? 'Masquer le mot de passe' : 'Afficher le mot de passe'}
            title={secret ? 'Masquer' : 'Afficher'}
            disabled={loading}
          >
            {secret ? <EyeOffIcon size={18} /> : <EyeIcon size={18} />}
          </button>
          <button
            type="button"
            className="icon-btn"
            onClick={() => onCopy(entry.id)}
            aria-label="Copier le mot de passe"
            title="Copier"
          >
            <CopyIcon size={18} />
          </button>
        </div>
      </div>

      <div className="stats">
        <div className="stat">
          <span className="stat-label">Style</span>
          <span className="stat-value">{styleName(entry.style)}</span>
        </div>
        <div className="stat">
          <span className="stat-label">Longueur</span>
          <span className="stat-value">{entry.length} caractères</span>
        </div>
        <div className="stat stat-wide">
          <span className="stat-label">Entropie estimée</span>
          {strength ? (
            <StrengthMeter strength={strength} />
          ) : (
            <span className="stat-muted">Non calculée pour un mot de passe importé.</span>
          )}
        </div>
      </div>

      <div className="detail-actions">
        <button type="button" className="btn btn-primary" onClick={() => onCopy(entry.id)}>
          <CopyIcon size={16} /> Copier le mot de passe
        </button>
        <button type="button" className="btn" onClick={() => void toggle()} disabled={loading}>
          {secret ? <EyeOffIcon size={16} /> : <EyeIcon size={16} />}
          {secret ? 'Masquer' : 'Afficher'}
        </button>
      </div>

      <p className="hint">Le presse-papier est vidé automatiquement 30 secondes après la copie.</p>
    </article>
  )
}
