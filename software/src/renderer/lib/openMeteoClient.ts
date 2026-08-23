/**
 * Serial Open-Meteo access for the renderer.
 * Multi-window / multi-hook fans-out stampedes the free forecast host (HTTP 429).
 * On 429 we fall back to sibling Open-Meteo hosts that share the same schema.
 */

const DEFAULT_GAP_MS = 2000
const RETRY_BASE_MS = 20_000

/** Hosts that speak /v1/forecast (pin weather + multi-point current). */
export const OPEN_METEO_FORECAST_HOSTS = [
  'https://api.open-meteo.com',
  'https://previous-runs-api.open-meteo.com'
] as const

type QueueJob<T> = {
  run: () => Promise<T>
  resolve: (value: T) => void
  reject: (reason: unknown) => void
}

let chain: Promise<void> = Promise.resolve()
let lastStartedAt = 0
let cooldownUntil = 0
/** Sticky preferred host origin after a successful fallback. */
let preferredHost: string | null = null
let preferredUntil = 0

export class OpenMeteoRateLimitError extends Error {
  retryAfterMs: number
  constructor(retryAfterMs: number) {
    super('Open-Meteo rate limited (HTTP 429)')
    this.name = 'OpenMeteoRateLimitError'
    this.retryAfterMs = retryAfterMs
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'))
      return
    }
    const timer = window.setTimeout(resolve, ms)
    const onAbort = (): void => {
      window.clearTimeout(timer)
      reject(new DOMException('Aborted', 'AbortError'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** Run fetcher exclusively; spaces requests and honors shared cooldown. */
export function enqueueOpenMeteo<T>(
  run: () => Promise<T>,
  signal?: AbortSignal,
  minGapMs = DEFAULT_GAP_MS
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const job: QueueJob<T> = { run, resolve, reject }
    chain = chain
      .then(async () => {
        if (signal?.aborted) {
          job.reject(new DOMException('Aborted', 'AbortError'))
          return
        }
        const now = Date.now()
        const wait = Math.max(0, minGapMs - (now - lastStartedAt), cooldownUntil - now)
        if (wait > 0) {
          try {
            await sleep(wait, signal)
          } catch (err) {
            job.reject(err)
            return
          }
        }
        lastStartedAt = Date.now()
        try {
          const value = await job.run()
          job.resolve(value)
        } catch (err) {
          if (err instanceof OpenMeteoRateLimitError) {
            cooldownUntil = Date.now() + err.retryAfterMs
          }
          job.reject(err)
        }
      })
      .catch(() => {
        /* keep queue alive after rejects */
      })
  })
}

function orderedHosts(): string[] {
  const hosts = [...OPEN_METEO_FORECAST_HOSTS]
  if (!preferredHost || Date.now() > preferredUntil) {
    preferredHost = null
    return hosts
  }
  if (!hosts.includes(preferredHost as (typeof OPEN_METEO_FORECAST_HOSTS)[number])) {
    return hosts
  }
  return [preferredHost, ...hosts.filter((h) => h !== preferredHost)]
}

/**
 * GET JSON. Absolute forecast-host URLs try primary then previous-runs on HTTP 429.
 */
export async function fetchOpenMeteoJson<T>(
  url: string | URL,
  signal?: AbortSignal,
  options?: { minGapMs?: number }
): Promise<T> {
  return enqueueOpenMeteo(async () => {
    const incoming = typeof url === 'string' ? url : url.toString()
    let attemptUrls: string[]

    try {
      const parsed = new URL(incoming)
      const isForecastHost =
        parsed.hostname.endsWith('open-meteo.com') && parsed.pathname.includes('/v1/forecast')
      if (isForecastHost) {
        attemptUrls = [...new Set(orderedHosts().map((host) => {
          const next = new URL(incoming)
          const base = new URL(host)
          next.protocol = base.protocol
          next.host = base.host
          return next.toString()
        }))]
      } else {
        attemptUrls = [incoming]
      }
    } catch {
      attemptUrls = [incoming]
    }

    let last429Ms = RETRY_BASE_MS
    let lastError: Error | null = null

    for (let i = 0; i < attemptUrls.length; i += 1) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
      const attempt = attemptUrls[i]!
      let response: Response
      try {
        response = await fetch(attempt, { signal })
      } catch (err) {
        lastError = err instanceof Error ? err : new Error('Failed to fetch')
        // Network / CSP: try next host
        if (i < attemptUrls.length - 1) continue
        throw lastError
      }
      if (response.status === 429) {
        const retryAfterHeader = response.headers.get('retry-after')
        last429Ms = retryAfterHeader
          ? Math.max(RETRY_BASE_MS, Number(retryAfterHeader) * 1000 || RETRY_BASE_MS)
          : RETRY_BASE_MS
        lastError = new OpenMeteoRateLimitError(last429Ms)
        continue
      }
      if (!response.ok) {
        lastError = new Error(`Open-Meteo HTTP ${response.status}`)
        if ((response.status >= 500 || response.status === 404) && i < attemptUrls.length - 1) {
          continue
        }
        throw lastError
      }
      try {
        const hostBase = new URL(attempt).origin
        if (hostBase !== OPEN_METEO_FORECAST_HOSTS[0]) {
          preferredHost = hostBase
          preferredUntil = Date.now() + 15 * 60 * 1000
        }
      } catch {
        /* ignore */
      }
      return (await response.json()) as T
    }

    throw lastError ?? new OpenMeteoRateLimitError(last429Ms)
  }, signal, options?.minGapMs)
}

export function getOpenMeteoCooldownRemainingMs(): number {
  return Math.max(0, cooldownUntil - Date.now())
}
