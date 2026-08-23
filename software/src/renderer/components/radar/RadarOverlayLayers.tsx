import { useEffect, useRef } from 'react'
import { useMap } from 'react-leaflet'
import type { RainViewerFrame } from '@shared/rainviewer'
import { RadarBlendLayer, type RadarTileStatus } from './radarBlendLayer'

export type { RadarTileStatus }

type RadarOverlayLayersProps = {
  host: string | null
  frames: RainViewerFrame[]
  frameIndex: number
  opacity: number
  onStatus?: (status: RadarTileStatus) => void
}

/**
 * One composited radar layer. Frame changes crossfade in pixel space so
 * transparent precip does not flash bright or dip to the basemap.
 */
export function RadarOverlayLayers({
  host,
  frames,
  frameIndex,
  opacity,
  onStatus
}: RadarOverlayLayersProps): null {
  const map = useMap()
  const layerRef = useRef<RadarBlendLayer | null>(null)
  const onStatusRef = useRef(onStatus)
  const primedRef = useRef(false)

  useEffect(() => {
    onStatusRef.current = onStatus
  }, [onStatus])

  useEffect(() => {
    const layer = new RadarBlendLayer({ opacity, pane: 'owRadar' })
    layer.setStatusHandler((status) => onStatusRef.current?.(status))
    layer.addTo(map)
    layerRef.current = layer
    primedRef.current = false
    return () => {
      layer.setStatusHandler(null)
      layer.remove()
      layerRef.current = null
    }
  }, [map])

  useEffect(() => {
    layerRef.current?.setOpacity(opacity)
  }, [opacity])

  useEffect(() => {
    primedRef.current = false
    layerRef.current?.setCatalog(host, frames)
  }, [host, frames])

  useEffect(() => {
    const layer = layerRef.current
    if (!layer) return
    const animate = primedRef.current
    primedRef.current = true
    layer.setFrame(frameIndex, animate)
  }, [frameIndex, host, frames])

  return null
}
