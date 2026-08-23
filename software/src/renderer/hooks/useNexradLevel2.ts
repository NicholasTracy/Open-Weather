import { useCallback, useEffect, useRef, useState } from 'react'
import {
  NEXRAD_LOOP_FRAMES,
  NEXRAD_MIN_KEYFRAME_SEC,
  nearestVolumeRef,
  rollKeyframeTimes,
  selectKeyframeTimes,
  uniqueVolumeRefs,
  type NexradSite,
  type NexradSweepPayload,
  type NexradVolumeRef
} from '@shared/nexrad'
import {
  COMPOSITE_LOOP_GRID,
  buildCompositeLoop,
  type NexradCompositeFrame
} from '../lib/nexradComposite'
import { attachMosaicDrift } from '../lib/nexradAdvection'
import { finalizeSweeps } from '../lib/nexradClutter'
import { prefetchBlockageMaps } from '../lib/nexradBlockage'
import { fetchMeltingLayer } from '../lib/nexradHca'

const FETCH_SHARE = 0.78
const PROCESS_SHARE = 0.22

export type NexradLayer = {
  site: NexradSite
  frames: NexradSweepPayload[]
}

export type NexradRefreshMode = 'full' | 'background'

function insertSorted(
  frames: NexradSweepPayload[],
  sweep: NexradSweepPayload
): NexradSweepPayload[] {
  if (frames.some((frame) => frame.meta.key === sweep.meta.key)) return frames
  return [...frames, sweep].sort((a, b) => a.meta.timeUnix - b.meta.timeUnix)
}

function upsertLayer(
  layers: NexradLayer[],
  site: NexradSite,
  sweep: NexradSweepPayload
): NexradLayer[] {
  const index = layers.findIndex((layer) => layer.site.id === site.id)
  if (index < 0) return [...layers, { site, frames: [sweep] }]
  return layers.map((layer, i) =>
    i === index ? { site, frames: insertSorted(layer.frames, sweep) } : layer
  )
}

function cloneLayers(layers: NexradLayer[]): NexradLayer[] {
  return layers.map((layer) => ({ site: layer.site, frames: [...layer.frames] }))
}

function yieldUi(): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, 0)
  })
}

function nearestSweepAt(
  frames: NexradSweepPayload[],
  timeUnix: number
): NexradSweepPayload | null {
  let best: NexradSweepPayload | null = null
  let bestDt = Infinity
  for (const frame of frames) {
    const dt = Math.abs(frame.meta.timeUnix - timeUnix)
    if (dt < bestDt) {
      best = frame
      bestDt = dt
    }
  }
  return best
}

function keepTimelineFrames(
  frames: NexradSweepPayload[],
  times: number[]
): NexradSweepPayload[] {
  const keep = new Set<string>()
  const out: NexradSweepPayload[] = []
  for (const time of times) {
    const sweep = nearestSweepAt(frames, time)
    if (!sweep || keep.has(sweep.meta.key)) continue
    keep.add(sweep.meta.key)
    out.push(sweep)
  }
  return out.sort((a, b) => a.meta.timeUnix - b.meta.timeUnix)
}

const FETCH_WORKERS = 4

function collectFetchJobs(
  catalogs: { site: NexradSite; refs: NexradVolumeRef[] }[],
  timeline: number[],
  have: Set<string>
): { site: NexradSite; key: string; timeUnix: number }[] {
  const jobs: { site: NexradSite; key: string; timeUnix: number }[] = []
  const seen = new Set<string>()
  for (const { site, refs } of catalogs) {
    for (const time of timeline) {
      const ref = nearestVolumeRef(refs, time)
      if (!ref || have.has(ref.key)) continue
      const id = `${site.id}:${ref.key}`
      if (seen.has(id)) continue
      seen.add(id)
      jobs.push({ site, key: ref.key, timeUnix: ref.timeUnix })
    }
  }
  return jobs.sort((a, b) => b.timeUnix - a.timeUnix)
}

