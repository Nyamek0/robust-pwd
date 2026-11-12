import { useEffect, useState, type FormEvent } from 'react'
import type { CreateProjectInput, ProjectMeta } from '@shared/secretsTypes'
import { Modal } from '../Modal'
import { CodeIcon, XIcon } from '../icons'

type Props = {
  open: boolean
  project?: ProjectMeta | null
  onClose: () => void
  onCreate: (input: CreateProjectInput) => Promise<string | null>
  onRename: (projectId: number, name: string, description: string) => Promise<string | null>
}

export function ProjectDialog({ open, project, onClose, onCreate, onRename }: Props) {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [envsText, setEnvsText] = useState('local, staging, production')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const isEdit = Boolean(project)

  useEffect(() => {
    if (!open) return
    setName(project?.name ?? '')
    setDescription(project?.description ?? '')
    setEnvsText('local, staging, production')
    setError(null)
    setBusy(false)
  }, [open, project])

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy) return
    setError(null)
    setBusy(true)

    let err: string | null = null
    if (project) {
      err = await onRename(project.id, name, description)
    } else {
      const environments = envsText
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean)
      err = await onCreate({ name, description, environments })
    }
    setBusy(false)
    if (err) {
      setError(err)
      return
    }
    onClose()
  }

  return (
    <Modal
      open={open}
      label={isEdit ? 'Modifier le projet' : 'Nouveau projet'}
      onClose={onClose}
    >
      <form onSubmit={handleSubmit}>
        <div className="modal-head">
          <div className="modal-head-icon">
            <CodeIcon size={20} />
          </div>
          <div>
            <h2>{isEdit ? 'Modifier le projet' : 'Nouveau projet'}</h2>
            <p>
              {isEdit
                ? 'Renommez votre projet ou mettez à jour sa description.'
                : 'Regroupez les variables .env et secrets CI/CD d’une application par environnement.'}
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
          <label className="field">
            <span>Nom du projet</span>
            <input
              className="input"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="ex. mon-api-backend"
              autoFocus
              spellCheck={false}
              required
            />
          </label>

          <label className="field">
            <span>Description (optionnel)</span>
            <input
              className="input"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="ex. API REST principale"
            />
          </label>

          {!isEdit && (
            <label className="field">
              <span>Environnements initiaux</span>
              <input
                className="input input-mono"
                value={envsText}
                onChange={(event) => setEnvsText(event.target.value)}
                placeholder="local, staging, production"
                spellCheck={false}
              />
              <p className="form-hint">
                Séparés par des virgules (lettres minuscules, chiffres, ., _, -).
              </p>
            </label>
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
            disabled={busy || !name.trim()}
          >
            {busy ? 'Enregistrement…' : isEdit ? 'Enregistrer' : 'Créer le projet'}
          </button>
        </div>
      </form>
    </Modal>
  )
}

