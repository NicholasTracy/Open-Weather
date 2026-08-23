export type SpcRiskLabel = 'TSTM' | 'MRGL' | 'SLGT' | 'ENH' | 'MDT' | 'HIGH'

export type SpcOutlookFeatureProps = {
  DN?: number
  VALID?: string
  EXPIRE?: string
  LABEL?: string
  LABEL2?: string
  fill?: string
  stroke?: string
}

export type SpcOutlookFeature = {
  type: 'Feature'
  id?: string | number
  properties?: SpcOutlookFeatureProps
  geometry?: {
    type: string
    coordinates: unknown
  } | null
}

export type SpcOutlookCollection = {
  type: 'FeatureCollection'
  features: SpcOutlookFeature[]
}

export const SPC_RISK_ORDER: SpcRiskLabel[] = ['TSTM', 'MRGL', 'SLGT', 'ENH', 'MDT', 'HIGH']

export const SPC_RISK_STYLE: Record<SpcRiskLabel, { fill: string; stroke: string; label: string }> = {
  TSTM: { fill: '#7fc57f', stroke: '#4a9a4a', label: 'Thunderstorms' },
  MRGL: { fill: '#00a000', stroke: '#007000', label: 'Marginal' },
  SLGT: { fill: '#f0c800', stroke: '#c9a000', label: 'Slight' },
  ENH: { fill: '#ff7a18', stroke: '#d45e00', label: 'Enhanced' },
  MDT: { fill: '#e31b1b', stroke: '#b01010', label: 'Moderate' },
  HIGH: { fill: '#e010e0', stroke: '#a000a0', label: 'High' }
}

export function asSpcRiskLabel(value: string | undefined): SpcRiskLabel | null {
  const raw = (value ?? '').trim().toUpperCase()
  if (raw === 'TSTM' || raw === 'MRGL' || raw === 'SLGT' || raw === 'ENH' || raw === 'MDT' || raw === 'HIGH') {
    return raw
  }
  return null
}

export function spcRiskRank(label: SpcRiskLabel | null): number {
  if (!label) return 0
  return SPC_RISK_ORDER.indexOf(label) + 1
}

/** SPC VALID `202608191200` (UTC YYYYMMDDHHMM). */
export function parseSpcValidStamp(raw: string | null | undefined): Date | null {
  if (!raw) return null
  const digits = raw.replace(/\D/g, '')
  if (digits.length < 10) return null
  const year = Number(digits.slice(0, 4))
  const month = Number(digits.slice(4, 6))
  const day = Number(digits.slice(6, 8))
  const hour = Number(digits.slice(8, 10))
  const minute = Number(digits.slice(10, 12) || '0')
  const ms = Date.UTC(year, month - 1, day, hour, minute)
  if (!Number.isFinite(ms)) return null
  return new Date(ms)
}

export function formatSpcValidLabel(raw: string | null | undefined): string {
  const date = parseSpcValidStamp(raw)
  if (!date) return 'SPC Day 1'
  const z = `${String(date.getUTCHours()).padStart(2, '0')}Z`
  const local = date.toLocaleString(undefined, {
    weekday: 'short',
    hour: 'numeric',
    minute: '2-digit'
  })
  return `SPC Day 1 ${z} · ${local}`
}

export function outlookValidFromFeatures(features: SpcOutlookFeature[]): string | null {
  for (const feature of features) {
    const valid = feature.properties?.VALID
    if (valid) return valid
  }
  return null
}
