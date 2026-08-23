import L from 'leaflet'
import { buildRadarTileUrlAt, type RainViewerFrame } from '@shared/rainviewer'
import { RADAR_BLEND_MS } from '../../hooks/useRainViewerRadar'

export type RadarTileStatus = {
  loaded: number
  total: number
  failed: number
  ready: boolean
  readyFrames: number
  totalFrames: number
  readyPaths: string[]
}

type TileRec = {
  el: HTMLCanvasElement
  coords: L.Coords
}

type InternalGrid = {
  _tiles?: Record<string, TileRec>
}

const EMPTY_PIXEL =
  'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw=='

function easeSmooth(t: number): number {
  return t * t * (3 - 2 * t)
}

function transparentImage(): HTMLImageElement {
  const img = new Image()
  img.src = EMPTY_PIXEL
  return img
}

const EMPTY_IMG = transparentImage()

const FETCH_LIMIT = 8
let fetchActive = 0
const fetchWaiters: Array<() => void> = []

async function acquireFetchSlot(): Promise<void> {
  if (fetchActive >= FETCH_LIMIT) {
    await new Promise<void>((resolve) => fetchWaiters.push(resolve))
  }
  fetchActive += 1
}

function releaseFetchSlot(): void {
  fetchActive = Math.max(0, fetchActive - 1)
  const next = fetchWaiters.shift()
  if (next) next()
}

/**
 * Single visible radar layer. Frames are fetched as same-origin blobs, then
 * crossfaded in pixel space so transparent precip neither dips nor doubles.
 */
export class RadarBlendLayer extends L.GridLayer {
  private host: string | null = null
  private frames: RainViewerFrame[] = []
  private fromIndex = 0
  private toIndex = 0
  private blendT = 1
  private animStart = 0
  private raf: number | null = null
  private images = new Map<string, HTMLImageElement>()
  private pixels = new Map<string, ImageData>()
  private inflight = new Map<string, Promise<HTMLImageElement>>()
  private blobUrls: string[] = []
  private onStatus: ((status: RadarTileStatus) => void) | null = null
  private scratch: HTMLCanvasElement | null = null
  private lastPaintAt = 0

  constructor(options?: L.GridLayerOptions) {
    super({
      tileSize: 256,
      maxZoom: 12,
      maxNativeZoom: 7,
      keepBuffer: 4,
      updateWhenIdle: false,
      updateWhenZooming: true,
      className: 'radar-tile-layer',
      pane: 'owRadar',
      ...options
    })
  }

  setStatusHandler(handler: ((status: RadarTileStatus) => void) | null): void {
    this.onStatus = handler
  }

  setCatalog(host: string | null, frames: RainViewerFrame[]): void {
    const same =
      this.host === host &&
      this.frames.length === frames.length &&
      this.frames.every((frame, i) => frame.path === frames[i]?.path)
    if (same) return
    this.host = host
    this.frames = frames
    this.clearImageCache()
    this.fromIndex = 0
    this.toIndex = 0
    this.blendT = 1
    this.stopAnim()
    this.redraw()
    this.prefetchVisible()
    this.emitStatus()
  }

  setFrame(index: number, animate: boolean): void {
    if (this.frames.length === 0) return
    const next = Math.max(0, Math.min(this.frames.length - 1, index))
    if (!animate) {
      this.fromIndex = next
      this.toIndex = next
      this.blendT = 1
      this.stopAnim()
      this.paintVisible()
      this.prefetchVisible()
      this.emitStatus()
      return
    }
    if (next === this.toIndex && this.blendT >= 1) return
    if (this.raf !== null && this.blendT < 1) {
      this.fromIndex = this.blendT >= 0.5 ? this.toIndex : this.fromIndex
    } else {
      this.fromIndex = this.toIndex
    }
    this.toIndex = next
    if (this.fromIndex === this.toIndex) {
      this.blendT = 1
      this.stopAnim()
      this.paintVisible()
      return
    }
    this.blendT = 0
    this.animStart = performance.now()
    this.kickAnim()
  }

