import type { Strength } from '@shared/entropy'

export function StrengthMeter({
  strength,
  showLabel = true,
}: {
  strength: Strength
  showLabel?: boolean
}) {
  return (
    <div className="strength">
      <div className="meter" data-level={strength.level} aria-hidden="true">
        <span />
        <span />
        <span />
        <span />
      </div>
      {showLabel && (
        <span className="strength-label" data-level={strength.level}>
          {strength.label} · ~{Math.round(strength.bits)} bits
        </span>
      )}
    </div>
  )
}
