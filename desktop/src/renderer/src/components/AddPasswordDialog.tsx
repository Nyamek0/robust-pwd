import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { GOOGLE_DEFAULT_LENGTH, GOOGLE_MAX_LENGTH, GOOGLE_MIN_LENGTH } from '@shared/constants'
import { estimateEntropy, estimatePasswordStrength } from '@shared/entropy'
import type { AddEntryInput, EntryMeta, GenerateStyle, PasswordStyle } from '@shared/types'
import { Modal } from './Modal'
import { StrengthMeter } from './StrengthMeter'
import { CopyIcon, EyeIcon, EyeOffIcon, RefreshIcon, XIcon } from './icons'
import { styleName } from '../lib/format'

type Choice = GenerateStyle | 'both'
type Mode = 'generate' | 'manual'

export type SaveResult = { ok: true; entry: EntryMeta } | { ok: false; error: string }

type Props = {
  open: boolean
  onClose: () => void
  onSave: (input: AddEntryInput) => Promise<SaveResult>
  onCopy: (text: string) => void
}

export function AddPasswordDialog({ open, onClose, onSave, onCopy }: Props) {
  const [mode, setMode] = useState<Mode>('generate')
  const [choice, setChoice] = useState<Choice>('apple')
  const [picked, setPicked] = useState<GenerateStyle>('apple')
  const [length, setLength] = useState(GOOGLE_DEFAULT_LENGTH)
  const [apple, setApple] = useState('')
  const [google, setGoogle] = useState('')
  const [applePending, setApplePending] = useState(false)
  const [googlePending, setGooglePending] = useState(false)
  const [manualPassword, setManualPassword] = useState('')
  const [manualRevealed, setManualRevealed] = useState(false)
  const [label, setLabel] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const regenerateApple = useCallback(async () => {
    setApplePending(true)
    const result = await window.robustPwd.generate({ style: 'apple' })
    setApplePending(false)
    if (result.ok) setApple(result.data)
    else setError(result.error)
  }, [])

  const regenerateGoogle = useCallback(async () => {
    setGooglePending(true)
    const result = await window.robustPwd.generate({ style: 'google', length })
    setGooglePending(false)
    if (result.ok) setGoogle(result.data)
    else setError(result.error)
  }, [length])

  useEffect(() => {
    if (!open) return
    setMode('generate')
    setLabel('')
    setError(null)
    setChoice('apple')
    setPicked('apple')
    setLength(GOOGLE_DEFAULT_LENGTH)
    setManualPassword('')
    setManualRevealed(false)
  }, [open])

  useEffect(() => {
    if (!open || mode !== 'generate' || choice === 'google') return
    void regenerateApple()
  }, [open, mode, choice, regenerateApple])

  useEffect(() => {
    if (!open || mode !== 'generate' || choice === 'apple') return
    void regenerateGoogle()
  }, [open, mode, choice, regenerateGoogle])

  function chooseStyle(next: Choice) {
    setChoice(next)
    setError(null)
    if (next === 'apple') setPicked('apple')
    if (next === 'google') setPicked('google')
  }

  function regenerateAll() {
    setError(null)
    if (choice !== 'google') void regenerateApple()
    if (choice !== 'apple') void regenerateGoogle()
  }

  const generatedPassword = picked === 'apple' ? apple : google
  const generatedStrength = generatedPassword
    ? estimateEntropy(generatedPassword, picked)
    : null
  const manualStrength = manualPassword ? estimatePasswordStrength(manualPassword) : null
  const isManual = mode === 'manual'
  const password = isManual ? manualPassword : generatedPassword
  const canSave = isManual
    ? label.trim().length > 0 && manualPassword.length >= 4
    : label.trim().length > 0 && Boolean(generatedPassword)

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy) return

    const clean = label.trim()
    if (!clean) {
      setError('Donnez un mot clé (ex. GitHub, Netflix).')
      return
    }
    if (!password) return

    if (isManual && manualPassword.length < 4) {
      setError('Le mot de passe doit contenir au moins 4 caractères.')
      return
    }

    setBusy(true)
    setError(null)
    const style: PasswordStyle = isManual ? 'custom' : picked
    const result = await onSave({ label: clean, password, style })
    setBusy(false)

    if (!result.ok) {
      setError(result.error)
      return
    }
    onClose()
  }

  function generatedCandidate(style: GenerateStyle) {
    const value = style === 'apple' ? apple : google
    const pending = style === 'apple' ? applePending : googlePending
    const active = picked === style
    const candidateStrength = value ? estimateEntropy(value, style) : null

    return (
      <div key={style} className={`candidate ${active ? 'is-selected' : ''}`}>
        <button
          type="button"
          className="candidate-main"
          onClick={() => setPicked(style)}
          aria-pressed={active}
          disabled={pending || !value}
        >
          <span className="candidate-top">
            <span className={`pill pill-${style}`}>{styleName(style)}</span>
            {candidateStrength && <span className="candidate-bits">{candidateStrength.label}</span>}
          </span>
          <code className={`candidate-code ${pending && !value ? 'is-pending' : ''}`}>
            {value || (pending ? 'Génération…' : '—')}
          </code>
        </button>
        <button
          type="button"
          className="icon-btn"
          onClick={() => value && onCopy(value)}
          disabled={!value}
          aria-label={`Copier le mot de passe ${styleName(style)}`}
          title="Copier"
        >
          <CopyIcon size={17} />
        </button>
      </div>
    )
  }

  return (
    <Modal open={open} label="Ajouter un mot de passe" onClose={onClose}>
      <form onSubmit={submit}>
        <div className="modal-head">
          <div>
            <h2>{isManual ? 'Ajouter un mot de passe existant' : 'Nouveau mot de passe'}</h2>
            <p>
              {isManual
                ? 'Conservez un mot de passe que vous utilisez déjà, chiffré dans votre coffre local.'
                : 'Généré localement et enregistré dans votre coffre chiffré.'}
            </p>
          </div>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Fermer">
            <XIcon size={18} />
          </button>
        </div>

        <div className="modal-body">
          <div className="mode-tabs" role="tablist" aria-label="Mode d’ajout">
            <button
              type="button"
              role="tab"
              aria-selected={!isManual}
              onClick={() => {
                setMode('generate')
                setError(null)
              }}
            >
              Générer
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={isManual}
              onClick={() => {
                setMode('manual')
                setError(null)
              }}
            >
              Saisir
            </button>
          </div>

          {!isManual && (
            <>
              <div className="segmented" role="group" aria-label="Style de mot de passe">
                <button
                  type="button"
                  aria-pressed={choice === 'apple'}
                  onClick={() => chooseStyle('apple')}
                >
                  Apple
                </button>
                <button
                  type="button"
                  aria-pressed={choice === 'google'}
                  onClick={() => chooseStyle('google')}
                >
                  Google
                </button>
                <button
                  type="button"
                  aria-pressed={choice === 'both'}
                  onClick={() => chooseStyle('both')}
                >
                  Les deux
                </button>
              </div>

              {choice !== 'apple' && (
                <label className="range-row">
                  <span>Longueur</span>
                  <input
                    type="range"
                    min={GOOGLE_MIN_LENGTH}
                    max={GOOGLE_MAX_LENGTH}
                    step={1}
                    value={length}
                    onChange={(event) => setLength(Number(event.target.value))}
                    aria-label="Longueur du mot de passe Google"
                  />
                  <output>{length}</output>
                </label>
              )}

              <div className="section-head">
                <span>Propositions</span>
                <button type="button" className="btn btn-ghost btn-sm" onClick={regenerateAll}>
                  <RefreshIcon size={15} /> Régénérer
                </button>
              </div>

              <div className="candidates">
                {choice !== 'google' && generatedCandidate('apple')}
                {choice !== 'apple' && generatedCandidate('google')}
              </div>

              {generatedStrength && generatedPassword && (
                <div className="selected-strength">
                  <StrengthMeter strength={generatedStrength} />
                  <span className="selected-hint">
                    {picked === 'apple'
                      ? 'Prononçable, facile à retaper.'
                      : 'Aléatoire fort, pour les comptes sensibles.'}
                  </span>
                </div>
              )}

              <label className="field">
                <span>Mot clé associé</span>
                <input
                  className="input"
                  value={label}
                  onChange={(event) => setLabel(event.target.value)}
                  placeholder="GitHub, Netflix, banque…"
                  maxLength={80}
                  autoFocus
                  spellCheck={false}
                />
              </label>
            </>
          )}

          {isManual && (
            <>
              <label className="field">
                <span>Mot clé associé</span>
                <input
                  className="input"
                  value={label}
                  onChange={(event) => setLabel(event.target.value)}
                  placeholder="GitHub, Netflix, banque…"
                  maxLength={80}
                  autoFocus
                  spellCheck={false}
                />
              </label>

              <label className="field">
                <span>Mot de passe existant</span>
                <span className="input-wrap">
                  <input
                    className="input input-mono"
                    type={manualRevealed ? 'text' : 'password'}
                    value={manualPassword}
                    onChange={(event) => setManualPassword(event.target.value)}
                    placeholder="Collez le mot de passe à conserver"
                    autoComplete="off"
                    spellCheck={false}
                  />
                  <button
                    type="button"
                    className="icon-btn reveal-btn"
                    onClick={() => setManualRevealed((value) => !value)}
                    aria-label={manualRevealed ? 'Masquer le mot de passe' : 'Afficher le mot de passe'}
                    tabIndex={-1}
                  >
                    {manualRevealed ? <EyeOffIcon size={17} /> : <EyeIcon size={17} />}
                  </button>
                </span>
              </label>

              {manualStrength && <StrengthMeter strength={manualStrength} />}

              {manualStrength && manualStrength.level === 1 && (
                <p className="form-hint warning">
                  Ce mot de passe semble faible. Il sera tout de même enregistré tel quel.
                </p>
              )}

              <p className="form-hint">
                Pour en importer plusieurs d’un coup, utilisez « Importer » (CSV, TSV ou JSON) depuis
                la barre du haut.
              </p>
            </>
          )}

          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
        </div>

        <div className="modal-actions">
          <p className="modal-note">
            {isManual ? 'Enregistré tel quel.' : 'Copié automatiquement après enregistrement.'}
          </p>
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Annuler
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy || !canSave}>
            {busy ? 'Enregistrement…' : 'Enregistrer'}
          </button>
        </div>
      </form>
    </Modal>
  )
}