  onAdd(map: L.Map): this {
    super.onAdd(map)
    map.on('moveend zoomend', this.onViewChange, this)
    return this
  }

  onRemove(map: L.Map): this {
    map.off('moveend zoomend', this.onViewChange, this)
    this.stopAnim()
    super.onRemove(map)
    this.clearImageCache()
    return this
  }

  createTile(coords: L.Coords, done: L.DoneCallback): HTMLCanvasElement {
    const canvas = L.DomUtil.create('canvas', 'leaflet-tile') as HTMLCanvasElement
    const size = this.getTileSize()
    canvas.width = size.x
    canvas.height = size.y
    void this.paintCanvas(canvas, coords)
      .then(() => {
        done(undefined, canvas)
        void this.prefetchCoords(coords)
        this.emitStatus()
      })
      .catch((err: unknown) => {
        done(err instanceof Error ? err : new Error('Radar tile failed'), canvas)
      })
    return canvas
  }

  private onViewChange = (): void => {
    this.prefetchVisible()
    this.emitStatus()
  }

  private kickAnim(): void {
    if (this.raf !== null) return
    const tick = (now: number): void => {
      this.raf = null
      const elapsed = now - this.animStart
      const raw = Math.min(1, elapsed / RADAR_BLEND_MS)
      this.blendT = easeSmooth(raw)
      if (now - this.lastPaintAt >= 20) {
        this.paintVisible()
        this.lastPaintAt = now
      }
      if (raw < 1) {
        this.raf = requestAnimationFrame(tick)
        return
      }
      this.blendT = 1
      this.fromIndex = this.toIndex
      this.paintVisible()
      this.emitStatus()
    }
    this.raf = requestAnimationFrame(tick)
  }

  private stopAnim(): void {
    if (this.raf === null) return
    cancelAnimationFrame(this.raf)
    this.raf = null
  }

  private tileRecords(): TileRec[] {
    const tiles = (this as unknown as InternalGrid)._tiles
    if (!tiles) return []
    return Object.values(tiles).filter((tile): tile is TileRec => Boolean(tile?.el && tile.coords))
  }

  private paintVisible(): void {
    for (const tile of this.tileRecords()) {
      void this.paintCanvas(tile.el, tile.coords)
    }
  }

  private async paintCanvas(canvas: HTMLCanvasElement, coords: L.Coords): Promise<void> {
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx || !this.host || this.frames.length === 0) return
    const w = canvas.width
    const h = canvas.height
    const from = this.frames[this.fromIndex]
    const to = this.frames[this.toIndex]
    const t = this.blendT
    const imgA = from ? await this.ensureImage(this.urlFor(from, coords)) : null
    const imgB = to && (t > 0.001 || to !== from) ? await this.ensureImage(this.urlFor(to, coords)) : null

    if (!imgA && !imgB) {
      ctx.clearRect(0, 0, w, h)
      return
    }
    if (!imgB || t <= 0.001 || from === to) {
      ctx.clearRect(0, 0, w, h)
      if (imgA) ctx.drawImage(imgA, 0, 0, w, h)
      return
    }
    if (!imgA || t >= 0.999) {
      ctx.clearRect(0, 0, w, h)
      ctx.drawImage(imgB, 0, 0, w, h)
      return
    }

