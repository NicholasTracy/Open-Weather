export type GeocodeKind =
  | 'postcode'
  | 'house'
  | 'street'
  | 'city'
  | 'district'
  | 'county'
  | 'state'
  | 'country'
  | 'locality'
  | 'other'

export type GeocodeResult = {
  id: string
  lat: number
  lon: number
  label: string
  detail: string
  kind: GeocodeKind
  zoom: number
}

export type GeocodeBias = {
  lat: number
  lon: number
}

type SearchOptions = {
  limit?: number
  bias?: GeocodeBias
  signal?: AbortSignal
  /** Extra sources for Enter / Find. Autocomplete stays Photon-first. */
  commit?: boolean
}

type PhotonFeature = {
  geometry?: { coordinates?: [number, number] }
  properties?: {
    osm_type?: string
    osm_id?: number
    osm_key?: string
    osm_value?: string
    type?: string
    name?: string
    housenumber?: string
    street?: string
    district?: string
    city?: string
    county?: string
    state?: string
    country?: string
    countrycode?: string
    postcode?: string
  }
}

type NominatimHit = {
  place_id?: number
  lat?: string
  lon?: string
  addresstype?: string
  type?: string
  name?: string
  display_name?: string
  address?: {
    house_number?: string
    road?: string
    postcode?: string
    city?: string
    town?: string
    village?: string
    municipality?: string
    suburb?: string
    county?: string
    state?: string
    country?: string
    country_code?: string
  }
}

type OpenMeteoResponse = {
  results?: Array<{
    name: string
    latitude: number
    longitude: number
    admin1?: string
    country?: string
  }>
}

type NominatimReverseResponse = {
  display_name?: string
  address?: {
    city?: string
    town?: string
    village?: string
    municipality?: string
    hamlet?: string
    suburb?: string
    county?: string
    state?: string
    region?: string
    country?: string
  }
}

const USER_AGENT = 'OpenWeatherCommandCenter/0.1 (desktop weather station client)'
const US_ZIP = /^\d{5}(?:-\d{4})?$/
const COORD_PAIR = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/
const HOUSE_ADDRESS = /^\d+\s+\S+/
const ADMIN_AREA = /\b(county|parish|borough|township|municipality)\b/i

const US_STATE_ABBR: Record<string, string> = {
  Alabama: 'AL',
  Alaska: 'AK',
  Arizona: 'AZ',
  Arkansas: 'AR',
  California: 'CA',
  Colorado: 'CO',
  Connecticut: 'CT',
  Delaware: 'DE',
  'District of Columbia': 'DC',
  Florida: 'FL',
  Georgia: 'GA',
  Hawaii: 'HI',
  Idaho: 'ID',
  Illinois: 'IL',
  Indiana: 'IN',
  Iowa: 'IA',
  Kansas: 'KS',
  Kentucky: 'KY',
  Louisiana: 'LA',
  Maine: 'ME',
  Maryland: 'MD',
  Massachusetts: 'MA',
  Michigan: 'MI',
  Minnesota: 'MN',
  Mississippi: 'MS',
  Missouri: 'MO',
  Montana: 'MT',
  Nebraska: 'NE',
  Nevada: 'NV',
  'New Hampshire': 'NH',
  'New Jersey': 'NJ',
  'New Mexico': 'NM',
  'New York': 'NY',
  'North Carolina': 'NC',
  'North Dakota': 'ND',
  Ohio: 'OH',
  Oklahoma: 'OK',
  Oregon: 'OR',
  Pennsylvania: 'PA',
  'Rhode Island': 'RI',
  'South Carolina': 'SC',
  'South Dakota': 'SD',
  Tennessee: 'TN',
  Texas: 'TX',
  Utah: 'UT',
  Vermont: 'VT',
  Virginia: 'VA',
  Washington: 'WA',
  'West Virginia': 'WV',
  Wisconsin: 'WI',
  Wyoming: 'WY'
}

export function looksLikeCoordinateLabel(label: string): boolean {
  return COORD_PAIR.test(label.trim())
}

export function kindLabel(kind: GeocodeKind): string {
  if (kind === 'postcode') return 'ZIP'
  if (kind === 'house') return 'Address'
  if (kind === 'street') return 'Street'
  if (kind === 'city') return 'City'
  if (kind === 'district') return 'Area'
  if (kind === 'county') return 'County'
  if (kind === 'state') return 'State'
  if (kind === 'country') return 'Country'
  if (kind === 'locality') return 'Place'
  return 'Place'
}

