import { useState, type FormEvent } from 'react'
import type { GlanceStatus } from '@shared/types'
import { Modal } from './Modal'

type Props = {
  open: boolean
  status: GlanceStatus | null
  onClose: () => void
  onEnroll: (master: string) => Promise<string | null>
  onClear: () => Promise<string | null>
}

export function GlanceSetupDialog({ open, status, onClose, onEnroll, onClear }: Props) {
  const [master, setMaster] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const enrolled = Boolean(status?.enrolled && status?.hasSecret)

  async function handleEnroll(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy || !master) return
    setError(null)
    setBusy(true)
    const message = await onEnroll(master)
    setBusy(false)
    if (message) {
      setError(message)
      return
    }
    setMaster('')
    onClose()
  }

  async function handleClear() {
    if (busy) return
    setError(null)
    setBusy(true)
    const message = await onClear()
    setBusy(false)
    if (message) {
      setError(message)
      return
    }
    onClose()
  }

  return (
    <Modal open={open} label="Déverrouillage facial Glance" onClose={onClose}>
      <div className="dialog">
        <h2>Déverrouillage facial (Glance)</h2>
        {enrolled ? (
          <>
            <p className="dialog-sub">
              La reconnaissance faciale est activée ({status?.model ?? 'arcface'}). Vous pouvez
              désactiver cette option à tout moment pour supprimer les empreintes faciales et le
              mot de passe du trousseau macOS.
            </p>
            {error && (
              <p className="form-error" role="alert">
                {error}
              </p>
            )}
            <div className="dialog-actions">
              <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
                Fermer
              </button>
              <button type="button" className="btn btn-danger" onClick={handleClear} disabled={busy}>
                {busy ? 'Suppression…' : 'Désactiver Glance'}
              </button>
            </div>
          </>
        ) : (
          <form onSubmit={handleEnroll}>
            <p className="dialog-sub">
              Confirmez votre mot de passe maître puis regardez la caméra quelques secondes. Vos
              empreintes faciales (ArcFace) et le mot de passe seront chiffrés localement dans le
              trousseau macOS.
            </p>
            <label className="field">
              <span>Mot de passe maître</span>
              <input
                className="input"
                type="password"
                value={master}
                onChange={(event) => setMaster(event.target.value)}
                placeholder="••••••••••••"
                autoFocus
                required
              />
            </label>
            {error && (
              <p className="form-error" role="alert">
                {error}
              </p>
            )}
            <div className="dialog-actions">
              <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
                Annuler
              </button>
              <button type="submit" className="btn btn-primary" disabled={busy || !master}>
                {busy ? 'Capture en cours…' : 'Enregistrer mon visage'}
              </button>
            </div>
          </form>
        )}
      </div>
    </Modal>
  )
}

