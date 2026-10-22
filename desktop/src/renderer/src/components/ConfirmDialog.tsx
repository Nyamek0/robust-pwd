import { useEffect, useState } from 'react'
import type { EntryMeta } from '@shared/types'
import { Modal } from './Modal'
import { AlertIcon } from './icons'

type Props = {
  entry: EntryMeta | null
  onClose: () => void
  onConfirm: () => Promise<void>
}

export function ConfirmDialog({ entry, onClose, onConfirm }: Props) {
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (entry) setBusy(false)
  }, [entry])

  async function confirm() {
    if (busy) return
    setBusy(true)
    await onConfirm()
    setBusy(false)
  }

  return (
    <Modal open={entry !== null} label="Supprimer une entrée" onClose={onClose}>
      {entry && (
        <>
          <div className="modal-head">
            <div className="modal-head-icon danger">
              <AlertIcon size={20} />
            </div>
            <div>
              <h2>Supprimer « {entry.label} » ?</h2>
              <p>Cette action est définitive. Le mot de passe ne pourra pas être récupéré.</p>
            </div>
          </div>
          <div className="modal-actions">
            <button type="button" className="btn btn-ghost" onClick={onClose}>
              Annuler
            </button>
            <button
              type="button"
              className="btn btn-danger"
              onClick={() => void confirm()}
              disabled={busy}
            >
              {busy ? 'Suppression…' : 'Supprimer'}
            </button>
          </div>
        </>
      )}
    </Modal>
  )
}