export function zoomForKind(kind: GeocodeKind): number {
  if (kind === 'house' || kind === 'street') return 12
  if (kind === 'postcode') return 11
  if (kind === 'district' || kind === 'locality') return 10
  if (kind === 'city') return 9
  if (kind === 'county') return 8
  if (kind === 'state') return 6
  if (kind === 'country') return 4
  return 9
}

export async function suggestLocations(
  query: string,
  options?: Omit<SearchOptions, 'commit'>
): Promise<GeocodeResult[]> {
  return searchLocations(query, { ...options, commit: false })
}

export async function geocodePlace(
  query: string,
  options?: Omit<SearchOptions, 'commit'>
): Promise<GeocodeResult | null> {
  const results = await searchLocations(query, { ...options, commit: true, limit: 8 })
  return results[0] ?? null
}

export async function searchLocations(
  query: string,
  options: SearchOptions = {}
): Promise<GeocodeResult[]> {
  const trimmed = query.trim()
  if (trimmed.length < 2) return []

  const coords = parseCoordinates(trimmed)
  if (coords) return [coords]

  const limit = Math.min(8, Math.max(1, options.limit ?? 6))
  const intent = classifyQuery(trimmed)
  const useNominatim = options.commit || intent === 'postcode' || intent === 'county' || intent === 'house'

  const [photon, nominatim, openMeteo] = await Promise.all([
    searchPhoton(trimmed, options.bias, limit, options.signal),
    useNominatim ? searchNominatim(trimmed, limit, options.signal) : Promise.resolve([]),
    options.commit && intent === 'place'
      ? searchOpenMeteo(trimmed, options.signal)
      : Promise.resolve([])
  ])

  return rankResults([...photon, ...nominatim, ...openMeteo], trimmed, intent, options.bias).slice(
    0,
    limit
  )
}

/**
 * Resolve a human-readable place name for a map pin (OSM Nominatim).
 * Policy: max 1 req/sec in production use; we only hit on pin/coord changes.
 */
export async function reverseGeocode(lat: number, lon: number): Promise<string | null> {
  const url = new URL('https://nominatim.openstreetmap.org/reverse')
  url.searchParams.set('lat', lat.toFixed(5))
  url.searchParams.set('lon', lon.toFixed(5))
  url.searchParams.set('format', 'jsonv2')
  url.searchParams.set('addressdetails', '1')
  url.searchParams.set('zoom', '10')

  const response = await fetch(url.toString(), {
    headers: {
      Accept: 'application/json',
      'User-Agent': USER_AGENT
    }
  })
  if (!response.ok) return null

  const data = (await response.json()) as NominatimReverseResponse
  const address = data.address
  if (address) {
    const locality =
      address.city ||
      address.town ||
      address.village ||
      address.municipality ||
      address.hamlet ||
      address.suburb ||
      address.county
    const region = address.state || address.region
    const parts = [locality, region].filter(Boolean)
    if (parts.length > 0) return parts.join(', ')
  }

  if (data.display_name) {
    const chunks = data.display_name.split(',').map((part) => part.trim())
    if (chunks.length >= 2) return `${chunks[0]}, ${chunks[1]}`
    return chunks[0] ?? null
  }

  return null
}

function classifyQuery(query: string): GeocodeKind | 'place' {
  if (US_ZIP.test(query) || looksLikePostalCode(query)) return 'postcode'
  if (HOUSE_ADDRESS.test(query)) return 'house'
  if (ADMIN_AREA.test(query)) return 'county'
  return 'place'
}

function looksLikePostalCode(query: string): boolean {
  if (/^\d{4,6}$/.test(query)) return true
  return /^[A-Z]\d[A-Z]\s?\d[A-Z]\d$/i.test(query)
}

function parseCoordinates(query: string): GeocodeResult | null {
  const match = COORD_PAIR.exec(query)
  if (!match) return null
  const lat = Number(match[1])
  const lon = Number(match[2])
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    return null
  }
  const label = `${lat.toFixed(5)}, ${lon.toFixed(5)}`
  return {
    id: `coord:${label}`,
    lat,
    lon,
    label,
    detail: 'Coordinates',
    kind: 'other',
    zoom: 10
  }
}

