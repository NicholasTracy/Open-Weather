/** GOES weather satellite overlay — IEM TMS (IR/Vis/WV) + NASA GIBS GeoColor. */

export type SatelliteProduct = 'geocolor' | 'ir' | 'vis' | 'wv'
export type GoesBird = 'east' | 'west'
export type GoesSector = 'conus' | 'fulldisk'

export const SATELLITE_PRODUCTS: Array<{ id: SatelliteProduct; label: string }> = [
  { id: 'geocolor', label: 'GeoColor · day/night clouds' },
  { id: 'ir', label: 'Infrared · 10.3 µm' },
  { id: 'vis', label: 'Visible · 0.64 µm' },
  { id: 'wv', label: 'Water vapor · 6.9 µm' }
]

export const SATELLITE_ATTRIBUTION =
  '<a href="https://www.nesdis.noaa.gov">NOAA</a> · <a href="https://earthdata.nasa.gov/gibs">GIBS</a> · <a href="https://mesonet.agron.iastate.edu">IEM</a>'

const PRODUCT_CHANNEL: Record<Exclude<SatelliteProduct, 'geocolor'>, string> = {
  ir: '13',
  vis: '02',
  wv: '09'
}

const GIBS_LAYER: Record<GoesBird, string> = {
  east: 'GOES-East_ABI_GeoColor',
  west: 'GOES-West_ABI_GeoColor'
}

/** Rockies split — west of this uses GOES-West. */
export const GOES_BIRD_SPLIT_LON = -105

export type GoesView = {
  bird: GoesBird
  sector: GoesSector
  layer: string
}

export function isSatelliteProduct(value: unknown): value is SatelliteProduct {
  return value === 'geocolor' || value === 'ir' || value === 'vis' || value === 'wv'
}

export function pickGoesBird(lon: number): GoesBird {
  return lon < GOES_BIRD_SPLIT_LON ? 'west' : 'east'
}

export function pickGoesSector(lat: number, lon: number, zoom: number): GoesSector {
  if (zoom < 5) return 'fulldisk'
  const inEastConus = lat >= 14 && lat <= 57 && lon >= -128 && lon <= -64
  const inWestConus = lat >= 14 && lat <= 57 && lon >= -175 && lon <= -98
  return inEastConus || inWestConus ? 'conus' : 'fulldisk'
}

export function pickGoesView(lat: number, lon: number, zoom: number, product: SatelliteProduct): GoesView {
  const bird = pickGoesBird(lon)
  const sector = pickGoesSector(lat, lon, zoom)
  if (product === 'geocolor') {
    return { bird, sector, layer: GIBS_LAYER[bird] }
  }
  const channel = PRODUCT_CHANNEL[product]
  return { bird, sector, layer: `goes_${bird}_${sector}_ch${channel}` }
}

/** IEM 5-minute cache TMS. `{s}` is 1–3 for parallel hosts. */
export function buildGoesTileUrl(layer: string, cacheTick: number): string {
  return `https://mesonet{s}.agron.iastate.edu/cache/tile.py/1.0.0/${layer}/{z}/{x}/{y}.png?t=${cacheTick}`
}

export const IEM_TILE_SUBDOMAINS = ['1', '2', '3']

/**
 * NASA GIBS WMTS in EPSG:3857. Native max zoom is 7; Leaflet overzooms past that.
 * Tile path is {z}/{y}/{x} (WMTS row/col), not OSM {z}/{x}/{y}.
 */
export function buildGibsGeoColorUrl(bird: GoesBird, cacheTick: number): string {
  const layer = GIBS_LAYER[bird]
  return `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/${layer}/default/default/GoogleMapsCompatible_Level7/{z}/{y}/{x}.png?t=${cacheTick}`
}

export function satelliteStatusLabel(view: GoesView, product: SatelliteProduct): string {
  const bird = view.bird === 'west' ? 'GOES-W' : 'GOES-E'
  const name =
    product === 'geocolor' ? 'GeoColor' : product === 'ir' ? 'IR' : product === 'vis' ? 'Vis' : 'WV'
  return `${bird} ${name}`
}
