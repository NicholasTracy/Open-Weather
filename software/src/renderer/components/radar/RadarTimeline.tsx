import { nexradLoopPositionByTimes, progressForFrameIndex } from '@shared/nexrad'
import { useEffect, useRef, type MutableRefObject, type PointerEvent as ReactPointerEvent, type ReactElement } from 'react'
type TimelineFrame = {
  time: number
  kind?: string
}

type RadarTimelineProps = {
  frames: TimelineFrame[]
  frameIndex: number
  progress: number
  frameDateLabel: string
  frameTimeLabel: string
  disabled?: boolean
  compact?: boolean
  playing?: boolean
  continuous?: boolean
  progressRef?: MutableRefObject<number>
  onSeek: (progress: number) => void
  onTogglePlay?: () => void
  onStep?: (delta: number) => void
}

function formatTick(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit'
  })
}

function formatDay(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric'
  })
}

export function RadarTimeline({
  frames,
  frameIndex,
  progress,
  frameDateLabel,
  frameTimeLabel,
  disabled = false,
  compact = false,
  playing = false,
  continuous = false,
  progressRef,
  onSeek,
  onTogglePlay,
  onStep
}: RadarTimelineProps): ReactElement {
  const trackRef = useRef<HTMLDivElement>(null)
  const fillRef = useRef<HTMLDivElement>(null)
  const detentRef = useRef<HTMLSpanElement>(null)
  const indexRef = useRef<HTMLSpanElement>(null)
  const timeRef = useRef<HTMLSpanElement>(null)
  const marksRef = useRef<Array<HTMLSpanElement | null>>([])
  const framesRef = useRef(frames)
  framesRef.current = frames

  useEffect(() => {
    if (!continuous || !playing || !progressRef) return
    let raf = 0
    const tick = (): void => {
      raf = requestAnimationFrame(tick)
      const list = framesRef.current
      const p = Math.max(0, Math.min(1, progressRef.current))
      const pct = `${(p * 100).toFixed(3)}%`
      if (fillRef.current) fillRef.current.style.width = pct
      if (detentRef.current) detentRef.current.style.left = pct
      if (list.length === 0) return
      const pos = nexradLoopPositionByTimes(
        list.map((frame) => frame.time),
        p
      )
      if (indexRef.current) indexRef.current.textContent = `${pos.index + 1}/${list.length}`
      const frame = list[pos.index]
      if (timeRef.current && frame) timeRef.current.textContent = formatTick(frame.time)
      marksRef.current.forEach((mark, index) => {
        mark?.classList.toggle('is-active', index === pos.index)
      })
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [continuous, playing, progressRef])

  const headProgress = progress

  const seekFromClientX = (clientX: number): void => {
    const track = trackRef.current
    if (!track || frames.length === 0) return
    const rect = track.getBoundingClientRect()
    const ratio = Math.max(0, Math.min(1, rect.width <= 0 ? 0 : (clientX - rect.left) / rect.width))
    if (continuous || frames.length <= 1) {
      onSeek(ratio)
      return
    }
    const index = Math.round(ratio * (frames.length - 1))
    onSeek(index / (frames.length - 1))
  }

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (disabled || frames.length === 0) return
    event.stopPropagation()
    event.currentTarget.setPointerCapture(event.pointerId)
    seekFromClientX(event.clientX)
  }

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (disabled || !event.currentTarget.hasPointerCapture(event.pointerId)) return
    event.stopPropagation()
    seekFromClientX(event.clientX)
  }

  const currentFrame = frames[frameIndex]
  const first = frames[0]
  const last = frames[frames.length - 1]
  const times = frames.map((frame) => frame.time)
  const span = first && last ? last.time - first.time : 0
  const displayIndex =
    continuous && frames.length > 0
      ? nexradLoopPositionByTimes(times, headProgress).index
      : frameIndex
  const snappedProgress =
    frames.length <= 1 ? 0 : progressForFrameIndex(times, displayIndex)
  const playhead = frames.length > 0 ? (continuous ? headProgress : snappedProgress) : headProgress
  const detentPercent = `${Math.max(0, Math.min(100, playhead * 100))}%`

  const shownFrame = frames[displayIndex] ?? currentFrame
  const currentTime = shownFrame ? formatTick(shownFrame.time) : frameTimeLabel
  const currentDay = shownFrame ? formatDay(shownFrame.time) : frameDateLabel
  const startTime = first ? formatTick(first.time) : '—'
  const endTime = last ? formatTick(last.time) : '—'

  return (
    <div
      className={`radar-timeline${compact ? ' radar-timeline--compact' : ''}${
        disabled ? ' is-disabled' : ''
      }`.trim()}
      onPointerDown={(event) => event.stopPropagation()}
    >
      {onTogglePlay ? (
        <button
          type="button"
          className="radar-timeline__play"
          onClick={onTogglePlay}
          disabled={disabled}
          aria-label={playing ? 'Pause radar' : 'Play radar'}
          title={playing ? 'Pause' : 'Play'}
        >
          {playing ? (
            <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
              <rect x="3" y="2.5" width="2.6" height="9" rx="0.7" fill="currentColor" />
              <rect x="8.4" y="2.5" width="2.6" height="9" rx="0.7" fill="currentColor" />
            </svg>
          ) : (
            <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
              <path d="M4.2 2.4v9.2L12 7 4.2 2.4Z" fill="currentColor" />
            </svg>
          )}
        </button>
      ) : null}

      {!compact && onStep ? (
        <button
          type="button"
          className="radar-timeline__step"
          onClick={() => onStep(-1)}
          disabled={disabled}
          aria-label="Previous frame"
        >
          ‹
        </button>
      ) : null}

      <div className="radar-timeline__main">
        <div className="radar-timeline__readout">
          <span ref={timeRef} className="radar-timeline__time">{currentTime}</span>
          {!compact ? <span className="radar-timeline__date">{currentDay}</span> : null}
          <span className="radar-timeline__range">
            {startTime} – {endTime}
          </span>
          <span ref={indexRef} className="radar-timeline__index">
            {frames.length === 0 ? '—/—' : `${displayIndex + 1}/${frames.length}`}
          </span>
        </div>

        <div
          ref={trackRef}
          className="radar-timeline__track"
          role="slider"
          tabIndex={disabled ? -1 : 0}
          aria-valuemin={0}
          aria-valuemax={Math.max(0, frames.length - 1)}
          aria-valuenow={displayIndex}
          aria-label="Radar animation time"
          aria-valuetext={shownFrame ? `${currentDay} ${currentTime}` : 'No frames'}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onKeyDown={(event) => {
            if (disabled || frames.length === 0) return
            if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') {
              event.preventDefault()
              const next = Math.max(0, frameIndex - 1)
              onSeek(progressForFrameIndex(times, next))
            }
            if (event.key === 'ArrowRight' || event.key === 'ArrowUp') {
              event.preventDefault()
              const next = Math.min(frames.length - 1, frameIndex + 1)
              onSeek(progressForFrameIndex(times, next))
            }
            if (event.key === 'Home') {
              event.preventDefault()
              onSeek(0)
            }
            if (event.key === 'End') {
              event.preventDefault()
              onSeek(1)
            }
            if ((event.key === ' ' || event.key === 'Enter') && onTogglePlay) {
              event.preventDefault()
              onTogglePlay()
            }
          }}
        >
          <div ref={fillRef} className="radar-timeline__fill" style={{ width: detentPercent }} />
          {frames.map((frame, index) => {
            const at =
              frames.length <= 1 || span <= 0
                ? 0
                : ((frame.time - first!.time) / span) * 100
            const active = index === displayIndex
            return (
              <span
                key={`${frame.kind ?? 'obs'}-${frame.time}-${index}`}
                ref={(node) => {
                  marksRef.current[index] = node
                }}
                className={`radar-timeline__mark${active ? ' is-active' : ''}`}
                style={{ left: `${at}%` }}
              />
            )
          })}
          <span ref={detentRef} className="radar-timeline__detent" style={{ left: detentPercent }}>
            <span className="radar-timeline__detent-knob" />
          </span>
        </div>
      </div>

      {!compact && onStep ? (
        <button
          type="button"
          className="radar-timeline__step"
          onClick={() => onStep(1)}
          disabled={disabled}
          aria-label="Next frame"
        >
          ›
        </button>
      ) : null}
    </div>
  )
}
