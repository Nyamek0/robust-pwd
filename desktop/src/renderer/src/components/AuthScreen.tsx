import { useEffect, useState, type FormEvent } from 'react'
import { estimateMasterStrength } from '@shared/entropy'
import { Brand } from './Brand'
import { EyeIcon, EyeOffIcon, KeyIcon, LockIcon } from './icons'
import { StrengthMeter } from './StrengthMeter'

type Props = {
  mode: 'setup' | 'locked'
  onSubmit: (master: string) => Promise<string | null>
}

export function AuthScreen({ mode, onSubmit }: Props) {
  const [master, setMaster] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [revealed, setRevealed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const isSetup = mode === 'setup'
  const strength = estimateMasterStrength(master)

  useEffect(() => {
    setError(null)
  }, [mode])

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy) return
    setError(null)

    if (isSetup) {
      if (master.length < 8) {
        setError('Le mot de passe maître doit contenir au moins 8 caractères.')
        return
      }
      if (master !== confirmation) {
        setError('Les deux mots de passe ne correspondent pas.')
        return
      }
    }

    setBusy(true)
    const message = await onSubmit(master)
    setBusy(false)

    if (message) {
      setError(message)
      return
    }
    setMaster('')
    setConfirmation('')
  }

  return (
    <div className="auth">
      <div className="auth-glow" aria-hidden="true" />
      <div className="auth-stack">
        <Brand large />
        <form className="auth-card" onSubmit={handleSubmit}>
          <div className="auth-icon">
            {isSetup ? <KeyIcon size={22} /> : <LockIcon size={22} />}
          </div>
          <h1>{isSetup ? 'Créez votre coffre' : 'Déverrouillez votre coffre'}</h1>
          <p className="auth-sub">
            {isSetup
              ? 'Choisissez un mot de passe maître. Il protège tous vos mots de passe et n’est jamais stocké.'
              : 'Saisissez votre mot de passe maître pour accéder à vos mots de passe.'}
          </p>

          <label className="field">
            <span>Mot de passe maître</span>
            <span className="input-wrap">
              <input
                className="input"
                type={revealed ? 'text' : 'password'}
                value={master}
                onChange={(event) => setMaster(event.target.value)}
                placeholder={isSetup ? '8 caractères minimum' : '••••••••••••'}
                autoFocus
                autoComplete={isSetup ? 'new-password' : 'current-password'}
                spellCheck={false}
                required
              />
              <button
                type="button"
                className="icon-btn reveal-btn"
                onClick={() => setRevealed((value) => !value)}
                aria-label={revealed ? 'Masquer le mot de passe' : 'Afficher le mot de passe'}
                tabIndex={-1}
              >
                {revealed ? <EyeOffIcon size={17} /> : <EyeIcon size={17} />}
              </button>
            </span>
          </label>

          {isSetup && (
            <>
              <StrengthMeter strength={strength} />
              <label className="field">
                <span>Confirmation</span>
                <input
                  className="input"
                  type={revealed ? 'text' : 'password'}
                  value={confirmation}
                  onChange={(event) => setConfirmation(event.target.value)}
                  placeholder="Retapez le mot de passe"
                  autoComplete="new-password"
                  spellCheck={false}
                  required
                />
              </label>
              <p className="auth-warning">
                Ce mot de passe n’est pas récupérable. Si vous l’oubliez, le coffre sera inaccessible.
              </p>
            </>
          )}

          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}

          <button className="btn btn-primary btn-block" type="submit" disabled={busy || !master}>
            {busy ? 'Déchiffrement…' : isSetup ? 'Créer le coffre' : 'Déverrouiller'}
          </button>
        </form>

        <p className="auth-foot">
          <span className="dot" aria-hidden="true" />
          Chiffré localement · AES-256-GCM · PBKDF2 600 000 itérations
        </p>
      </div>
    </div>
  )
}
