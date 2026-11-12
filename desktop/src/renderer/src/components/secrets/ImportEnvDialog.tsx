import { useEffect, useState, type FormEvent } from 'react'
import type { DotenvImportSummary, DotenvPreview } from '@shared/secretsTypes'
import { Modal } from '../Modal'
import { UploadIcon, XIcon } from '../icons'

type Props = {
  open: boolean
  projectId: number
  environment: string
  onClose: () => void
  onPreview: (text: string) => Promise<DotenvPreview | null>
  onImportText: (text: string, overwrite: boolean) => Promise<DotenvImportSummary | string>
  onImportFile: (overwrite: boolean) => Promise<DotenvImportSummary | string>
}

export function ImportEnvDialog({
  open,
  environment,
  onClose,
  onPreview,
  onImportText,
  onImportFile,
}: Props) {
  const [text, setText] = useState('')
  const [overwrite, setOverwrite] = useState(true)
  const [preview, setPreview] = useState<DotenvPreview | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setText('')
    setOverwrite(true)
    setPreview(null)
    setError(null)
    setBusy(false)
  }, [open])

  useEffect(() => {
    if (!open || !text.trim()) {
      setPreview(null)
      return
    }
    let cancelled = false
    const timer = window.setTimeout(async () => {
      const res = await onPreview(text)
      if (!cancelled) setPreview(res)
    }, 150)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [open, text, onPreview])

  async function handleFilePick() {
    if (busy) return
    setError(null)
    setBusy(true)
    const res = await onImportFile(overwrite)
    setBusy(false)
    if (typeof res === 'string') {
      setError(res)
      return
    }
    if (!res.cancelled) {
      onClose()
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy || !text.trim()) return
    setError(null)
    setBusy(true)
    const res = await onImportText(text, overwrite)
    setBusy(false)
    if (typeof res === 'string') {
      setError(res)
      return
    }
    onClose()
  }

  return (
    <Modal open={open} label="Importer un fichier .env" onClose={onClose}>
      <form onSubmit={handleSubmit}>
        <div className="modal-head">
          <div className="modal-head-icon">
            <UploadIcon size={20} />
          </div>
          <div>
            <h2>Importer un .env dans « {environment} »</h2>
            <p>Sélectionnez un fichier .env ou collez directement son contenu ci-dessous.</p>
          </div>
          <button
            type="button"
            className="icon-btn"
            onClick={onClose}
            aria-label="Fermer"
          >
            <XIcon size={18} />
          </button>
        </div>

        <div className="modal-body">
          <div className="import-file-bar">
            <button
              type="button"
              className="btn"
              onClick={() => void handleFilePick()}
              disabled={busy}
            >
              <UploadIcon size={15} /> Choisir un fichier .env…
            </button>
            <label className="check-pill">
              <input
                type="checkbox"
                checked={overwrite}
                onChange={(event) => setOverwrite(event.target.checked)}
              />
              <span>Écraser les clés existantes</span>
            </label>
          </div>

          <label className="field">
            <span>Ou coller le contenu .env</span>
            <textarea
              className="input input-mono textarea"
              rows={6}
              value={text}
              onChange={(event) => setText(event.target.value)}
              placeholder={'PORT=3000\nDATABASE_URL="postgresql://..."'}
              spellCheck={false}
            />
          </label>

          {preview && (
            <div className="dotenv-preview">
              <div className="dotenv-preview-summary">
                <strong>{preview.variables.length}</strong> variable
                {preview.variables.length > 1 ? 's' : ''} détectée
                {preview.variables.length > 1 ? 's' : ''}
                {preview.duplicates.length > 0 && (
                  <span className="preview-warn">
                    · doublons : {preview.duplicates.join(', ')}
                  </span>
                )}
                {preview.invalidLines.length > 0 && (
                  <span className="preview-warn">
                    · lignes ignorées : {preview.invalidLines.join(', ')}
                  </span>
                )}
              </div>
              {preview.variables.length > 0 && (
                <div className="preview-keys">
                  {preview.variables.slice(0, 12).map((item) => (
                    <span key={item.key} className="pill pill-custom">
                      {item.key} ({item.length})
                    </span>
                  ))}
                  {preview.variables.length > 12 && (
                    <span className="pill">+{preview.variables.length - 12}</span>
                  )}
                </div>
              )}
            </div>
          )}

          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
        </div>

        <div className="modal-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Annuler
          </button>
          <button
            type="submit"
            className="btn btn-primary"
            disabled={busy || !text.trim()}
          >
            {busy ? 'Import…' : 'Importer le texte'}
          </button>
        </div>
      </form>
    </Modal>
  )
}