export function useNexradLevel2(
  sites: NexradSite[],
  enabled: boolean,
  loopFrames = NEXRAD_LOOP_FRAMES
): {
  layers: NexradLayer[]
  frames: NexradSweepPayload[]
  composite: NexradCompositeFrame[]
  sweep: NexradSweepPayload | null
  loading: boolean
  ready: boolean
  progress: number
  loaded: number
  total: number
  error: string | null
  refresh: (mode?: NexradRefreshMode) => Promise<void>
} {
  const [layers, setLayers] = useState<NexradLayer[]>([])
  const [composite, setComposite] = useState<NexradCompositeFrame[]>([])
  const [loading, setLoading] = useState(false)
  const [loaded, setLoaded] = useState(0)
  const [total, setTotal] = useState(0)
  const [progress, setProgress] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const sitesRef = useRef(sites)
  const enabledRef = useRef(enabled)
  const loopFramesRef = useRef(loopFrames)
  const layersRef = useRef(layers)
  const compositeRef = useRef(composite)
  const requestRef = useRef(0)

  useEffect(() => {
    sitesRef.current = sites
  }, [sites])
  useEffect(() => {
    enabledRef.current = enabled
  }, [enabled])
  useEffect(() => {
    loopFramesRef.current = loopFrames
  }, [loopFrames])
  useEffect(() => {
    layersRef.current = layers
  }, [layers])
  useEffect(() => {
    compositeRef.current = composite
  }, [composite])

  const refresh = useCallback(async (mode: NexradRefreshMode = 'full'): Promise<void> => {
    const wanted = sitesRef.current
    if (!enabledRef.current || wanted.length === 0 || !window.desktop?.fetchNexradSweep) {
      setLayers([])
      setComposite([])
      setLoading(false)
      setLoaded(0)
      setTotal(0)
      setProgress(0)
      return
    }
    const requestId = (requestRef.current += 1)
    const foreground = mode === 'full'
    if (foreground) {
      setLayers([])
      setComposite([])
      setLoading(true)
      setLoaded(0)
      setTotal(0)
      setProgress(0.03)
      setError(null)
    }
    try {
      const catalogs = await Promise.all(
        wanted.map(async (site) => {
          const catalog = window.desktop?.fetchNexradCatalog
            ? await window.desktop.fetchNexradCatalog(site.id)
            : []
          return { site, refs: uniqueVolumeRefs(catalog) }
        })
      )
      if (requestRef.current !== requestId) return

      const catalogTimes = (catalogs[0]?.refs ?? []).map((ref) => ref.timeUnix)
      const currentTimes =
        compositeRef.current.length > 0
          ? compositeRef.current.map((frame) => frame.timeUnix)
          : (layersRef.current[0]?.frames.map((frame) => frame.meta.timeUnix) ?? [])
      const timeline = foreground
        ? selectKeyframeTimes(catalogTimes, loopFramesRef.current, NEXRAD_MIN_KEYFRAME_SEC)
        : rollKeyframeTimes(
            currentTimes,
            catalogTimes,
            loopFramesRef.current,
            NEXRAD_MIN_KEYFRAME_SEC
          )
      if (timeline.length === 0) {
        if (foreground) {
          setLayers([])
          setComposite([])
          setError('No Level II volumes decoded')
          setProgress(1)
          setLoading(false)
        }
        return
      }

      const have = new Set(
        foreground
          ? []
          : layersRef.current.flatMap((layer) => layer.frames.map((frame) => frame.meta.key))
      )
      const jobs = collectFetchJobs(catalogs, timeline, have)
      if (!foreground && jobs.length === 0) return
      await prefetchBlockageMaps(wanted)
      const meltingLayer = await fetchMeltingLayer(wanted[0]!.lat, wanted[0]!.lon)

      if (foreground) {
        setTotal(Math.max(1, jobs.length))
        setLoaded(0)
        setProgress(0.04)
      }

      const acc = foreground
        ? ([] as NexradLayer[])
        : cloneLayers(layersRef.current)
      const remainingBySite = new Map<string, number>()
      for (const job of jobs) {
        remainingBySite.set(job.site.id, (remainingBySite.get(job.site.id) ?? 0) + 1)
      }
      const qcBySite = new Map<string, Promise<NexradSweepPayload[]>>()
      const startSiteQc = (siteId: string) => {
        if (qcBySite.has(siteId)) return
        const layer = acc.find((item) => item.site.id === siteId)
        if (!layer) return
        const frames = layer.frames
        qcBySite.set(siteId, Promise.resolve().then(() => finalizeSweeps(frames, meltingLayer)))
      }
      let fetched = 0
      let cursor = 0
      const workers = Math.min(FETCH_WORKERS, Math.max(1, jobs.length))
      await Promise.all(
        Array.from({ length: workers }, async () => {
          while (cursor < jobs.length) {
            const index = cursor
            cursor += 1
            const job = jobs[index]
            if (!job || requestRef.current !== requestId) return
            try {
              const sweep = await window.desktop!.fetchNexradSweep(job.site.id, job.key)
              if (requestRef.current !== requestId) return
              acc.splice(0, acc.length, ...upsertLayer(acc, job.site, sweep))
            } catch {
              /* keep frames that already loaded */
            }
            const left = (remainingBySite.get(job.site.id) ?? 1) - 1
            remainingBySite.set(job.site.id, left)
            if (left === 0) startSiteQc(job.site.id)
            fetched += 1
            if (requestRef.current === requestId && foreground) {
              setLoaded(fetched)
              setProgress((fetched / Math.max(1, jobs.length)) * FETCH_SHARE)
            }
          }
        })
      )
      if (requestRef.current !== requestId) return

      for (const layer of acc) startSiteQc(layer.site.id)
      if (foreground) setProgress(FETCH_SHARE + PROCESS_SHARE * 0.15)
      const finished = await Promise.all(
        acc.map(async (layer) => ({
          site: layer.site,
          frames: (await qcBySite.get(layer.site.id)) ?? layer.frames
        }))
      )
      if (foreground) {
        setProgress(FETCH_SHARE + PROCESS_SHARE * 0.7)
        await yieldUi()
      }
      if (requestRef.current !== requestId) return

      const ordered = wanted
        .map((site) => finished.find((layer) => layer.site.id === site.id))
        .filter((layer): layer is NexradLayer => layer != null && layer.frames.length > 0)
        .map((layer) => ({
          ...layer,
          frames: keepTimelineFrames(layer.frames, timeline)
        }))
        .filter((layer) => layer.frames.length > 0)

      let mosaic: NexradCompositeFrame[] = []
      if (ordered.length >= 1) {
        if (foreground) setProgress(0.94)
        const kept = foreground
          ? []
          : compositeRef.current.filter((frame) => timeline.includes(frame.timeUnix))
        const missing = timeline.filter((time) => !kept.some((frame) => frame.timeUnix === time))
        const extra =
          missing.length > 0
            ? await buildCompositeLoop(
                ordered.map((layer) => ({ frames: layer.frames })),
                missing,
                () => requestRef.current !== requestId,
                { maxGrid: COMPOSITE_LOOP_GRID }
              )
            : []
        mosaic = [...kept, ...extra].sort((a, b) => a.timeUnix - b.timeUnix)
        if (mosaic.length >= 2) {
          mosaic = await attachMosaicDrift(mosaic)
        }
      }
      if (requestRef.current !== requestId) return

      if (ordered.length === 0) {
        setLayers([])
        setComposite([])
        setError('No Level II volumes decoded')
        setProgress(1)
        setLoading(false)
        return
      }

      setLayers(ordered)
      setComposite(mosaic)
      if (foreground) {
        setLoaded(jobs.length)
        setProgress(1)
        setLoading(false)
      }
    } catch (err) {
      if (requestRef.current !== requestId) return
      setError(err instanceof Error ? err.message : 'Failed to load NEXRAD')
      setLoading(false)
      setProgress(1)
    }
  }, [])

  const siteKey = sites.map((site) => site.id).join(',')

  useEffect(() => {
    if (!enabled || sites.length === 0) {
      setLayers([])
      setComposite([])
      setError(null)
      setLoading(false)
      setLoaded(0)
      setTotal(0)
      setProgress(0)
      return
    }
    void prefetchBlockageMaps(sites)
    void refresh('full')
    return undefined
  }, [enabled, siteKey, refresh, sites.length, loopFrames])

  const ordered = sites
    .map((site) => layers.find((layer) => layer.site.id === site.id))
    .filter((layer): layer is NexradLayer => layer != null)
  const primary = ordered[0]?.frames ?? []
  const ready = !loading && (!enabled || sites.length === 0 || primary.length > 0 || Boolean(error))

  return {
    layers: ordered,
    frames: primary,
    composite,
    sweep: primary[primary.length - 1] ?? layers.find((layer) => layer.frames.length > 0)?.frames.at(-1) ?? null,
    loading,
    ready,
    progress,
    loaded,
    total,
    error,
    refresh
  }
}
