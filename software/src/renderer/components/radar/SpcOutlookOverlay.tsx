import { useMemo, type ReactElement } from 'react'
import L from 'leaflet'
import { GeoJSON } from 'react-leaflet'
import {
  asSpcRiskLabel,
  formatSpcValidLabel,
  outlookValidFromFeatures,
  SPC_RISK_ORDER,
  SPC_RISK_STYLE,
  spcRiskRank,
  type SpcOutlookCollection,
  type SpcOutlookFeature
} from '@shared/spcOutlook'

const PANE = 'owOutlook'

function styleFor(feature: SpcOutlookFeature): L.PathOptions {
  const risk = asSpcRiskLabel(feature.properties?.LABEL)
  const colors = risk ? SPC_RISK_STYLE[risk] : { fill: '#888', stroke: '#666' }
  return {
    pane: PANE,
    color: colors.stroke,
    weight: risk === 'TSTM' ? 1.1 : 1.6,
    opacity: 0.95,
    fillColor: colors.fill,
    fillOpacity: risk === 'TSTM' ? 0.14 : 0.22,
    interactive: false
  }
}

export function SpcOutlookLegend({
  collection,
  compact
}: {
  collection: SpcOutlookCollection
  compact: boolean
}): ReactElement | null {
  const features = collection.features
  if (features.length === 0) return null
  const valid = formatSpcValidLabel(outlookValidFromFeatures(features))
  const present = new Set(
    features
      .map((feature) => asSpcRiskLabel(feature.properties?.LABEL))
      .filter((label): label is NonNullable<typeof label> => Boolean(label))
  )
  return (
    <div className={`spc-legend${compact ? ' spc-legend--compact' : ''}`}>
      <strong>{valid}</strong>
      <ul>
        {SPC_RISK_ORDER.filter((label) => present.has(label)).map((label) => (
          <li key={label}>
            <span style={{ background: SPC_RISK_STYLE[label].fill }} />
            {SPC_RISK_STYLE[label].label}
          </li>
        ))}
      </ul>
    </div>
  )
}

export function SpcOutlookOverlay({
  collection
}: {
  collection: SpcOutlookCollection
}): ReactElement | null {
  const features = useMemo(() => {
    const list = collection.features.filter((feature) => feature.geometry)
    return [...list].sort(
      (a, b) =>
        spcRiskRank(asSpcRiskLabel(a.properties?.LABEL)) -
        spcRiskRank(asSpcRiskLabel(b.properties?.LABEL))
    )
  }, [collection.features])
  const data = useMemo(
    () => ({ type: 'FeatureCollection' as const, features }),
    [features]
  )
  const valid = outlookValidFromFeatures(features)

  if (features.length === 0) return null

  return (
    <GeoJSON
      key={`spc-${features.length}-${valid ?? 'na'}`}
      data={data as GeoJSON.GeoJsonObject}
      pane={PANE}
      interactive={false}
      style={(feature) => styleFor((feature ?? {}) as SpcOutlookFeature)}
    />
  )
}
