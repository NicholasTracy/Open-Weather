import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactElement } from 'react'
import { CircleMarker, MapContainer, Marker, TileLayer } from 'react-leaflet'
import {
  BASEMAP_TILES,
  clampLatitude,
  clampLongitude,
  isValidCoordinate,
  type MapLocation
} from '@shared/mapLocation'
import type { MapBounds } from '@shared/weatherOverlays'
import {
  NEXRAD_KEYFRAME_MS,
  nearestNexradSites,
  nexradLoopPositionByTimes,
  progressForFrameIndex,
  progressForTime,
  timeAtProgress,
  wrapLoopProgress
} from '@shared/nexrad'
import { bandwidthCaps } from '@shared/appSettings'
import { isMergedMosaic, mosaicSiteLimit, paletteStops, thresholdBiasDbz } from '@shared/radarDisplay'
import { HCA_STOPS } from '../../lib/nexradHca'
import { alertsNearPin, clampHazardRadiusMi, HAZARD_RADIUS_DEFAULT_MI } from '@shared/hazards'
import { isSatelliteProduct, SATELLITE_ATTRIBUTION, type SatelliteProduct } from '@shared/satellite'
import { LAYER_PRESETS, matchingLayerPreset, type LayerPreset } from '@shared/layerPresets'
import { formatWpcValidLabel } from '@shared/codsus'
import { registerRadarAgentController, AGENT_EVENTS } from '../../agent/agentHost'
import { readAppSettings, useAppSettings } from '../../hooks/useAppSettings'
import { useMapPreferences } from '../../hooks/useMapPreferences'
import { useRadarDisplayPrefs } from '../../hooks/useRadarDisplayPrefs'
import { useNexradLevel2 } from '../../hooks/useNexradLevel2'
import { useRainViewerRadar } from '../../hooks/useRainViewerRadar'
import { useViewportWeatherGrid } from '../../hooks/useViewportWeatherGrid'
import { useNwsHazards } from '../../hooks/useNwsHazards'
import { useWpcFronts, type WpcFrontsState } from '../../hooks/useWpcFronts'
import { useSpcOutlook } from '../../hooks/useSpcOutlook'
import { useLocalWeather } from '../../hooks/useLocalWeather'
import { looksLikeCoordinateLabel, reverseGeocode } from '../../lib/geocode'
import { AutosizeInput } from '../AutosizeInput'
import { LocationSearch, type LocationSearchHandle } from '../LocationSearch'
import { MapBoundsReporter } from './MapBoundsReporter'
import { MapPinContextMenu, MapViewController, MapZoomTracker } from './MapControllers'
import { MapPanes } from './MapPanes'
import { ForecastStyleOverlay } from './ForecastStyleOverlay'
import { HazardOverlay } from './HazardOverlay'
import { HazardInspectPanel } from './HazardInspectPanel'
import { HazardTicker } from './HazardTicker'
import { SpcOutlookOverlay, SpcOutlookLegend } from './SpcOutlookOverlay'
import { NearbyStationsOverlay, stationToLocation } from './NearbyStationsOverlay'
import { NexradLegend } from './NexradLegend'
import { NexradLevel2Overlay } from './NexradLevel2Overlay'
import { RadarDisplayMenu } from './RadarDisplayMenu'
import { RadarLoadBar, type RadarLoadTask } from './RadarLoadBar'
import { RadarLoadingOverlay } from './RadarLoadingOverlay'
import { RadarOverlayLayers, type RadarTileStatus } from './RadarOverlayLayers'
import { SatelliteOverlay } from './SatelliteOverlay'
import { RadarTimeline } from './RadarTimeline'
import { stationPinIcon } from './stationPin'
import 'leaflet/dist/leaflet.css'

type WeatherRadarMapProps = {
  compact?: boolean
  className?: string
}

const OVERLAY_KEY = 'open-weather.map.overlays'

type FrontSource = 'wpc' | 'local'

type OverlayState = {
  /** Isobars + H/L centers */
  pressure: boolean
  /** Cold / warm / stationary fronts */
  fronts: boolean
  /** City temperature chips */
  temps: boolean
  /** NOAA NEXRAD Level II reflectivity (nearest site). */
  nexrad: boolean
  /** GOES weather satellite (GeoColor / IR / visible / water vapor). */
  satellite: boolean
  satelliteProduct: SatelliteProduct
  /** NWS watches / warnings on the map and ticker. */
  hazards: boolean
  /** SPC Day-1 categorical convective outlook. */
  spc: boolean
  /** Nearby public station markers. */
  stations: boolean
  /** Miles from the pin used to include nearby watches / warnings. */
  hazardRadiusMi: number
  /** Which preloaded front dataset to draw */
  frontSource: FrontSource
}

const DEFAULT_OVERLAYS: OverlayState = {
  pressure: true,
  fronts: true,
  temps: true,
  nexrad: true,
  satellite: true,
  satelliteProduct: 'ir',
  hazards: true,
  spc: false,
  stations: true,
  hazardRadiusMi: HAZARD_RADIUS_DEFAULT_MI,
  frontSource: 'wpc'
}

