import { useCallback, useEffect, useRef, useState } from 'react'
import type { AddEntryInput, EntryMeta, LockReason } from '@shared/types'
import { AuthScreen } from './components/AuthScreen'
import { Brand } from './components/Brand'
import { ConfirmDialog } from './components/ConfirmDialog'
import { AddPasswordDialog, type SaveResult } from './components/AddPasswordDialog'
import { Toasts, type ToastItem, type ToastKind } from './components/Toasts'
import { VaultScreen } from './components/VaultScreen'

const api = window.robustPwd

type Phase = 'loading' | 'setup' | 'locked' | 'unlocked'

function useToasts() {
  const [toasts, setToasts] = useState<ToastItem[]>([])
  const nextId = useRef(0)
  const timers = useRef(new Map<number, number>())

  const dismiss = useCallback((id: number) => {
    const timer = timers.current.get(id)
    if (timer) window.clearTimeout(timer)
    timers.current.delete(id)
    setToasts((current) => current.filter((toast) => toast.id !== id))
  }, [])

  const push = useCallback(
    (kind: ToastKind, message: string) => {
      const id = (nextId.current += 1)
      setToasts((current) => [...current.slice(-2), { id, kind, message }])
      const timer = window.setTimeout(() => dismiss(id), 4200)
      timers.current.set(id, timer)
    },
    [dismiss],
  )

  useEffect(() => {
    const pending = timers.current
    return () => {
      pending.forEach((timer) => window.clearTimeout(timer))
      pending.clear()
    }
  }, [])

  return { toasts, push, dismiss }
}

