import { useEffect, useRef, type MutableRefObject } from 'react'
import { useMap } from 'react-leaflet'
import type { NexradSweepPayload, PaletteStop } from '@shared/nexrad'
import type { NexradCompositeFrame } from '../../lib/nexradComposite'
import { NEXRAD_GL_REV, NexradGlLayer } from './NexradGlLayer'

export function NexradLevel2Overlay({
  frames,
  siteFrames,
  composite,
  playing,
  progress,
  playheadRef,
  opacity,
  paletteStops,
  thresholdBias,
  cohesion,
  preferGrid = false,
  drift = true,
  classMode = false
}: {
  frames: NexradSweepPayload[]
  siteFrames?: NexradSweepPayload[][]
  composite?: NexradCompositeFrame[]
  playing: boolean
  progress: number
  playheadRef: MutableRefObject<number>
  opacity: number
  paletteStops?: PaletteStop[]
  thresholdBias?: number
  cohesion?: number
  preferGrid?: boolean
  drift?: boolean
  classMode?: boolean
}): null {
  const map = useMap()
  const layerRef = useRef<NexradGlLayer | null>(null)
  const playhead = useRef(playheadRef)
  playhead.current = playheadRef

  useEffect(() => {
    const layer = new NexradGlLayer()
    layer.onContextDead = null
    layer.addTo(map)
    layer.setProgress(playhead.current.current)
    layerRef.current = layer
    return () => {
      layer.onContextDead = null
      layer.remove()
      layerRef.current = null
    }
  }, [map, NEXRAD_GL_REV])

  useEffect(() => {
    layerRef.current?.setFrames(frames)
  }, [frames])

  useEffect(() => {
    layerRef.current?.setSiteLayers(siteFrames && siteFrames.length > 0 ? siteFrames : [frames])
  }, [frames, siteFrames])

  useEffect(() => {
    layerRef.current?.setCompositeFrames(composite ?? [])
  }, [composite])

  useEffect(() => {
    layerRef.current?.setOpacity(opacity)
  }, [opacity])

  useEffect(() => {
    if (paletteStops) layerRef.current?.setPalette(paletteStops)
  }, [paletteStops])

  useEffect(() => {
    if (thresholdBias != null) layerRef.current?.setThresholdBias(thresholdBias)
  }, [thresholdBias])

  useEffect(() => {
    if (cohesion != null) layerRef.current?.setCohesion(cohesion)
  }, [cohesion])

  useEffect(() => {
    layerRef.current?.setPreferGrid(preferGrid)
  }, [preferGrid])

  useEffect(() => {
    layerRef.current?.setDriftEnabled(drift)
  }, [drift])

  useEffect(() => {
    layerRef.current?.setClassMode(classMode)
  }, [classMode])

  useEffect(() => {
    if (playing) return
    layerRef.current?.setProgress(progress)
  }, [playing, progress])

  useEffect(() => {
    if (!playing) return
    let raf = 0
    let last = 0
    const tick = (now: number): void => {
      raf = requestAnimationFrame(tick)
      if (now - last < (drift ? 50 : 120)) return
      last = now
      layerRef.current?.setProgress(playhead.current.current)
    }
    raf = requestAnimationFrame(tick)
    return () => window.cancelAnimationFrame(raf)
  }, [playing, drift])

  return null
}
