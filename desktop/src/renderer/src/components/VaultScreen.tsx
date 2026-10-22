import { useMemo, type RefObject } from 'react'
import type { EntryMeta } from '@shared/types'
import { EntryDetail } from './EntryDetail'
import { Brand } from './Brand'
import { CopyIcon, KeyIcon, LockIcon, PlusIcon, SearchIcon, UploadIcon, XIcon } from './icons'
import { formatShortDate, styleName } from '../lib/format'

type Props = {
  entries: EntryMeta[]
  selectedId: number | null
  search: string
  searchRef: RefObject<HTMLInputElement | null>
  autoLockMinutes: number
  importing: boolean
  onSearchChange: (value: string) => void
  onSelect: (id: number) => void
  onCopy: (id: number) => void
  onReveal: (id: number) => Promise<string | null>
  onAskDelete: (entry: EntryMeta) => void
  onNew: () => void
  onImport: () => void
  onLock: () => void
}

export function VaultScreen({
  entries,
  selectedId,
  search,
  searchRef,
  autoLockMinutes,
  importing,
  onSearchChange,
  onSelect,
  onCopy,
  onReveal,
  onAskDelete,
  onNew,
  onImport,
  onLock,
}: Props) {
  const selected = entries.find((entry) => entry.id === selectedId) ?? null

  const visible = useMemo(() => {
    const query = search.trim().toLowerCase()
    if (!query) return entries
    return entries.filter(
      (entry) =>
        entry.label.toLowerCase().includes(query) || styleName(entry.style).toLowerCase() === query,
    )
  }, [entries, search])

  return (
    <div className="app-shell">
      <header className="topbar">
        <Brand />
        <div className="topbar-spacer" />
        <button
          type="button"
          className="btn btn-ghost"
          onClick={onImport}
          disabled={importing}
          title="Importer un fichier CSV, TSV ou JSON"
        >
          <UploadIcon size={16} /> {importing ? 'Import…' : 'Importer'}
        </button>
        <button type="button" className="btn btn-ghost" onClick={onLock} title="Verrouiller (⌘L)">
          <LockIcon size={16} /> Verrouiller
        </button>
        <button type="button" className="btn btn-primary" onClick={onNew} title="Nouveau (⌘N)">
          <PlusIcon size={16} /> Nouveau
        </button>
      </header>

      <div className="workspace">
        <aside className="sidebar">
          <div className="search">
            <SearchIcon size={16} className="search-icon" />
            <input
              ref={searchRef}
              className="search-input"
              value={search}
              onChange={(event) => onSearchChange(event.target.value)}
              placeholder="Rechercher un mot clé…"
              aria-label="Rechercher un mot de passe"
              spellCheck={false}
            />
            {search && (
              <button
                type="button"
                className="icon-btn search-clear"
                onClick={() => onSearchChange('')}
                aria-label="Effacer la recherche"
              >
                <XIcon size={14} />
              </button>
            )}
          </div>

          <div className="entry-list" role="list" aria-label="Entrées du coffre">
            {entries.length === 0 && (
              <div className="list-empty">
                <p>Coffre vide</p>
                <span>Générez un mot de passe ou importez les vôtres.</span>
              </div>
            )}

            {entries.length > 0 && visible.length === 0 && (
              <div className="list-empty">
                <p>Aucun résultat</p>
                <span>Essayez un autre mot clé.</span>
              </div>
            )}

            {visible.map((entry) => {
              const active = entry.id === selectedId
              return (
                <div key={entry.id} role="listitem" className={`entry ${active ? 'is-active' : ''}`}>
                  <button
                    type="button"
                    className="entry-main"
                    onClick={() => onSelect(entry.id)}
                    aria-current={active}
                  >
                    <span className={`avatar ${entry.style}`}>{entry.label.charAt(0).toUpperCase()}</span>
                    <span className="entry-text">
                      <span className="entry-label">{entry.label}</span>
                      <span className="entry-meta">
                        {styleName(entry.style)} · {formatShortDate(entry.createdAt)}
                      </span>
                    </span>
                  </button>
                  <button
                    type="button"
                    className="icon-btn entry-copy"
                    onClick={() => onCopy(entry.id)}
                    aria-label={`Copier le mot de passe de ${entry.label}`}
                    title="Copier"
                  >
                    <CopyIcon size={16} />
                  </button>
                </div>
              )
            })}
          </div>

          <footer className="sidebar-foot">
            <span className="foot-item">
              {entries.length} entrée{entries.length > 1 ? 's' : ''}
            </span>
            <span className="foot-sep" aria-hidden="true" />
            <span className="foot-item">verrouillage auto · {autoLockMinutes} min</span>
          </footer>
        </aside>

        <main className="detail">
          {selected ? (
            <EntryDetail
              entry={selected}
              onCopy={onCopy}
              onReveal={onReveal}
              onAskDelete={onAskDelete}
            />
          ) : (
            <div className="detail-empty">
              <div className="detail-orb">
                <KeyIcon size={26} />
              </div>
              <h2>{entries.length === 0 ? 'Votre coffre est vide' : 'Sélectionnez une entrée'}</h2>
              <p>
                {entries.length === 0
                  ? 'Générez un mot de passe Apple ou Google, ou importez ceux que vous utilisez déjà.'
                  : 'Choisissez un mot de passe dans la liste pour l’afficher ou le copier.'}
              </p>
              {entries.length === 0 && (
                <div className="empty-actions">
                  <button type="button" className="btn btn-primary" onClick={onNew}>
                    <PlusIcon size={16} /> Générer un mot de passe
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost"
                    onClick={onImport}
                    disabled={importing}
                  >
                    <UploadIcon size={16} /> Importer un fichier
                  </button>
                </div>
              )}
            </div>
          )}
        </main>
      </div>
    </div>
  )
}
