import { useEffect, useState } from 'react'
import type { DotenvExportFormat } from '@shared/secretsTypes'
import { Modal } from '../Modal'
import { CopyIcon, DownloadIcon, XIcon } from '../icons'

type Props = {
  open: boolean
  environment: string
  onClose: () => void
  onRenderText: (format: DotenvExportFormat) => Promise<string | null>
  onCopyRendered: (text: string) => void
  onSaveFile: (format: DotenvExportFormat) => Promise<void>
}

export function ExportEnvDialog({
  open,
  environment,
  onClose,
  onRenderText,
  onCopyRendered,
  onSaveFile,
}: Props) {
  const [format, setFormat] = useState<DotenvExportFormat>('dotenv')
  const [rendered, setRendered] = useState('')
  const [revealed, setRevealed] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!open) return
    setFormat('dotenv')
    setRevealed(false)
  }, [open])

  useEffect(() => {
    if (!open) return
    let cancelled = false
    void (async () => {
      const text = await onRenderText(format)
      if (!cancelled && text !== null) {
        setRendered(text)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [open, format, onRenderText])

  async function handleSave() {
    if (busy) return
    setBusy(true)
    await onSaveFile(format)
    setBusy(false)
  }

  return (
    <Modal open={open} label="Exporter les variables" onClose={onClose}>
      <div className="modal-head">
        <div className="modal-head-icon">
          <DownloadIcon size={20} />
        </div>
        <div>
          <h2>Exporter « {environment} »</h2>
          <p>
            Les fichiers enregistrés sont écrits en permissions 600. En développement local,
            préférez « robust-pwd secrets run -- … » pour éviter tout fichier en clair.
          </p>
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
        <div className="segmented" role="group" aria-label="Format d’export">
          <button
            type="button"
            aria-pressed={format === 'dotenv'}
            onClick={() => setFormat('dotenv')}
          >
            .env (dotenv)
          </button>
          <button
            type="button"
            aria-pressed={format === 'shell'}
            onClick={() => setFormat('shell')}
          >
            Shell (export)
          </button>
          <button
            type="button"
            aria-pressed={format === 'json'}
            onClick={() => setFormat('json')}
          >
            JSON
          </button>
        </div>

        <div className="field">
          <div className="section-head">
            <span>Aperçu</span>
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              onClick={() => setRevealed((v) => !v)}
            >
              {revealed ? 'Masquer les valeurs' : 'Afficher les valeurs'}
            </button>
          </div>
          <textarea
            className="input input-mono textarea"
            rows={6}
            readOnly
            value={
              revealed
                ? rendered
                : rendered
                    .split('\n')
                    .filter(Boolean)
                    .map((line) => {
                      const idx = line.indexOf('=')
                      return idx > 0 ? `${line.slice(0, idx + 1)}••••••••` : line
                    })
                    .join('\n')
            }
          />
        </div>
      </div>

      <div className="modal-actions">
        <button type="button" className="btn btn-ghost" onClick={onClose}>
          Fermer
        </button>
        <button
          type="button"
          className="btn"
          onClick={() => onCopyRendered(rendered)}
          disabled={!rendered}
        >
          <CopyIcon size={15} /> Copier
        </button>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => void handleSave()}
          disabled={busy}
        >
          <DownloadIcon size={15} /> {busy ? 'Enregistrement…' : 'Enregistrer sous…'}
        </button>
      </div>
    </Modal>
  )
}