function readOverlays(): OverlayState {
  try {
    const raw = localStorage.getItem(OVERLAY_KEY)
    if (!raw) return { ...DEFAULT_OVERLAYS, ...readAppSettings().overlays }
    const parsed = JSON.parse(raw) as Partial<OverlayState> & { wind?: boolean }
    // Older saves used `wind` for the fronts toggle.
    const fronts =
      parsed.fronts !== undefined
        ? parsed.fronts !== false
        : parsed.wind !== false
    return {
      pressure: parsed.pressure !== false,
      fronts,
      temps: parsed.temps !== false,
      nexrad: parsed.nexrad !== false,
      satellite: parsed.satellite !== false,
      satelliteProduct: isSatelliteProduct(parsed.satelliteProduct)
        ? parsed.satelliteProduct
        : DEFAULT_OVERLAYS.satelliteProduct,
      hazards: parsed.hazards !== false,
      spc: parsed.spc === true,
      stations: parsed.stations !== false,
      hazardRadiusMi: clampHazardRadiusMi(parsed.hazardRadiusMi ?? DEFAULT_OVERLAYS.hazardRadiusMi),
      frontSource: parsed.frontSource === 'local' ? 'local' : 'wpc'
    }
  } catch {
    return { ...DEFAULT_OVERLAYS }
  }
}

function RadarCredits({
  compact,
  nexrad,
  rainViewer,
  satellite,
  basemapAttribution
}: {
  compact: boolean
  nexrad: boolean
  rainViewer: boolean
  satellite: boolean
  basemapAttribution: string
}): ReactElement {
  const parts = [
    '<a href="https://leafletjs.com" title="A JavaScript library for interactive maps">Leaflet</a>',
    nexrad
      ? '<a href="https://www.ncei.noaa.gov/products/radar/next-generation-weather-radar">NEXRAD</a>'
      : null,
    rainViewer ? '<a href="https://www.rainviewer.com">RainViewer</a>' : null,
    satellite ? SATELLITE_ATTRIBUTION : null,
    basemapAttribution
  ].filter(Boolean)

  return (
    <div
      className={`radar-credits${compact ? ' radar-credits--compact' : ''}`}
      dangerouslySetInnerHTML={{ __html: parts.join(' · ') }}
    />
  )
}

