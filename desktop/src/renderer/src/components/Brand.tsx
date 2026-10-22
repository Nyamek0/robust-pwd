import { LockIcon } from './icons'

export function Brand({ large = false }: { large?: boolean }) {
  return (
    <div className={`brand ${large ? 'brand-lg' : ''}`}>
      <span className="brand-mark">
        <LockIcon size={large ? 24 : 17} />
      </span>
      <span className="brand-name">
        robust<span className="brand-dot">·</span>pwd
      </span>
    </div>
  )
}
