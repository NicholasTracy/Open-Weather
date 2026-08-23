import { fetchHttpsJson } from './httpsJson'
import type { SpcOutlookCollection, SpcOutlookFeature } from '../shared/spcOutlook'

const SPC_DAY1_CAT =
  'https://www.spc.noaa.gov/products/outlook/day1otlk_cat.nolyr.geojson'

export async function fetchSpcDay1Outlook(): Promise<SpcOutlookCollection> {
  const raw = await fetchHttpsJson(SPC_DAY1_CAT, {
    timeoutMs: 16_000,
    headers: { Accept: 'application/geo+json, application/json' }
  })
  if (!raw || typeof raw !== 'object') {
    throw new Error('SPC outlook was empty')
  }
  const collection = raw as SpcOutlookCollection
  const features = Array.isArray(collection.features)
    ? collection.features.filter((feature): feature is SpcOutlookFeature => feature?.type === 'Feature')
    : []
  if (features.length === 0) {
    throw new Error('SPC Day-1 outlook has no areas')
  }
  return { type: 'FeatureCollection', features }
}