export function WeatherRadarMap({
  compact = false,
  className = ''
}: WeatherRadarMapProps): ReactElement {
  const { location, basemap, setLocation, setBasemap } = useMapPreferences()
  const { settings } = useAppSettings()
  const bandwidth = bandwidthCaps(settings.bandwidth)
  const { prefs, updatePrefs } = useRadarDisplayPrefs()
  const [playing, setPlaying] = useState(true)
  const [l2Progress, setL2Progress] = useState(0)
  const searchRef = useRef<LocationSearchHandle>(null)
  const [search, setSearch] = useState(location.label)
  const [latInput, setLatInput] = useState(() => location.lat.toFixed(5))
  const [lonInput, setLonInput] = useState(() => location.lon.toFixed(5))
  const [status, setStatus] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [overlays, setOverlays] = useState<OverlayState>(() => readOverlays())
  const [selectedHazardId, setSelectedHazardId] = useState<string | null>(null)
  const [bounds, setBounds] = useState<MapBounds | null>(null)
  const [tileStatus, setTileStatus] = useState<RadarTileStatus>({
    loaded: 0,
    total: 0,
    failed: 0,
    ready: false,
    readyFrames: 0,
    totalFrames: 0,
    readyPaths: []
  })
  const readyPathsRef = useRef<Set<string>>(new Set())
  const l2AutostartRef = useRef(false)
  const l2ProgressRef = useRef(0)
  const l2ClockRef = useRef<number[]>([])
  const lastRadarTimeRef = useRef<number | null>(null)
  const speedRef = useRef(prefs.speed)
  speedRef.current = prefs.speed

  const nearbySites = useMemo(
    () => nearestNexradSites(location.lat, location.lon, 24),
    [location.lat, location.lon]
  )
  const nexradSites = useMemo(() => {
    if (isMergedMosaic(prefs.mosaicMode)) {
      return nearbySites.slice(0, mosaicSiteLimit(prefs.mosaicMode)).map((entry) => entry.site)
    }
    const chosen =
      nearbySites.find((entry) => entry.site.id === prefs.siteId)?.site ?? nearbySites[0]?.site
    return chosen ? [chosen] : []
  }, [nearbySites, prefs.mosaicMode, prefs.siteId])
  const nexradEnabled = overlays.nexrad && settings.allowNexrad
  const satelliteEnabled = overlays.satellite && settings.allowSatellite
  const nexrad = useNexradLevel2(
    nexradSites,
    nexradEnabled,
    Math.min(prefs.loopFrames, bandwidth.loopFrames)
  )
  const hcaReady = useMemo(
    () =>
      nexrad.frames.some((frame) => Boolean(frame.hca?.length)) ||
      nexrad.composite.some((frame) => Boolean(frame.hca?.length)),
    [nexrad.frames, nexrad.composite]
  )
  const useHca = prefs.product === 'hca' && hcaReady
  const displayStops = useMemo(
    () => (useHca ? HCA_STOPS : paletteStops(prefs.palette)),
    [useHca, prefs.palette]
  )
  const displayBias = thresholdBiasDbz(prefs.threshold)
  const nexradFramesRef = useRef(nexrad.frames)
  const l2PlayingRef = useRef(false)
  nexradFramesRef.current = nexrad.frames
  const waitingLevel2 = nexradEnabled && !nexrad.ready
  const liveLevel2 = nexradEnabled && nexrad.ready && nexrad.frames.length > 0
  l2PlayingRef.current = playing && liveLevel2 && !waitingLevel2
  const radar = useRainViewerRadar(playing && !liveLevel2 && settings.allowRadarFallback, {
    isFrameReady: (path) => readyPathsRef.current.has(path)
  })
  const weather = useViewportWeatherGrid(bounds, true, {
    compact: bandwidth.compactGrid
  })
  const wpcFronts: WpcFrontsState = useWpcFronts(bounds, true)
  const hazards = useNwsHazards(
    overlays.hazards,
    { lat: location.lat, lon: location.lon },
    bandwidth.hazardRefreshMs
  )
  const spcOutlook = useSpcOutlook(overlays.spc)
  const nearbyWeather = useLocalWeather(location)
  const visibleHazards = useMemo(
    () =>
      overlays.hazards
        ? alertsNearPin(hazards.alerts, { lat: location.lat, lon: location.lon }, overlays.hazardRadiusMi)
        : [],
    [overlays.hazards, hazards.alerts, overlays.hazardRadiusMi, location.lat, location.lon]
  )
  const selectedHazard = useMemo(
    () => visibleHazards.find((alert) => alert.id === selectedHazardId) ?? null,
    [visibleHazards, selectedHazardId]
  )

  useEffect(() => {
    if (selectedHazardId && !selectedHazard) setSelectedHazardId(null)
  }, [selectedHazard, selectedHazardId])

  useEffect(() => {
    if (prefs.mosaicMode !== 'single') return
    if (prefs.siteId && nearbySites.some((entry) => entry.site.id === prefs.siteId)) return
    const nearest = nearbySites[0]?.site.id
    if (nearest) updatePrefs({ siteId: nearest })
  }, [nearbySites, prefs.mosaicMode, prefs.siteId, updatePrefs])

  useEffect(() => {
    if (!nexradEnabled) {
      l2AutostartRef.current = false
      return
    }
    if (waitingLevel2) {
      l2AutostartRef.current = false
      l2ProgressRef.current = 0
      setL2Progress(0)
      setPlaying(false)
      return
    }
    if (l2AutostartRef.current || nexrad.frames.length < 2) return
    l2AutostartRef.current = true
    setPlaying(false)
  }, [nexradEnabled, waitingLevel2, nexrad.frames.length])

  useEffect(() => {
    if (!liveLevel2 || radar.frames.length === 0) return
    radar.setFrameIndex(radar.frames.length - 1)
  }, [liveLevel2, radar.frames.length, radar.setFrameIndex])

  useEffect(() => {
    if (!playing) return
    let raf = 0
    let epoch = 0
    let pausedProgress = wrapLoopProgress(l2ProgressRef.current)

    const tick = (): void => {
      raf = requestAnimationFrame(tick)
      const now = performance.now()
      const frames = nexradFramesRef.current
      if (!l2PlayingRef.current) {
        epoch = 0
        pausedProgress = wrapLoopProgress(l2ProgressRef.current)
        return
      }
      if (frames.length < 2) return
      const span =
        (NEXRAD_KEYFRAME_MS / Math.max(0.4, speedRef.current)) * Math.max(1, frames.length - 1)
      if (epoch === 0) epoch = now - pausedProgress * span
      l2ProgressRef.current = ((now - epoch) / span) % 1
      const clock = l2ClockRef.current
      if (clock.length > 0) lastRadarTimeRef.current = timeAtProgress(clock, l2ProgressRef.current)
    }
    raf = requestAnimationFrame(tick)
    return () => window.cancelAnimationFrame(raf)
  }, [playing, prefs.speed])

  const forecastModel = useMemo(() => {
    const systems =
      wpcFronts.systems.length > 0 ? wpcFronts.systems : weather.model.systems
    if (!overlays.fronts) {
      return { ...weather.model, fronts: [], systems }
    }
    if (overlays.frontSource === 'wpc' && wpcFronts.source === 'wpc') {
      return { ...weather.model, fronts: wpcFronts.fronts, systems }
    }
    return { ...weather.model, systems }
  }, [
    overlays.fronts,
    overlays.frontSource,
    weather.model,
    wpcFronts.fronts,
    wpcFronts.systems,
    wpcFronts.source
  ])

  const wpcDay1Missing =
    overlays.fronts &&
    overlays.frontSource === 'wpc' &&
    wpcFronts.settled &&
    wpcFronts.source !== 'wpc'

  const loadTasks = useMemo<RadarLoadTask[]>(() => {
    const catalog =
      radar.frames.length > 0 ? (radar.incomplete ? 0.72 : 1) : radar.loading ? 0.12 : 0
    const hideMosaic = nexradEnabled
    const tiles = hideMosaic
      ? 1
      : tileStatus.totalFrames > 0
        ? tileStatus.readyFrames / tileStatus.totalFrames
        : radar.frames.length > 0
          ? 0.08
          : 0
    let field =
      weather.progress.total > 0
        ? Math.min(1, weather.progress.loaded / weather.progress.total)
        : weather.loading
          ? 0.08
          : weather.model.grid
            ? 1
            : 0
    if (weather.model.grid) field = 1
    const wpcNeeded = overlays.fronts && overlays.frontSource === 'wpc'
    const wpc = !wpcNeeded || wpcFronts.settled || wpcFronts.error ? 1 : wpcFronts.loading ? 0.45 : 1
    const level2 = !nexradEnabled ? 1 : nexrad.ready || nexrad.error ? 1 : nexrad.progress
    return [
      { id: 'catalog', label: 'Radar catalog', fraction: catalog, weight: hideMosaic ? 0 : 2 },
      { id: 'tiles', label: 'Radar frames', fraction: tiles, weight: hideMosaic ? 0 : 2 },
      {
        id: 'nexrad',
        label: 'NEXRAD Level II',
        fraction: level2,
        weight: nexradEnabled ? 4 : 0
      },
      { id: 'field', label: 'Forecast field', fraction: field, weight: 3 },
      { id: 'wpc', label: 'WPC surface analysis', fraction: wpc, weight: wpcNeeded ? 1 : 0 }
    ]
  }, [
    radar.frames.length,
    radar.incomplete,
    radar.loading,
    tileStatus.readyFrames,
    tileStatus.totalFrames,
    weather.progress.loaded,
    weather.progress.total,
    weather.progress.incomplete,
    weather.loading,
    weather.model.grid,
    wpcFronts.settled,
    wpcFronts.loading,
    wpcFronts.error,
    nexradEnabled,
    overlays.fronts,
    overlays.frontSource,
    nexrad.sweep,
    nexrad.loading,
    nexrad.ready,
    nexrad.progress,
    nexrad.loaded,
    nexrad.total,
    nexrad.error,
    nexrad.frames.length
  ])

  const l2Clock = useMemo(() => {
    if (nexrad.composite.length > 0) return nexrad.composite.map((frame) => frame.timeUnix)
    return nexrad.frames.map((frame) => frame.meta.timeUnix)
  }, [nexrad.composite, nexrad.frames])
  l2ClockRef.current = l2Clock

  useEffect(() => {
    if (l2Clock.length < 2 || lastRadarTimeRef.current == null) return
    l2ProgressRef.current = progressForTime(l2Clock, lastRadarTimeRef.current)
  }, [l2Clock])

  const l2Pair = useMemo(() => {
    if (l2Clock.length === 0 || nexrad.frames.length === 0) return null
    const pos = nexradLoopPositionByTimes(l2Clock, l2Progress)
    const fromTime = l2Clock[pos.fromIndex] ?? nexrad.frames[0]!.meta.timeUnix
    const toTime = l2Clock[pos.toIndex] ?? fromTime
    const from =
      nexrad.frames.find((frame) => frame.meta.timeUnix === fromTime) ??
      nexrad.frames[Math.min(pos.fromIndex, nexrad.frames.length - 1)]!
    const to =
      nexrad.frames.find((frame) => frame.meta.timeUnix === toTime) ??
      nexrad.frames[Math.min(pos.toIndex, nexrad.frames.length - 1)] ??
      from
    const timeUnix = fromTime + (toTime - fromTime) * pos.blend
    return { from, to, index: pos.index, timeUnix }
  }, [l2Clock, l2Progress, nexrad.frames])

  const l2TimelineFrames = useMemo(
    () => l2Clock.map((time) => ({ time })),
    [l2Clock]
  )

  const basemapConfig = BASEMAP_TILES[basemap]

  const setOverlay = (
    key: Exclude<keyof OverlayState, 'frontSource' | 'satelliteProduct' | 'hazardRadiusMi'>,
    value: boolean
  ): void => {
    setOverlays((current) => {
      const next = { ...current, [key]: value }
      localStorage.setItem(OVERLAY_KEY, JSON.stringify(next))
      return next
    })
  }

  const setHazardRadius = (hazardRadiusMi: number): void => {
    setOverlays((current) => {
      const next = { ...current, hazardRadiusMi: clampHazardRadiusMi(hazardRadiusMi) }
      localStorage.setItem(OVERLAY_KEY, JSON.stringify(next))
      return next
    })
  }

  const setSatelliteProduct = (satelliteProduct: SatelliteProduct): void => {
    setOverlays((current) => {
      const next = { ...current, satellite: true, satelliteProduct }
      localStorage.setItem(OVERLAY_KEY, JSON.stringify(next))
      return next
    })
  }

  const setFrontSource = (frontSource: FrontSource): void => {
    setOverlays((current) => {
      const next = { ...current, fronts: true, frontSource }
      localStorage.setItem(OVERLAY_KEY, JSON.stringify(next))
      return next
    })
  }

  const applyLayerPreset = (preset: LayerPreset): void => {
    setOverlays((current) => {
      const next = { ...current, ...preset.overlays }
      localStorage.setItem(OVERLAY_KEY, JSON.stringify(next))
      return next
    })
    if (preset.basemap) setBasemap(preset.basemap)
  }

  const activeLayerPreset = matchingLayerPreset(overlays)

  const applyLocation = (next: MapLocation, options?: { resolveName?: boolean }): void => {
    const normalized: MapLocation = {
      lat: clampLatitude(Number(next.lat.toFixed(5))),
      lon: clampLongitude(Number(next.lon.toFixed(5))),
      label: next.label.trim() || 'Custom pin',
      zoom: Math.min(12, Math.max(3, Math.round(next.zoom)))
    }
    setLocation(normalized)
    setLatInput(normalized.lat.toFixed(5))
    setLonInput(normalized.lon.toFixed(5))
    setSearch(normalized.label)
    setStatus(`Pinned · ${normalized.label}`)

    const shouldResolve =
      options?.resolveName === true || looksLikeCoordinateLabel(normalized.label)
    if (!shouldResolve) return

    void reverseGeocode(normalized.lat, normalized.lon).then((place) => {
      if (!place) return
      const refined: MapLocation = { ...normalized, label: place }
      setLocation(refined)
      setSearch(place)
      setStatus(`Pinned · ${place}`)
    })
  }

  // Upgrade stored coordinate-only pins when the map mounts.
  useEffect(() => {
    if (!looksLikeCoordinateLabel(location.label)) return
    let cancelled = false
    void reverseGeocode(location.lat, location.lon).then((place) => {
      if (cancelled || !place) return
      setLocation({ ...location, label: place })
      setSearch(place)
    })
    return () => {
      cancelled = true
    }
    // Intentional: only on mount / when pin coords change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.lat, location.lon])

  useEffect(() => {
    const onAgentLocation = (event: Event): void => {
      const detail = (event as CustomEvent<MapLocation>).detail
      if (!detail) return
      setLatInput(detail.lat.toFixed(5))
      setLonInput(detail.lon.toFixed(5))
      setSearch(detail.label)
      setStatus(`Pinned · ${detail.label}`)
    }
    const onAgentOverlays = (event: Event): void => {
      const detail = (event as CustomEvent<Partial<OverlayState> & { wind?: boolean }>).detail
      if (!detail) return
      setOverlays((current) => {
        const fronts =
          detail.fronts !== undefined
            ? detail.fronts
            : detail.wind !== undefined
              ? detail.wind
              : current.fronts
        const next: OverlayState = {
          pressure: detail.pressure ?? current.pressure,
          fronts,
          temps: detail.temps ?? current.temps,
          nexrad: detail.nexrad ?? current.nexrad,
          satellite: detail.satellite ?? current.satellite,
          satelliteProduct: isSatelliteProduct(detail.satelliteProduct)
            ? detail.satelliteProduct
            : current.satelliteProduct,
          hazards: detail.hazards ?? current.hazards,
          spc: detail.spc ?? current.spc,
          stations: detail.stations ?? current.stations,
          hazardRadiusMi: clampHazardRadiusMi(detail.hazardRadiusMi ?? current.hazardRadiusMi),
          frontSource:
            detail.frontSource === 'local' || detail.frontSource === 'wpc'
              ? detail.frontSource
              : current.frontSource
        }
        localStorage.setItem(OVERLAY_KEY, JSON.stringify(next))
        return next
      })
    }
    const onAgentRadar = (event: Event): void => {
      const detail = (event as CustomEvent<{ playing?: boolean }>).detail
      if (typeof detail?.playing === 'boolean') {
        setPlaying(detail.playing)
      }
    }
    window.addEventListener(AGENT_EVENTS.location, onAgentLocation)
    window.addEventListener(AGENT_EVENTS.overlays, onAgentOverlays)
    window.addEventListener(AGENT_EVENTS.radar, onAgentRadar)
    return () => {
      window.removeEventListener(AGENT_EVENTS.location, onAgentLocation)
      window.removeEventListener(AGENT_EVENTS.overlays, onAgentOverlays)
      window.removeEventListener(AGENT_EVENTS.radar, onAgentRadar)
    }
  }, [])

  useEffect(() => {
    registerRadarAgentController({
      getState: () => ({
        playing,
        frameIndex: liveLevel2
          ? nexradLoopPositionByTimes(l2Clock, l2ProgressRef.current).index
          : radar.frameIndex,
        frameCount: liveLevel2 ? l2Clock.length : radar.frames.length,
        frameDateLabel: liveLevel2
          ? l2Pair
            ? new Date(l2Pair.timeUnix * 1000).toLocaleString(undefined, {
                weekday: 'short',
                month: 'short',
                day: 'numeric',
                year: 'numeric'
              })
            : null
          : radar.frameDateLabel === '—'
            ? null
            : radar.frameDateLabel
      }),
      setPlaying: (next) => setPlaying(next),
      setFrameIndex: (index) => {
        setPlaying(false)
        if (liveLevel2) {
          const next = progressForFrameIndex(l2Clock, index)
          setL2Progress(next)
          l2ProgressRef.current = next
          if (l2Clock.length > 0) lastRadarTimeRef.current = timeAtProgress(l2Clock, next)
          return
        }
        radar.setFrameIndex(index)
      },
      setProgress: (progress) => {
        setPlaying(false)
        if (liveLevel2) {
          setL2Progress(progress)
          l2ProgressRef.current = progress
          if (l2Clock.length > 0) lastRadarTimeRef.current = timeAtProgress(l2Clock, progress)
          return
        }
        radar.setProgress(progress)
      }
    })
    return () => registerRadarAgentController(null)
  }, [
    playing,
    liveLevel2,
    l2Pair,
    l2Clock,
    nexrad.frames.length,
    radar.frameIndex,
    radar.frames.length,
    radar.frameDateLabel,
    radar.setFrameIndex,
    radar.setProgress
  ])

  const onSubmitSearch = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    setBusy(true)
    setStatus(null)
    try {
      const result = await searchRef.current?.resolve()
      if (!result) {
        setStatus('No matching place found.')
        return
      }
      applyLocation({
        lat: result.lat,
        lon: result.lon,
        label: result.label,
        zoom: result.zoom
      })
    } catch (err) {
      setStatus(err instanceof Error ? err.message : 'Geocoding failed')
    } finally {
      setBusy(false)
    }
  }

  const onApplyCoordinates = (event?: FormEvent): void => {
    event?.preventDefault()
    const lat = clampLatitude(Number(latInput))
    const lon = clampLongitude(Number(lonInput))
    if (!isValidCoordinate(lat, lon)) {
      setStatus('Enter valid latitude and longitude.')
      return
    }
    applyLocation(
      {
        lat,
        lon,
        label: `${lat.toFixed(4)}, ${lon.toFixed(4)}`,
        zoom: location.zoom
      },
      { resolveName: true }
    )
  }

  const radarValidLabel =
    nexradEnabled && liveLevel2 && l2Pair
      ? new Date(l2Pair.timeUnix * 1000).toLocaleTimeString(undefined, {
          hour: 'numeric',
          minute: '2-digit'
        })
      : nexradEnabled && radar.frameTimeLabel && radar.frameTimeLabel !== '—'
        ? radar.frameTimeLabel
        : null
  const showAnalysisValid =
    overlays.fronts && overlays.frontSource === 'wpc' && wpcFronts.source === 'wpc'

  const basemapButtons = useMemo(
    () =>
      (
        [
          ['dark', 'Dark'],
          ['light', 'Light'],
          ['satellite', 'Satellite']
        ] as const
      ).map(([id, label]) => (
        <button
          key={id}
          type="button"
          className={`btn btn-sm ${basemap === id ? 'btn-ow-primary' : 'btn-ow-ghost'}`}
          onClick={() => setBasemap(id)}
        >
          {label}
        </button>
      )),
    [basemap, setBasemap]
  )

  return (
    <div className={`radar-shell ${compact ? 'radar-shell--compact' : 'radar-shell--full'} ${className}`.trim()}>
      <div className="radar-toolbar">
        <div className="radar-toolbar__group" aria-label="Basemap">
          <span className="radar-toolbar__label">Basemap</span>
          {basemapButtons}
        </div>

        <div className="radar-toolbar__group" aria-label="Layer presets">
          <span className="radar-toolbar__label">View</span>
          {LAYER_PRESETS.map((preset) => (
            <button
              key={preset.id}
              type="button"
              className={`btn btn-sm ${activeLayerPreset === preset.id ? 'btn-ow-primary' : 'btn-ow-ghost'}`}
              title={preset.title}
              onClick={() => applyLayerPreset(preset)}
            >
              {preset.label}
            </button>
          ))}
        </div>

        <div className="radar-toolbar__group" aria-label="Weather overlays">
          <span className="radar-toolbar__label">Overlays</span>
          <button
            type="button"
            className={`btn btn-sm ${overlays.pressure ? 'btn-ow-primary' : 'btn-ow-ghost'}`}
            onClick={() => setOverlay('pressure', !overlays.pressure)}
            title="Isobars and high/low pressure centers only"
          >
            Pressure
          </button>
          <button
            type="button"
            className={`btn btn-sm ${overlays.fronts ? 'btn-ow-primary' : 'btn-ow-ghost'}`}
            onClick={() => setOverlay('fronts', !overlays.fronts)}
            title="Show or hide frontal overlay"
          >
            Fronts
          </button>
          <button
            type="button"
            className={`btn btn-sm ${overlays.temps ? 'btn-ow-primary' : 'btn-ow-ghost'}`}
            onClick={() => setOverlay('temps', !overlays.temps)}
            title="City temperature badges (current, high, low)"
          >
            Temps
          </button>
          <button
            type="button"
            className={`btn btn-sm ${overlays.nexrad ? 'btn-ow-primary' : 'btn-ow-ghost'}`}
            onClick={() => setOverlay('nexrad', !overlays.nexrad)}
            title="NOAA NEXRAD Level II reflectivity from the nearest WSR-88D"
          >
            NEXRAD L2
          </button>
          <button
            type="button"
            className={`btn btn-sm ${overlays.satellite ? 'btn-ow-primary' : 'btn-ow-ghost'}`}
            onClick={() => setOverlay('satellite', !overlays.satellite)}
            title="GOES weather satellite — GeoColor, infrared, visible, or water vapor"
          >
            GOES
          </button>
          <button
            type="button"
            className={`btn btn-sm ${overlays.hazards ? 'btn-ow-primary' : 'btn-ow-ghost'}`}
            onClick={() => setOverlay('hazards', !overlays.hazards)}
            title="NWS watches and warnings — polygons and ticker"
          >
            Hazards
          </button>
          <button
            type="button"
            className={`btn btn-sm ${overlays.spc ? 'btn-ow-primary' : 'btn-ow-ghost'}`}
            onClick={() => setOverlay('spc', !overlays.spc)}
            title="SPC Day-1 categorical convective outlook"
          >
            SPC D1
          </button>
          <button
            type="button"
            className={`btn btn-sm ${overlays.stations ? 'btn-ow-primary' : 'btn-ow-ghost'}`}
            onClick={() => setOverlay('stations', !overlays.stations)}
            title="Nearby public stations used in the local blend"
          >
            Stations
          </button>
        </div>

        <div className="radar-toolbar__group" aria-label="Front source">
          <span className="radar-toolbar__label">Fronts</span>
          <button
            type="button"
            className={`btn btn-sm ${
              overlays.fronts && overlays.frontSource === 'wpc' ? 'btn-ow-primary' : 'btn-ow-ghost'
            }`}
            onClick={() => setFrontSource('wpc')}
            title="Official NOAA WPC analyzed surface fronts (3-hourly coded bulletin)"
          >
            WPC Sfc
          </button>
          <button
            type="button"
            className={`btn btn-sm ${
              overlays.fronts && overlays.frontSource === 'local' ? 'btn-ow-primary' : 'btn-ow-ghost'
            }`}
            onClick={() => setFrontSource('local')}
            title="Local temperature-gradient estimate (preloaded)"
          >
            Local
          </button>
        </div>

        <div className="radar-toolbar__group" aria-label="Map tools">
          <span className="radar-toolbar__label">Tools</span>
          <button
            type="button"
            className="btn btn-sm btn-ow-ghost"
            onClick={() => {
              void radar.refresh()
              void weather.refresh()
              void wpcFronts.refresh()
              void nexrad.refresh()
              void hazards.refresh()
              void spcOutlook.refresh()
              void nearbyWeather.refresh()
            }}
          >
            Refresh
          </button>
          {settings.homePin ? (
            <button
              type="button"
              className="btn btn-sm btn-ow-ghost"
              title={`Go to ${settings.homePin.label}`}
              onClick={() => setLocation({ ...settings.homePin! })}
            >
              Home
            </button>
          ) : null}
        </div>

        {!compact && radar.error ? <span className="text-danger small">{radar.error}</span> : null}
        {!compact && nexrad.error ? <span className="text-danger small">{nexrad.error}</span> : null}
        {!compact && weather.error ? <span className="text-danger small">{weather.error}</span> : null}
        {!compact && hazards.error ? <span className="text-danger small">{hazards.error}</span> : null}
        {!compact && spcOutlook.error ? <span className="text-danger small">{spcOutlook.error}</span> : null}

        {waitingLevel2 ? null : <RadarLoadBar tasks={loadTasks} compact={compact} />}
      </div>

      {wpcDay1Missing ? (
        <div className="radar-notice" role="status">
          <span className="radar-notice__text">
            <strong>WPC surface fronts unavailable.</strong>
            {compact
              ? ' Showing local estimate.'
              : ' Showing the preloaded local estimate until WPC returns.'}
          </span>
          <button
            type="button"
            className="btn btn-sm btn-ow-ghost"
            onClick={() => void wpcFronts.refresh()}
          >
            Retry
          </button>
        </div>
      ) : null}

      <div className="radar-map-frame">
        {overlays.hazards ? (
          <>
            <HazardTicker
              alerts={visibleHazards}
              compact={compact}
              selectedId={selectedHazardId}
              onSelect={(id) =>
                setSelectedHazardId((current) => (current === id ? null : id))
              }
            />
            {selectedHazard ? (
              <HazardInspectPanel
                alert={selectedHazard}
                compact={compact}
                onClose={() => setSelectedHazardId(null)}
              />
            ) : null}
          </>
        ) : null}
        <RadarDisplayMenu
          prefs={prefs}
          sites={nearbySites}
          satelliteProduct={overlays.satelliteProduct}
          hazardRadiusMi={overlays.hazardRadiusMi}
          onChange={updatePrefs}
          onSatelliteProduct={setSatelliteProduct}
          onHazardRadius={setHazardRadius}
        />
        <RadarTimeline
          frames={liveLevel2 ? l2TimelineFrames : radar.frames}
          frameIndex={liveLevel2 ? (l2Pair?.index ?? 0) : radar.frameIndex}
          progress={liveLevel2 ? l2Progress : radar.progress}
          frameDateLabel={
            liveLevel2 && l2Pair
              ? new Date(l2Pair.timeUnix * 1000).toLocaleDateString(undefined, {
                  weekday: 'short',
                  month: 'short',
                  day: 'numeric'
                })
              : radar.frameDateLabel
          }
          frameTimeLabel={
            liveLevel2 && l2Pair
              ? new Date(l2Pair.timeUnix * 1000).toLocaleTimeString(undefined, {
                  hour: 'numeric',
                  minute: '2-digit'
                })
              : radar.frameTimeLabel
          }
          disabled={
            waitingLevel2 || (liveLevel2 ? nexrad.frames.length === 0 : radar.frames.length === 0)
          }
          compact={compact}
          playing={playing && !waitingLevel2}
          continuous={liveLevel2}
          progressRef={liveLevel2 ? l2ProgressRef : undefined}
          onTogglePlay={() => setPlaying((value) => !value)}
          onStep={(delta) => {
            setPlaying(false)
            if (liveLevel2) {
              const last = Math.max(0, l2Clock.length - 1)
              const nextIndex = Math.max(0, Math.min(last, (l2Pair?.index ?? 0) + delta))
              const next = progressForFrameIndex(l2Clock, nextIndex)
              l2ProgressRef.current = next
              setL2Progress(next)
              if (l2Clock.length > 0) lastRadarTimeRef.current = timeAtProgress(l2Clock, next)
              return
            }
            radar.setFrameIndex(radar.frameIndex + delta)
          }}
          onSeek={(next) => {
            setPlaying(false)
            if (liveLevel2) {
              l2ProgressRef.current = next
              setL2Progress(next)
              if (l2Clock.length > 0) lastRadarTimeRef.current = timeAtProgress(l2Clock, next)
              return
            }
            radar.setProgress(next)
          }}
        />
        <MapContainer
          center={[location.lat, location.lon]}
          zoom={location.zoom}
          minZoom={3}
          maxZoom={12}
          className="radar-map"
          scrollWheelZoom
          attributionControl={false}
        >
          <MapPanes />
          <MapViewController location={location} />
          <MapBoundsReporter onBounds={setBounds} />
          <MapZoomTracker
            onZoom={(zoom) => {
              if (zoom !== location.zoom) {
                setLocation({ ...location, zoom })
              }
            }}
          />
          <MapPinContextMenu
            onPin={(lat, lon) => {
              applyLocation(
                {
                  lat,
                  lon,
                  label: `${lat.toFixed(4)}, ${lon.toFixed(4)}`,
                  zoom: location.zoom
                },
                { resolveName: true }
              )
            }}
          />
          <TileLayer
            key={basemap}
            attribution={basemapConfig.attribution}
            url={basemapConfig.url}
            maxZoom={basemapConfig.maxZoom}
            {...(basemapConfig.subdomains
              ? { subdomains: basemapConfig.subdomains }
              : {})}
          />
          {satelliteEnabled ? (
            <SatelliteOverlay
              product={overlays.satelliteProduct}
              opacity={nexradEnabled ? 0.68 : 0.82}
              cacheMs={bandwidth.satelliteCacheMs}
            />
          ) : null}
          {nexradEnabled ? null : (
            <RadarOverlayLayers
              host={radar.host}
              frames={radar.frames}
              frameIndex={radar.frameIndex}
              opacity={prefs.opacity}
              onStatus={(status) => {
                readyPathsRef.current = new Set(status.readyPaths)
                setTileStatus(status)
              }}
            />
          )}
          {overlays.hazards ? (
            <HazardOverlay
              alerts={visibleHazards}
              selectedId={selectedHazardId}
              pin={{ lat: location.lat, lon: location.lon }}
              radiusMi={overlays.hazardRadiusMi}
              onSelect={setSelectedHazardId}
            />
          ) : null}
          {overlays.spc && spcOutlook.collection ? (
            <SpcOutlookOverlay collection={spcOutlook.collection} />
          ) : null}
          {overlays.stations ? (
            <NearbyStationsOverlay
              stations={nearbyWeather.weather?.stations ?? []}
              onSelect={(station) => applyLocation(stationToLocation(station))}
            />
          ) : null}
          {liveLevel2 ? (
            <NexradLevel2Overlay
              frames={nexrad.frames}
              siteFrames={nexrad.layers.map((layer) => layer.frames)}
              composite={nexrad.composite}
              playing={playing && !waitingLevel2}
              progress={l2Progress}
              playheadRef={l2ProgressRef}
              opacity={prefs.opacity}
              paletteStops={displayStops}
              thresholdBias={displayBias}
              cohesion={prefs.cohesion}
              preferGrid={isMergedMosaic(prefs.mosaicMode)}
              drift={prefs.drift}
              classMode={useHca}
            />
          ) : null}
          {liveLevel2
            ? nexrad.layers
                .filter((layer) => layer.frames.length > 0)
                .map((layer, index) => {
                  const sweep = layer.frames[layer.frames.length - 1]!
                  return (
                    <CircleMarker
                      key={`pin-${layer.site.id}`}
                      center={[sweep.meta.lat, sweep.meta.lon]}
                      radius={index === 0 ? 5 : 4}
                      pathOptions={{
                        color: '#f4f7ff',
                        weight: 2,
                        fillColor: index === 0 ? '#5aa2ff' : '#7ad0c8',
                        fillOpacity: 0.95
                      }}
                    />
                  )
                })
            : null}
          <ForecastStyleOverlay
            model={forecastModel}
            showPressure={overlays.pressure}
            showFronts={overlays.fronts}
            showTemps={overlays.temps}
          />
          <Marker position={[location.lat, location.lon]} icon={stationPinIcon} />
        </MapContainer>
        {waitingLevel2 ? (
          <RadarLoadingOverlay
            progress={nexrad.progress}
            label={
              nexradSites.length > 1
                ? `Loading ${nexradSites.map((site) => site.id).join(' + ')}`
                : `Loading ${nexradSites[0]?.id ?? 'NEXRAD'}`
            }
          />
        ) : null}
        <div className="map-time-stack">
          {showAnalysisValid ? (
            <div
              className={`analysis-valid${compact ? ' analysis-valid--compact' : ''}`}
              title="WPC surface analysis valid time versus the radar frame on screen"
            >
              <strong>{formatWpcValidLabel(wpcFronts.valid)}</strong>
              {radarValidLabel ? (
                <span>
                  Radar {radarValidLabel}
                  {playing ? ' loop' : ''}
                </span>
              ) : null}
            </div>
          ) : null}
          {overlays.spc && spcOutlook.collection ? (
            <SpcOutlookLegend collection={spcOutlook.collection} compact={compact} />
          ) : null}
          {nexradEnabled ? (
            <NexradLegend
              meta={nexrad.sweep?.meta ?? l2Pair?.from.meta ?? null}
              stops={displayStops}
              paletteId={prefs.palette}
              product={prefs.product}
              hasHca={hcaReady}
            />
          ) : null}
        </div>
        <RadarCredits
          compact={compact}
          nexrad={nexradEnabled}
          rainViewer={!nexradEnabled}
          satellite={satelliteEnabled}
          basemapAttribution={basemapConfig.attribution}
        />
      </div>

      {!compact ? (
        <div className="radar-location panel panel--tight">
          <form className="radar-location__row row g-2 align-items-end" onSubmit={(event) => void onSubmitSearch(event)}>
            <label className="radar-field radar-field--search col-12 col-md" htmlFor="radar-search">
              <span className="form-label mb-1">Search</span>
              <LocationSearch
                ref={searchRef}
                id="radar-search"
                value={search}
                onChange={setSearch}
                bias={location}
                dropUp
                fill
                minChars={12}
                onSelect={(result) =>
                  applyLocation({
                    lat: result.lat,
                    lon: result.lon,
                    label: result.label,
                    zoom: result.zoom
                  })
                }
              />
            </label>
            <div className="col-6 col-md-auto">
              <button type="submit" className="btn btn-sm btn-ow-primary w-100" disabled={busy}>
                {busy ? 'Searching…' : 'Find & Pin'}
              </button>
            </div>
            <label className="radar-field col-6 col-md-auto" htmlFor="radar-lat">
              <span className="form-label mb-1">Lat</span>
              <AutosizeInput
                id="radar-lat"
                className="form-control form-control-sm"
                value={latInput}
                onChange={(event) => setLatInput(event.target.value)}
                minChars={8}
              />
            </label>
            <label className="radar-field col-6 col-md-auto" htmlFor="radar-lon">
              <span className="form-label mb-1">Lon</span>
              <AutosizeInput
                id="radar-lon"
                className="form-control form-control-sm"
                value={lonInput}
                onChange={(event) => setLonInput(event.target.value)}
                minChars={8}
              />
            </label>
            <div className="col-6 col-md-auto">
              <button
                type="button"
                className="btn btn-sm btn-ow-ghost w-100"
                onClick={() => onApplyCoordinates()}
              >
                Set pin
              </button>
            </div>
            {status ? (
              <p className="panel-muted mb-0 small radar-location__hint col-12">
                {status}
              </p>
            ) : null}
          </form>
        </div>
      ) : null}
    </div>
  )
}
