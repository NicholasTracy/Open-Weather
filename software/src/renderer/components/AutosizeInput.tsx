import {
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type InputHTMLAttributes,
  type ReactElement
} from 'react'

type AutosizeInputProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> & {
  /** Extra characters of padding beyond the current value/placeholder. */
  padChars?: number
  minChars?: number
  /** Stretch to the parent width instead of hugging text. */
  fill?: boolean
}

/**
 * Text input that grows/shrinks to the content width (plus light padding).
 */
export function AutosizeInput({
  className = '',
  value,
  placeholder = '',
  padChars = 1,
  minChars = 4,
  fill = false,
  style,
  ...rest
}: AutosizeInputProps): ReactElement {
  const inputRef = useRef<HTMLInputElement>(null)
  const mirrorRef = useRef<HTMLSpanElement>(null)
  const [widthPx, setWidthPx] = useState<number | undefined>(undefined)
  const text = String(value ?? '')
  const mirrorText = text.length > 0 ? text : placeholder || ' '

  useLayoutEffect(() => {
    if (fill) return
    const input = inputRef.current
    const mirror = mirrorRef.current
    if (!input || !mirror) return

    const cs = getComputedStyle(input)
    mirror.style.font = cs.font
    mirror.style.letterSpacing = cs.letterSpacing
    mirror.style.textTransform = cs.textTransform
    mirror.style.paddingLeft = cs.paddingLeft
    mirror.style.paddingRight = cs.paddingRight
    mirror.style.borderLeftWidth = cs.borderLeftWidth
    mirror.style.borderRightWidth = cs.borderRightWidth
    mirror.style.boxSizing = cs.boxSizing

    const next = Math.ceil(mirror.scrollWidth) + padChars * 8
    const min = minChars * 8
    const width = Math.max(min, next)
    setWidthPx((prev) => (prev === width ? prev : width))
  }, [fill, mirrorText, padChars, minChars])

  const mergedStyle: CSSProperties = {
    ...style,
    width: fill ? '100%' : widthPx !== undefined ? `${widthPx}px` : undefined
  }

  return (
    <span className={`ow-autosize${fill ? ' ow-autosize--fill' : ''}`}>
      {fill ? null : (
        <span ref={mirrorRef} className="ow-autosize__mirror" aria-hidden="true">
          {mirrorText}
        </span>
      )}
      <input
        {...rest}
        ref={inputRef}
        className={`ow-input ow-input--autosize ${className}`.trim()}
        value={value}
        placeholder={placeholder}
        style={mergedStyle}
      />
    </span>
  )
}
