import type { ReactElement } from 'react'

export function SensorsPage(): ReactElement {
  return (
    <section>
      <div className="page-heading">
        <h1>Sensors</h1>
        <p>Per-sensor status, calibration, and live sample streams will live here.</p>
      </div>
      <div className="panel empty-state">
        <strong>Sensor framework placeholder</strong>
        Connect station firmware next. This view is ready to host live telemetry tables and
        calibration controls.
      </div>
    </section>
  )
}