    const dataA = this.decode(imgA, w, h)
    const dataB = this.decode(imgB, w, h)
    const out = ctx.createImageData(w, h)
    const a = dataA.data
    const b = dataB.data
    const o = out.data
    const inv = 1 - t
    for (let i = 0; i < o.length; i += 4) {
      o[i] = a[i] * inv + b[i] * t
      o[i + 1] = a[i + 1] * inv + b[i + 1] * t
      o[i + 2] = a[i + 2] * inv + b[i + 2] * t
      o[i + 3] = a[i + 3] * inv + b[i + 3] * t
    }
    ctx.putImageData(out, 0, 0)
  }

  private decode(img: HTMLImageElement, w: number, h: number): ImageData {
    const key = `${img.src}|${w}x${h}`
    const hit = this.pixels.get(key)
    if (hit) return hit
    const scratch = this.getScratch(w, h)
    scratch.clearRect(0, 0, w, h)
    scratch.drawImage(img, 0, 0, w, h)
    const data = scratch.getImageData(0, 0, w, h)
    this.pixels.set(key, data)
    return data
  }

  private getScratch(w: number, h: number): CanvasRenderingContext2D {
    if (!this.scratch) this.scratch = document.createElement('canvas')
    if (this.scratch.width !== w) this.scratch.width = w
    if (this.scratch.height !== h) this.scratch.height = h
    const ctx = this.scratch.getContext('2d', { willReadFrequently: true })
    if (!ctx) throw new Error('Radar scratch canvas unavailable')
    return ctx
  }

  private urlFor(frame: RainViewerFrame, coords: L.Coords): string {
    if (!frame.path) return ''
    return buildRadarTileUrlAt(this.host ?? '', frame.path, coords.z, coords.x, coords.y)
  }

  private prefetchVisible(): void {
    for (const tile of this.tileRecords()) {
      void this.prefetchCoords(tile.coords)
    }
  }

  private async prefetchCoords(coords: L.Coords): Promise<void> {
    if (!this.host) return
    await Promise.all(
      this.frames
        .filter((frame) => Boolean(frame.path))
        .map((frame) => this.ensureImage(this.urlFor(frame, coords)))
    )
    this.emitStatus()
  }

  private async ensureImage(url: string): Promise<HTMLImageElement> {
    const cached = this.images.get(url)
    if (cached) return cached
    const pending = this.inflight.get(url)
    if (pending) return pending

    const task = (async () => {
      if (!url) {
        this.images.set(url, EMPTY_IMG)
        return EMPTY_IMG
      }
      await acquireFetchSlot()
      try {
        const response = await fetch(url)
        if (!response.ok) {
          this.images.set(url, EMPTY_IMG)
          return EMPTY_IMG
        }
        const blob = await response.blob()
        if (blob.size < 32) {
          this.images.set(url, EMPTY_IMG)
          return EMPTY_IMG
        }
        const objectUrl = URL.createObjectURL(blob)
        this.blobUrls.push(objectUrl)
        const img = new Image()
        await new Promise<void>((resolve, reject) => {
          img.onload = () => resolve()
          img.onerror = () => reject(new Error('Radar image decode failed'))
          img.src = objectUrl
        })
        this.images.set(url, img)
        return img
      } catch {
        this.images.set(url, EMPTY_IMG)
        return EMPTY_IMG
      } finally {
        releaseFetchSlot()
        this.inflight.delete(url)
      }
    })()

    this.inflight.set(url, task)
    return task
  }

  private emitStatus(): void {
    if (!this.onStatus) return
    const coords = this.tileRecords().map((tile) => tile.coords)
    const paintable = this.frames.filter((frame) => Boolean(frame.path))
    const totalFrames = paintable.length
    const readyPaths: string[] = []
    if (coords.length > 0 && this.host) {
      for (const frame of paintable) {
        const ready = coords.every((coord) => this.images.has(this.urlFor(frame, coord)))
        if (ready) readyPaths.push(frame.path)
      }
    }
    this.onStatus({
      loaded: readyPaths.length,
      total: totalFrames,
      failed: 0,
      ready: totalFrames > 0 && readyPaths.length >= totalFrames,
      readyFrames: readyPaths.length,
      totalFrames,
      readyPaths
    })
  }

  private clearImageCache(): void {
    for (const url of this.blobUrls) URL.revokeObjectURL(url)
    this.blobUrls = []
    this.images.clear()
    this.pixels.clear()
    this.inflight.clear()
  }
}
