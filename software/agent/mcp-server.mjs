#!/usr/bin/env node
/**
 * Open Weather Command Center MCP server (stdio, newline-delimited JSON-RPC).
 * Proxies tools to the local agent bridge on port 17832.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { request as httpRequest } from 'node:http'

const PORT = Number(process.env.OW_AGENT_PORT ?? 17832)
const HOST = '127.0.0.1'

function bridge(method, pathName, body) {
  const payload = body === undefined ? null : JSON.stringify(body)
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: HOST,
        port: PORT,
        path: pathName,
        method,
        headers: payload
          ? {
              'Content-Type': 'application/json',
              'Content-Length': Buffer.byteLength(payload)
            }
          : undefined,
        timeout: 20000
      },
      (res) => {
        const chunks = []
        res.on('data', (chunk) => chunks.push(chunk))
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          try {
            resolve({ status: res.statusCode ?? 0, body: JSON.parse(text) })
          } catch {
            resolve({ status: res.statusCode ?? 0, body: { raw: text } })
          }
        })
      }
    )
    req.on('error', reject)
    req.on('timeout', () => {
      req.destroy(new Error('Agent bridge request timed out'))
    })
    if (payload) req.write(payload)
    req.end()
  })
}

function textResult(payload, isError = false) {
  return {
    content: [
      {
        type: 'text',
        text: typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2)
      }
    ],
    isError
  }
}

async function safeBridge(method, pathName, body) {
  try {
    return await bridge(method, pathName, body)
  } catch (error) {
    return {
      status: 0,
      body: {
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : String(error)
      },
      bridgeError: true
    }
  }
}

const server = new McpServer(
  {
    name: 'open-weather-agent',
    version: '0.2.0'
  },
  {
    instructions:
      'Control Open Weather Command Center while the desktop app is running (npm run dev). Bridge: http://127.0.0.1:17832'
  }
)

server.registerTool(
  'ow_health',
  {
    description:
      'Check whether the Open Weather Command Center agent bridge is online (app must be running).',
    inputSchema: z.object({})
  },
  async () => {
    const result = await safeBridge('GET', '/health')
    if (result.bridgeError) {
      return textResult(
        `Agent bridge error (${HOST}:${PORT}): ${result.body.error}. Start with npm run dev in software/.`,
        true
      )
    }
    return textResult(result.body)
  }
)

server.registerTool(
  'ow_list_windows',
  {
    description: 'List open Command Center windows (id, page, title, bounds).',
    inputSchema: z.object({})
  },
  async () => {
    const result = await safeBridge('GET', '/windows')
    if (result.bridgeError) {
      return textResult(`Agent bridge error: ${result.body.error}`, true)
    }
    return textResult(result.body)
  }
)

server.registerTool(
  'ow_get_state',
  {
    description:
      'Read structured map/radar/UI state. Prefer page (Dashboard, Radar, Sensors, History, Stations, Settings) or windowId.',
    inputSchema: z.object({
      windowId: z.number().optional(),
      page: z.string().optional()
    })
  },
  async ({ windowId, page }) => {
    const q = new URLSearchParams()
    if (windowId != null) q.set('windowId', String(windowId))
    if (page) q.set('page', page)
    const qs = q.toString()
    const result = await safeBridge('GET', `/state${qs ? `?${qs}` : ''}`)
    if (result.bridgeError) {
      return textResult(`Agent bridge error: ${result.body.error}`, true)
    }
    return textResult(result.body)
  }
)

server.registerTool(
  'ow_screenshot',
  {
    description:
      'Capture a PNG of an app window via Electron capturePage. Returns absolute file path for visual review.',
    inputSchema: z.object({
      windowId: z.number().optional(),
      page: z.string().optional()
    })
  },
  async ({ windowId, page }) => {
    const result = await safeBridge('POST', '/screenshot', { windowId, page })
    if (result.bridgeError) {
      return textResult(`Agent bridge error: ${result.body.error}`, true)
    }
    const pathOut = result.body?.path
    const lines = [JSON.stringify(result.body, null, 2)]
    if (pathOut) lines.push(`Screenshot saved. Read the image at: ${pathOut}`)
    return {
      content: lines.map((text) => ({ type: 'text', text }))
    }
  }
)

server.registerTool(
  'ow_command',
  {
    description:
      'Control the app: open pages, focus, set pin/basemap/overlays, radar play/scrub, navigate, reload.',
    inputSchema: z.object({
      windowId: z.number().optional(),
      page: z.string().optional(),
      command: z.record(z.string(), z.unknown())
    })
  },
  async ({ windowId, page, command }) => {
    const result = await safeBridge('POST', '/command', { windowId, page, command })
    if (result.bridgeError) {
      return textResult(`Agent bridge error: ${result.body.error}`, true)
    }
    return textResult(result.body)
  }
)

async function main() {
  // Keep stdout clean — logs must go to stderr and only after transport starts if needed.
  const transport = new StdioServerTransport()
  await server.connect(transport)
  process.stderr.write(
    `[open-weather-agent] ready via SDK (node ${process.version}, bridge http://${HOST}:${PORT})\n`
  )
}

main().catch((error) => {
  process.stderr.write(
    `[open-weather-agent] fatal: ${error instanceof Error ? error.stack ?? error.message : error}\n`
  )
  process.exit(1)
})
