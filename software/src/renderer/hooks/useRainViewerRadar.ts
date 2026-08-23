import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  RAINVIEWER_API_URL,
  buildRadarTileUrl,
  type RainViewerFrame,
  type RainViewerMapsResponse
} from '@shared/rainviewer'

const REFRESH_MS = 5 * 60 * 1000
/** Playback step — long enough for tile prefetch + overlap dissolve. */
export const RADAR_FRAME_STEP_MS = 1400
/** Incoming fades up over a still-visible outgoing frame (no blank gap). */
export const RADAR_BLEND_MS = 650
/** Don't stall playback forever if a frame's tiles never finish. */
const FRAME_READY_WAIT_MS = 7000

function formatFrameDateTime(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric'
  })
}

function formatFrameClock(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit'
  })
}

const MIN_HEALTHY_FRAMES = 8

export function useRainViewerRadar(
  playing: boolean,
  options?: {
    isFrameReady?: (path: string) => boolean
  }
): {
  host: string | null
  frames: RainViewerFrame[]
  frameIndex: number
  setFrameIndex: (index: number) => void
  progress: number
  setProgress: (progress: number) => void
  currentTileUrl: string | null
  frameTimeLabel: string
  frameDateLabel: string
  loading: boolean
  incomplete: boolean
  error: string | null
  refresh: () => Promise<void>
} {
  const [host, setHost] = useState<string | null>(null)
  const [frames, setFrames] = useState<RainViewerFrame[]>([])
  const [frameIndex, setFrameIndexState] = useState(0)
  const [loading, setLoading] = useState(true)
  const [incomplete, setIncomplete] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const frameIndexRef = useRef(0)
  const framesRef = useRef<RainViewerFrame[]>([])
  const hostRef = useRef<string | null>(null)
  const retryTimerRef = useRef<number | null>(null)
  const retryCountRef = useRef(0)
  const isFrameReadyRef = useRef(options?.isFrameReady)
  isFrameReadyRef.current = options?.isFrameReady

  useEffect(() => {
    frameIndexRef.current = frameIndex
  }, [frameIndex])

  useEffect(() => {
    framesRef.current = frames
  }, [frames])

  useEffect(() => {
    hostRef.current = host
  }, [host])

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const response = await fetch(RAINVIEWER_API_URL)
      if (!response.ok) {
        throw new Error(`RainViewer HTTP ${response.status}`)
      }
      const data = (await response.json()) as RainViewerMapsResponse
      const past = (data.radar.past ?? []).map((frame) => ({
        ...frame,
        kind: 'observed' as const
      }))
      const nowcast = (data.radar.nowcast ?? []).map((frame) => ({
        ...frame,
        kind: 'nowcast' as const
      }))
      const nextFrames = [...past, ...nowcast]
      if (nextFrames.length === 0) {
        throw new Error('No radar frames available')
      }
      const missing = nextFrames.length < MIN_HEALTHY_FRAMES
      const sameCatalog =
        hostRef.current === data.host &&
        framesRef.current.length === nextFrames.length &&
        framesRef.current.every((frame, index) => frame.path === nextFrames[index]?.path)
      setHost(data.host)
      hostRef.current = data.host
      if (!sameCatalog) {
        const hadFrames = framesRef.current.length > 0
        const lastIndex = nextFrames.length - 1
        framesRef.current = nextFrames
        setFrames(nextFrames)
        const nextIndex = hadFrames
          ? Math.max(0, Math.min(lastIndex, frameIndexRef.current))
          : lastIndex
        frameIndexRef.current = nextIndex
        setFrameIndexState(nextIndex)
      }
      setIncomplete(missing)
      setError(null)
      if (missing && retryCountRef.current < 2) {
        retryCountRef.current += 1
        if (retryTimerRef.current !== null) window.clearTimeout(retryTimerRef.current)
        retryTimerRef.current = window.setTimeout(() => {
          retryTimerRef.current = null
          void refresh()
        }, 6000)
      } else if (!missing) {
        retryCountRef.current = 0
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load radar'
      setError(message)
      setIncomplete(true)
      if (retryCountRef.current < 2) {
        retryCountRef.current += 1
        if (retryTimerRef.current !== null) window.clearTimeout(retryTimerRef.current)
        retryTimerRef.current = window.setTimeout(() => {
          retryTimerRef.current = null
          void refresh()
        }, 6000)
      }
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
    const timer = window.setInterval(() => {
      retryCountRef.current = 0
      void refresh()
    }, REFRESH_MS)
    return () => {
      window.clearInterval(timer)
      if (retryTimerRef.current !== null) window.clearTimeout(retryTimerRef.current)
    }
  }, [refresh])

  const setFrameIndex = useCallback((index: number) => {
    const current = framesRef.current
    if (current.length === 0) return
    const clamped = Math.max(0, Math.min(current.length - 1, Math.round(index)))
    frameIndexRef.current = clamped
    setFrameIndexState(clamped)
  }, [])

  const setProgress = useCallback((progress: number) => {
    const current = framesRef.current
    if (current.length === 0) return
    const clamped = Math.max(0, Math.min(1, progress))
    const index = Math.round(clamped * (current.length - 1))
    frameIndexRef.current = index
    setFrameIndexState(index)
  }, [])

  useEffect(() => {
    if (!playing || frames.length < 2) return
    let timer: number | null = null
    let waitingSince: number | null = null

    const step = (): void => {
      const list = framesRef.current
      if (list.length < 2) return
      const next = (frameIndexRef.current + 1) % list.length
      const frame = list[next]
      const readyFn = isFrameReadyRef.current
      const ready =
        !frame ||
        !frame.path ||
        !readyFn ||
        readyFn(frame.path)
      if (!ready) {
        if (waitingSince == null) waitingSince = Date.now()
        if (Date.now() - waitingSince < FRAME_READY_WAIT_MS) {
          timer = window.setTimeout(step, 200)
          return
        }
      }
      waitingSince = null
      frameIndexRef.current = next
      setFrameIndexState(next)
      timer = window.setTimeout(step, RADAR_FRAME_STEP_MS)
    }

    timer = window.setTimeout(step, RADAR_FRAME_STEP_MS)
    return () => {
      if (timer !== null) window.clearTimeout(timer)
    }
  }, [playing, frames.length])

  useEffect(() => {
    if (frames.length === 0) return
    if (frameIndexRef.current <= frames.length - 1) return
    const next = frames.length - 1
    frameIndexRef.current = next
    setFrameIndexState(next)
  }, [frames.length])

  const currentTileUrl = useMemo(() => {
    if (!host || frames.length === 0) return null
    const frame = frames[frameIndex] ?? frames[frames.length - 1]
    if (!frame || !frame.path) return null
    return buildRadarTileUrl(host, frame.path)
  }, [host, frames, frameIndex])

  const frame = frames[frameIndex]
  const frameTimeLabel = frame ? formatFrameClock(frame.time) : '—'
  const frameDateLabel = frame ? formatFrameDateTime(frame.time) : '—'
  const progress = frames.length <= 1 ? 0 : frameIndex / (frames.length - 1)

  return {
    host,
    frames,
    frameIndex,
    setFrameIndex,
    progress,
    setProgress,
    currentTileUrl,
    frameTimeLabel,
    frameDateLabel,
    loading,
    incomplete,
    error,
    refresh
  }
}
