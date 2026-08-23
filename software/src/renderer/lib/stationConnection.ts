/**
 * Station link model — hardware adapters will populate this later.
 * Until a local Open Weather station is connected, the dashboard uses public weather.
 */

export type LinkedStation = {
  id: string
  name: string
  link: 'online' | 'degraded' | 'offline'
  batteryPct: number | null
  lastSeenLabel: string
}

export type StationConnection = {
  /** True when at least one Open Weather hardware station is linked. */
  connected: boolean
  stations: LinkedStation[]
}

/** Live samples from a linked station — used to bias day-0 of the ensemble forecast. */
export type StationObservation = {
  temperatureF: number | null
  humidityPct: number | null
  pressureInHg: number | null
  windMph: number | null
  precip24hIn: number | null
  observedAt: string | null
}

/** Placeholder until station pairing / discovery lands. */
export function getStationConnection(): StationConnection {
  return {
    connected: false,
    stations: []
  }
}

/** Returns null until firmware telemetry is wired into the Command Center. */
export function getStationObservation(): StationObservation | null {
  return null
}