export default function App() {
  const [phase, setPhase] = useState<Phase>('loading')
  const [entries, setEntries] = useState<EntryMeta[]>([])
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [search, setSearch] = useState('')
  const [autoLockSeconds, setAutoLockSeconds] = useState(300)
  const [addOpen, setAddOpen] = useState(false)
  const [importing, setImporting] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<EntryMeta | null>(null)
  const { toasts, push, dismiss } = useToasts()
  const searchRef = useRef<HTMLInputElement>(null)

  const isMac = api.platform === 'darwin'

  const refresh = useCallback(async (): Promise<EntryMeta[]> => {
    const result = await api.list()
    if (!result.ok) {
      push('error', result.error)
      return []
    }
    setEntries(result.data)
    return result.data
  }, [push])

  useEffect(() => {
    let alive = true

    void (async () => {
      const result = await api.status()
      if (!alive) return
      if (!result.ok) {
        push('error', result.error)
        setPhase('locked')
        return
      }

      setAutoLockSeconds(result.data.autoLockSeconds)
      if (!result.data.exists) {
        setPhase('setup')
        return
      }
      if (!result.data.unlocked) {
        setPhase('locked')
        return
      }
      setPhase('unlocked')
      await refresh()
    })()

    return () => {
      alive = false
    }
  }, [push, refresh])

  useEffect(
    () =>
      api.onLocked((reason: LockReason) => {
        setEntries([])
        setSelectedId(null)
        setSearch('')
        setAddOpen(false)
        setImporting(false)
        setDeleteTarget(null)
        setPhase('locked')
        if (reason === 'idle') {
          push('info', 'Coffre verrouillé automatiquement après inactivité.')
        }
      }),
    [push],
  )

  useEffect(() => {
    if (phase !== 'unlocked') return
    let last = 0
    const onActivity = () => {
      const now = Date.now()
      if (now - last < 15_000) return
      last = now
      void api.touch()
    }
    window.addEventListener('pointerdown', onActivity)
    window.addEventListener('keydown', onActivity)
    window.addEventListener('wheel', onActivity, { passive: true })
    return () => {
      window.removeEventListener('pointerdown', onActivity)
      window.removeEventListener('keydown', onActivity)
      window.removeEventListener('wheel', onActivity)
    }
  }, [phase])

  useEffect(() => {
    if (phase !== 'unlocked') return
    if (entries.length === 0) {
      setSelectedId(null)
      return
    }
    if (selectedId === null || !entries.some((entry) => entry.id === selectedId)) {
      setSelectedId(entries[0].id)
    }
  }, [entries, phase, selectedId])

  const handleSetup = useCallback(
    async (master: string): Promise<string | null> => {
      const result = await api.createVault(master)
      if (!result.ok) return result.error
      setEntries(result.data.entries)
      setAutoLockSeconds(result.data.autoLockSeconds)
      setPhase('unlocked')
      push('success', 'Coffre créé. Bienvenue !')
      return null
    },
    [push],
  )

  const handleUnlock = useCallback(
    async (master: string): Promise<string | null> => {
      const result = await api.unlock(master)
      if (!result.ok) return result.error
      setEntries(result.data.entries)
      setAutoLockSeconds(result.data.autoLockSeconds)
      setPhase('unlocked')
      return null
    },
    [],
  )

  const handleLock = useCallback(async () => {
    const result = await api.lock()
    if (!result.ok) {
      push('error', result.error)
      return
    }
    setEntries([])
    setSelectedId(null)
    setSearch('')
    setPhase('locked')
  }, [push])

  const copyEntry = useCallback(
    async (id: number) => {
      const result = await api.copyEntry(id)
      if (!result.ok) {
        push('error', result.error)
        return
      }
      push('success', `Copié · presse-papier effacé dans ${result.data} s`)
    },
    [push],
  )

  const copyText = useCallback(
    async (text: string) => {
      const result = await api.copyText(text)
      if (!result.ok) {
        push('error', result.error)
        return
      }
      push('success', `Copié · presse-papier effacé dans ${result.data} s`)
    },
    [push],
  )

  const reveal = useCallback(
    async (id: number): Promise<string | null> => {
      const result = await api.reveal(id)
      if (!result.ok) {
        push('error', result.error)
        return null
      }
      return result.data
    },
    [push],
  )

  const saveEntry = useCallback(
    async (input: AddEntryInput): Promise<SaveResult> => {
      const result = await api.add(input)
      if (!result.ok) return { ok: false, error: result.error }

      const entry = result.data
      setEntries((current) =>
        [entry, ...current.filter((candidate) => candidate.id !== entry.id)].sort(
          (a, b) => b.id - a.id,
        ),
      )
      setSelectedId(entry.id)
      setSearch('')

      const copy = await api.copyEntry(entry.id)
      push(
        'success',
        copy.ok
          ? `« ${entry.label} » enregistré · copié dans le presse-papier`
          : `« ${entry.label} » enregistré`,
      )
      return { ok: true, entry }
    },
    [push],
  )

  const handleImport = useCallback(async () => {
    if (importing) return
    setImporting(true)
    const result = await api.importFile()
    setImporting(false)

    if (!result.ok) {
      push('error', result.error)
      return
    }

    const { added, skipped, cancelled } = result.data
    if (cancelled) return

    const next = await refresh()
    if (added === 0) {
      push(
        'info',
        skipped > 0
          ? `Aucun nouveau mot de passe · ${skipped} ignoré${skipped > 1 ? 's' : ''}`
          : 'Aucun mot de passe importé.',
      )
      return
    }

    setSearch('')
    setSelectedId(next[0]?.id ?? null)

    const imported = `${added} mot${added > 1 ? 's' : ''} de passe importé${added > 1 ? 's' : ''}`
    push(
      'success',
      skipped > 0
        ? `${imported} · ${skipped} ignoré${skipped > 1 ? 's' : ''}`
        : imported,
    )
  }, [importing, push, refresh])

  const confirmDelete = useCallback(async () => {
    const target = deleteTarget
    if (!target) return

    const result = await api.remove(target.id)
    if (!result.ok) {
      push('error', result.error)
      setDeleteTarget(null)
      return
    }

    setDeleteTarget(null)
    const next = await refresh()
    setSelectedId((current) => (current === target.id ? (next[0]?.id ?? null) : current))
    push('success', `« ${target.label} » supprimé`)
  }, [deleteTarget, push, refresh])

  useEffect(() => {
    if (phase !== 'unlocked') return
    const onKeyDown = (event: KeyboardEvent) => {
      const mod = event.metaKey || event.ctrlKey
      if (!mod) return
      const key = event.key.toLowerCase()
      if (key === 'n') {
        event.preventDefault()
        setAddOpen(true)
      } else if (key === 'l') {
        event.preventDefault()
        void handleLock()
      } else if (key === 'f') {
        event.preventDefault()
        searchRef.current?.focus()
        searchRef.current?.select()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [phase, handleLock])

  return (
    <div className={`app ${isMac ? 'is-mac' : ''}`}>
      {phase === 'loading' && (
        <div className="boot">
          <Brand large />
          <div className="boot-bar" aria-hidden="true">
            <span />
          </div>
          <p>Ouverture du coffre…</p>
        </div>
      )}

      {(phase === 'setup' || phase === 'locked') && (
        <AuthScreen mode={phase} onSubmit={phase === 'setup' ? handleSetup : handleUnlock} />
      )}

      {phase === 'unlocked' && (
        <VaultScreen
          entries={entries}
          selectedId={selectedId}
          search={search}
          searchRef={searchRef}
          autoLockMinutes={Math.round(autoLockSeconds / 60)}
          importing={importing}
          onSearchChange={setSearch}
          onSelect={setSelectedId}
          onCopy={copyEntry}
          onReveal={reveal}
          onAskDelete={setDeleteTarget}
          onNew={() => setAddOpen(true)}
          onImport={() => void handleImport()}
          onLock={() => void handleLock()}
        />
      )}

      <AddPasswordDialog
        open={phase === 'unlocked' && addOpen}
        onClose={() => setAddOpen(false)}
        onSave={saveEntry}
        onCopy={(text) => void copyText(text)}
      />

      <ConfirmDialog
        entry={phase === 'unlocked' ? deleteTarget : null}
        onClose={() => setDeleteTarget(null)}
        onConfirm={confirmDelete}
      />

      <Toasts toasts={toasts} onDismiss={dismiss} />
    </div>
  )
}
