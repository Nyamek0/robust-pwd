import { useEffect, useState, type FormEvent } from 'react'
import type {
  SecretGeneratorSpec,
  UpsertVariableInput,
  VariableMeta,
  VariableType,
} from '@shared/secretsTypes'
import { Modal } from '../Modal'
import { KeyIcon, RefreshIcon, XIcon } from '../icons'

type Props = {
  open: boolean
  projectId: number
  environment: string
  variable?: VariableMeta | null
  initialValue?: string
  onClose: () => void
  onSave: (input: UpsertVariableInput) => Promise<string | null>
  onGenerate: (spec: SecretGeneratorSpec) => Promise<string | null>
}

const GENERATOR_SPECS: Array<{ spec: SecretGeneratorSpec; label: string }> = [
  { spec: 'hex:32', label: 'Hex 256 bits' },
  { spec: 'base64:32', label: 'Base64 URL' },
  { spec: 'uuid', label: 'UUID v4' },
  { spec: 'google:32', label: 'Aléatoire 32c' },
]

export function VariableDialog({
  open,
  projectId,
  environment,
  variable,
  initialValue = '',
  onClose,
  onSave,
  onGenerate,
}: Props) {
  const [key, setKey] = useState('')
  const [value, setValue] = useState('')
  const [masked, setMasked] = useState(false)
  const [isProtected, setIsProtected] = useState(false)
  const [type, setType] = useState<VariableType>('env_var')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const isEdit = Boolean(variable)

  useEffect(() => {
    if (!open) return
    setKey(variable?.key ?? '')
    setValue(initialValue)
    setMasked(variable?.masked ?? false)
    setIsProtected(variable?.protected ?? false)
    setType(variable?.type ?? 'env_var')
    setError(null)
    setBusy(false)
  }, [open, variable, initialValue])

  async function handleGenerate(spec: SecretGeneratorSpec) {
    const generated = await onGenerate(spec)
    if (generated !== null) {
      setValue(generated)
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy) return
    setError(null)
    setBusy(true)

    const err = await onSave({
      projectId,
      environment,
      key: key.trim(),
      value,
      masked,
      protected: isProtected,
      raw: true,
      type,
    })
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
      label={isEdit ? `Modifier ${variable?.key}` : 'Nouvelle variable'}
      onClose={onClose}
    >
      <form onSubmit={handleSubmit}>
        <div className="modal-head">
          <div className="modal-head-icon">
            <KeyIcon size={20} />
          </div>
          <div>
            <h2>{isEdit ? `Modifier ${variable?.key}` : 'Nouvelle variable'}</h2>
            <p>Environnement « {environment} » · stockée chiffrée dans secrets.enc.</p>
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
            <span>Clé</span>
            <input
              className="input input-mono"
              value={key}
              onChange={(event) => setKey(event.target.value)}
              placeholder="ex. DATABASE_URL, STRIPE_SECRET_KEY"
              disabled={isEdit}
              autoFocus={!isEdit}
              spellCheck={false}
              required
            />
          </label>

          <div className="field">
            <div className="section-head">
              <span>Valeur</span>
              <div className="secret-gen-pills">
                {GENERATOR_SPECS.map((item) => (
                  <button
                    key={item.spec}
                    type="button"
                    className="btn btn-sm"
                    onClick={() => void handleGenerate(item.spec)}
                    title={`Générer (${item.spec})`}
                  >
                    <RefreshIcon size={12} /> {item.label}
                  </button>
                ))}
              </div>
            </div>
            <textarea
              className="input input-mono textarea"
              rows={4}
              value={value}
              onChange={(event) => setValue(event.target.value)}
              placeholder="Valeur secrète (multi-ligne autorisé)"
              autoFocus={isEdit}
              spellCheck={false}
            />
          </div>

          <div className="var-flags">
            <label className="check-pill">
              <input
                type="checkbox"
                checked={masked}
                onChange={(event) => setMasked(event.target.checked)}
              />
              <span>Masquée (GitLab CI)</span>
            </label>
            <label className="check-pill">
              <input
                type="checkbox"
                checked={isProtected}
                onChange={(event) => setIsProtected(event.target.checked)}
              />
              <span>Protégée (branches protégées)</span>
            </label>
            <label className="check-pill">
              <input
                type="checkbox"
                checked={type === 'file'}
                onChange={(event) => setType(event.target.checked ? 'file' : 'env_var')}
              />
              <span>Type fichier (GitLab)</span>
            </label>
          </div>

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
            disabled={busy || !key.trim()}
          >
            {busy ? 'Enregistrement…' : 'Enregistrer'}
          </button>
        </div>
      </form>
    </Modal>
  )
}

