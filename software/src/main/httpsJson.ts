import https from 'https'

const USER_AGENT = 'OpenWeatherCommandCenter/0.1 (+https://github.com/NicholasTracy/Open-Weather)'

export function fetchHttpsText(
  url: string,
  options?: { redirects?: number; timeoutMs?: number; headers?: Record<string, string> }
): Promise<string> {
  const redirects = options?.redirects ?? 0
  const timeoutMs = options?.timeoutMs ?? 12_000
  return new Promise((resolve, reject) => {
    const request = https.get(
      url,
      {
        headers: {
          'User-Agent': USER_AGENT,
          Accept: 'text/plain, text/html;q=0.8, */*;q=0.5',
          ...options?.headers
        }
      },
      (response) => {
        const status = response.statusCode ?? 0
        const location = response.headers.location
        if (status >= 300 && status < 400 && location && redirects < 4) {
          response.resume()
          const next = new URL(location, url).toString()
          void fetchHttpsText(next, { ...options, redirects: redirects + 1 }).then(resolve, reject)
          return
        }
        if (status < 200 || status >= 300) {
          response.resume()
          reject(new Error(`HTTP ${status}`))
          return
        }
        const chunks: Buffer[] = []
        response.on('data', (chunk) => chunks.push(chunk as Buffer))
        response.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      }
    )
    request.setTimeout(timeoutMs, () => {
      request.destroy()
      reject(new Error('Request timed out'))
    })
    request.on('error', reject)
  })
}

export function fetchHttpsJson(
  url: string,
  options?: { redirects?: number; timeoutMs?: number; headers?: Record<string, string> }
): Promise<unknown> {
  const redirects = options?.redirects ?? 0
  const timeoutMs = options?.timeoutMs ?? 12_000
  return new Promise((resolve, reject) => {
    const request = https.get(
      url,
      {
        headers: {
          'User-Agent': USER_AGENT,
          Accept: 'application/geo+json, application/json',
          ...options?.headers
        }
      },
      (response) => {
        const status = response.statusCode ?? 0
        const location = response.headers.location
        if (status >= 300 && status < 400 && location && redirects < 4) {
          response.resume()
          const next = new URL(location, url).toString()
          void fetchHttpsJson(next, { ...options, redirects: redirects + 1 }).then(resolve, reject)
          return
        }
        if (status < 200 || status >= 300) {
          response.resume()
          reject(new Error(`HTTP ${status}`))
          return
        }
        const chunks: Buffer[] = []
        response.on('data', (chunk) => chunks.push(chunk as Buffer))
        response.on('end', () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
          } catch (error) {
            reject(error)
          }
        })
      }
    )
    request.setTimeout(timeoutMs, () => {
      request.destroy()
      reject(new Error('Request timed out'))
    })
    request.on('error', reject)
  })
}

export async function mapPool<T>(
  items: T[],
  limit: number,
  work: (item: T) => Promise<void>
): Promise<void> {
  let index = 0
  const workers = Array.from({ length: Math.min(limit, Math.max(1, items.length)) }, async () => {
    while (index < items.length) {
      const current = items[index]!
      index += 1
      await work(current)
    }
  })
  await Promise.all(workers)
}
