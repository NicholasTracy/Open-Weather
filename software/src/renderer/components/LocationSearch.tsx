import {
  forwardRef,
  useEffect,
  useId,
  useImperativeHandle,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactElement
} from 'react'
import {
  geocodePlace,
  kindLabel,
  suggestLocations,
  type GeocodeBias,
  type GeocodeResult
} from '../lib/geocode'
import { AutosizeInput } from './AutosizeInput'

export type LocationSearchHandle = {
  resolve: () => Promise<GeocodeResult | null>
}

type LocationSearchProps = {
  id?: string
  value: string
  onChange: (value: string) => void
  onSelect: (result: GeocodeResult) => void
  bias?: GeocodeBias
  placeholder?: string
  disabled?: boolean
  minChars?: number
  className?: string
  /** Open suggestions above the field (radar search sits at the bottom). */
  dropUp?: boolean
  /** Stretch the field to the parent width. */
  fill?: boolean
}

export const LocationSearch = forwardRef<LocationSearchHandle, LocationSearchProps>(
  function LocationSearch(
    {
      id,
      value,
      onChange,
      onSelect,
      bias,
      placeholder = 'Address, ZIP, city, county…',
      disabled = false,
      minChars = 14,
      className = '',
      dropUp = false,
      fill = false
    },
    ref
  ): ReactElement {
    const listId = useId()
    const rootRef = useRef<HTMLDivElement>(null)
    const suggestionsRef = useRef<GeocodeResult[]>([])
    const highlightRef = useRef(0)
    const openRef = useRef(false)
    const editedRef = useRef(false)
    const [suggestions, setSuggestions] = useState<GeocodeResult[]>([])
    const [open, setOpen] = useState(false)
    const [highlight, setHighlight] = useState(0)
    const [loading, setLoading] = useState(false)

    suggestionsRef.current = suggestions
    highlightRef.current = highlight
    openRef.current = open

    useImperativeHandle(ref, () => ({
      resolve: async () => {
        const current = suggestionsRef.current[highlightRef.current]
        if (openRef.current && current) return current
        return geocodePlace(value, { bias })
      }
    }))

    useEffect(() => {
      const query = value.trim()
      if (!editedRef.current || query.length < 2) {
        setSuggestions([])
        setOpen(false)
        setLoading(false)
        return
      }

      const controller = new AbortController()
      const timer = window.setTimeout(() => {
        setLoading(true)
        void suggestLocations(query, { bias, limit: 7, signal: controller.signal })
          .then((next) => {
            if (controller.signal.aborted) return
            setSuggestions(next)
            setHighlight(0)
            setOpen(next.length > 0)
          })
          .catch((err: unknown) => {
            if (controller.signal.aborted) return
            if (err instanceof DOMException && err.name === 'AbortError') return
            setSuggestions([])
            setOpen(false)
          })
          .finally(() => {
            if (!controller.signal.aborted) setLoading(false)
          })
      }, 280)

      return () => {
        controller.abort()
        window.clearTimeout(timer)
      }
    }, [value, bias?.lat, bias?.lon])

    useEffect(() => {
      const onPointer = (event: PointerEvent): void => {
        if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
      }
      window.addEventListener('pointerdown', onPointer)
      return () => window.removeEventListener('pointerdown', onPointer)
    }, [])

    const pick = (result: GeocodeResult): void => {
      editedRef.current = false
      onChange(result.label)
      onSelect(result)
      setOpen(false)
      setSuggestions([])
    }

    const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
      if (event.key === 'Escape') {
        setOpen(false)
        return
      }
      if (!open || suggestions.length === 0) return
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        setHighlight((index) => (index + 1) % suggestions.length)
        return
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault()
        setHighlight((index) => (index - 1 + suggestions.length) % suggestions.length)
        return
      }
      if (event.key === 'Enter' && suggestions[highlight]) {
        event.preventDefault()
        pick(suggestions[highlight])
      }
    }

    return (
      <div
        ref={rootRef}
        className={`location-search${dropUp ? ' location-search--drop-up' : ''}${fill ? ' location-search--fill' : ''} ${className}`.trim()}
      >
        <AutosizeInput
          id={id}
          className="form-control form-control-sm"
          value={value}
          disabled={disabled}
          placeholder={placeholder}
          minChars={minChars}
          fill={fill}
          autoComplete="off"
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={open && suggestions[highlight] ? `${listId}-${highlight}` : undefined}
          onChange={(event) => {
            editedRef.current = true
            onChange(event.target.value)
          }}
          onFocus={() => {
            if (suggestions.length > 0) setOpen(true)
          }}
          onKeyDown={onKeyDown}
        />
        {open && suggestions.length > 0 ? (
          <ul id={listId} className="location-search__list" role="listbox">
            {suggestions.map((result, index) => (
              <li key={result.id} role="presentation">
                <button
                  id={`${listId}-${index}`}
                  type="button"
                  role="option"
                  aria-selected={index === highlight}
                  className={`location-search__option${index === highlight ? ' is-active' : ''}`}
                  onMouseEnter={() => setHighlight(index)}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => pick(result)}
                >
                  <span className="location-search__kind">{kindLabel(result.kind)}</span>
                  <span className="location-search__text">
                    <span className="location-search__label">{result.label}</span>
                    <span className="location-search__detail">{result.detail}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        {loading && value.trim().length >= 2 && !open ? (
          <div className="location-search__status">Searching places…</div>
        ) : null}
      </div>
    )
  }
)
