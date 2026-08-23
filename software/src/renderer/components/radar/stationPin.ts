import L from 'leaflet'

/** High-contrast station pin for dark UI. */
export const stationPinIcon = L.divIcon({
  className: 'ow-station-pin',
  html: `
    <span class="ow-station-pin__halo"></span>
    <span class="ow-station-pin__dot"></span>
  `,
  iconSize: [22, 22],
  iconAnchor: [11, 11]
})