async function searchPhoton(
  query: string,
  bias: GeocodeBias | undefined,
  limit: number,
  signal?: AbortSignal
): Promise<GeocodeResult[]> {
  const url = new URL('https://photon.komoot.io/api/')
  url.searchParams.set('q', query)
  url.searchParams.set('limit', String(Math.max(limit, 6)))
  url.searchParams.set('lang', 'en')
  if (bias) {
    url.searchParams.set('lat', bias.lat.toFixed(4))
    url.searchParams.set('lon', bias.lon.toFixed(4))
  }

  const response = await fetch(url.toString(), {
    signal,
    headers: { Accept: 'application/json', 'User-Agent': USER_AGENT }
  })
  if (!response.ok) throw new Error(`Geocoder HTTP ${response.status}`)

  const data = (await response.json()) as { features?: PhotonFeature[] }
  return (data.features ?? [])
    .map((feature, index) => fromPhoton(feature, index))
    .filter((entry): entry is GeocodeResult => entry != null)
}

async function searchNominatim(
  query: string,
  limit: number,
  signal?: AbortSignal
): Promise<GeocodeResult[]> {
  const url = new URL('https://nominatim.openstreetmap.org/search')
  url.searchParams.set('format', 'jsonv2')
  url.searchParams.set('addressdetails', '1')
  url.searchParams.set('limit', String(limit))
  if (US_ZIP.test(query)) {
    url.searchParams.set('postalcode', query.slice(0, 5))
    url.searchParams.set('country', 'USA')
    url.searchParams.set('countrycodes', 'us')
  } else {
    url.searchParams.set('q', query)
  }

  const response = await fetch(url.toString(), {
    signal,
    headers: { Accept: 'application/json', 'User-Agent': USER_AGENT }
  })
  if (!response.ok) return []

  const data = (await response.json()) as NominatimHit[]
  return data.map((hit, index) => fromNominatim(hit, index)).filter((entry): entry is GeocodeResult => entry != null)
}

async function searchOpenMeteo(query: string, signal?: AbortSignal): Promise<GeocodeResult[]> {
  const url = new URL('https://geocoding-api.open-meteo.com/v1/search')
  url.searchParams.set('name', query)
  url.searchParams.set('count', '3')
  url.searchParams.set('language', 'en')
  url.searchParams.set('format', 'json')

  const response = await fetch(url.toString(), { signal })
  if (!response.ok) return []
  const data = (await response.json()) as OpenMeteoResponse
  return (data.results ?? []).map((row, index) => {
    const parts = [row.name, row.admin1, row.country].filter(Boolean)
    const label = parts.join(', ')
    return {
      id: `om:${row.latitude.toFixed(4)},${row.longitude.toFixed(4)}:${index}`,
      lat: row.latitude,
      lon: row.longitude,
      label,
      detail: 'City',
      kind: 'city' as const,
      zoom: zoomForKind('city')
    }
  })
}

function fromPhoton(feature: PhotonFeature, index: number): GeocodeResult | null {
  const coords = feature.geometry?.coordinates
  const props = feature.properties
  if (!coords || !props) return null
  const lon = coords[0]
  const lat = coords[1]
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null

  const kind = kindFromPhoton(props.osm_value, props.type)
  const streetLine = [props.housenumber, props.street].filter(Boolean).join(' ')
  const title =
    kind === 'postcode'
      ? props.postcode || props.name || ''
      : kind === 'house' || kind === 'street'
        ? streetLine || props.name || ''
        : props.name || streetLine || props.city || ''
  if (!title) return null

  const region = formatRegion(props.district, props.city, props.county, props.state, props.country)
  const label =
    kind === 'postcode' && region ? `${title} · ${region}` : region && !region.startsWith(title) ? `${title}, ${region}` : title

  return {
    id: `ph:${props.osm_type ?? ''}${props.osm_id ?? index}:${lat.toFixed(5)},${lon.toFixed(5)}`,
    lat,
    lon,
    label,
    detail: kindLabel(kind),
    kind,
    zoom: zoomForKind(kind)
  }
}

