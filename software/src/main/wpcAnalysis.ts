import { parseCodsusBulletin, type WpcSurfaceAnalysis } from '../shared/codsus'
import { fetchHttpsText } from './httpsJson'

const IEM_CODSUS =
  'https://mesonet.agron.iastate.edu/cgi-bin/afos/retrieve.py?pil=CODSUS&limit=1'

export async function fetchWpcSurfaceAnalysis(): Promise<WpcSurfaceAnalysis> {
  const text = await fetchHttpsText(IEM_CODSUS, { timeoutMs: 16_000 })
  const analysis = parseCodsusBulletin(text)
  if (analysis.fronts.length < 2 && analysis.systems.length < 2) {
    throw new Error('WPC coded surface bulletin parsed empty')
  }
  return analysis
}