function fromNominatim(hit: NominatimHit, index: number): GeocodeResult | null {
  const lat = Number(hit.lat)
  const lon = Number(hit.lon)
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null
  const kind = kindFromNominatim(hit.addresstype, hit.type)
  const address = hit.address
  const streetLine = [address?.house_number, address?.road].filter(Boolean).join(' ')
  const title =
    kind === 'postcode'
      ? address?.postcode || hit.name || ''
      : kind === 'house' || kind === 'street'
        ? streetLine || hit.name || ''
        : hit.name || streetLine || address?.city || ''
  if (!title) return null

  const region = formatRegion(
    address?.suburb,
    address?.city || address?.town || address?.village || address?.municipality,
    address?.county,
    address?.state,
    address?.country
  )
  const label =
    kind === 'postcode' && region ? `${title} · ${region}` : region && !region.startsWith(title) ? `${title}, ${region}` : title

  return {
    id: `nm:${hit.place_id ?? index}:${lat.toFixed(5)},${lon.toFixed(5)}`,
    lat,
    lon,
    label,
    detail: kindLabel(kind),
    kind,
    zoom: zoomForKind(kind)
  }
}

function kindFromPhoton(osmValue?: string, type?: string): GeocodeKind {
  const value = (osmValue || type || '').toLowerCase()
  if (value === 'postcode' || value === 'postal_code') return 'postcode'
  if (value === 'house' || value === 'building') return 'house'
  if (value === 'street' || value === 'highway') return 'street'
  if (value === 'city' || value === 'town' || value === 'village' || value === 'municipality') return 'city'
  if (value === 'county') return 'county'
  if (value === 'state' || value === 'region') return 'state'
  if (value === 'country') return 'country'
  if (value === 'district' || value === 'suburb' || value === 'neighbourhood' || value === 'neighborhood') {
    return 'district'
  }
  if (value === 'locality' || value === 'hamlet') return 'locality'
  return 'other'
}

function kindFromNominatim(addressType?: string, type?: string): GeocodeKind {
  const value = (addressType || type || '').toLowerCase()
  if (value === 'postcode' || value === 'postal_code') return 'postcode'
  if (value === 'house' || value === 'building' || value === 'amenity') return 'house'
  if (value === 'road' || value === 'street') return 'street'
  if (value === 'city' || value === 'town' || value === 'village' || value === 'municipality') return 'city'
  if (value === 'county') return 'county'
  if (value === 'state' || value === 'region') return 'state'
  if (value === 'country') return 'country'
  if (value === 'suburb' || value === 'neighbourhood' || value === 'district') return 'district'
  return 'other'
}

function formatRegion(
  district?: string,
  city?: string,
  county?: string,
  state?: string,
  country?: string
): string {
  const statePart = state ? US_STATE_ABBR[state] ?? state : ''
  const locality = city || district || stripCountySuffix(county)
  const parts = [locality, statePart].filter(Boolean)
  if (parts.length > 0) return parts.join(', ')
  return [county, state, country].filter(Boolean).join(', ')
}

function stripCountySuffix(value?: string): string | undefined {
  if (!value) return undefined
  return value.replace(/\s+County$/i, '')
}

function rankResults(
  results: GeocodeResult[],
  query: string,
  intent: GeocodeKind | 'place',
  bias?: GeocodeBias
): GeocodeResult[] {
  const zip = US_ZIP.test(query) ? query.slice(0, 5) : ''
  const q = query.toLowerCase()
  const seen = new Set<string>()
  const unique: GeocodeResult[] = []
  for (const result of results) {
    const key = `${result.kind}:${result.lat.toFixed(4)},${result.lon.toFixed(4)}:${result.label}`
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(result)
  }

  return unique.sort((a, b) => scoreResult(b, q, zip, intent, bias) - scoreResult(a, q, zip, intent, bias))
}

function scoreResult(
  result: GeocodeResult,
  query: string,
  zip: string,
  intent: GeocodeKind | 'place',
  bias?: GeocodeBias
): number {
  let score = 0
  const label = result.label.toLowerCase()
  if (intent !== 'place' && result.kind === intent) score += 80
  if (zip && result.kind === 'postcode' && label.startsWith(zip)) score += 120
  if (intent === 'house' && result.kind === 'house') score += 40
  if (intent === 'county' && result.kind === 'county') score += 60
  if (label.startsWith(query)) score += 24
  if (label.includes(query)) score += 10
  if (result.kind === 'city' && intent === 'place') score += 16
  if (bias) {
    const km = haversineKm(bias.lat, bias.lon, result.lat, result.lon)
    score += Math.max(0, 30 - km / 40)
  }
  return score
}

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRad = (value: number): number => (value * Math.PI) / 180
  const dLat = toRad(lat2 - lat1)
  const dLon = toRad(lon2 - lon1)
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}
