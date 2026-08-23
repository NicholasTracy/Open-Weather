import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http'
import { mkdirSync, writeFileSync } from 'fs'
import path from 'path'
import { BrowserWindow, app } from 'electron'
import {
  DEFAULT_AGENT_BRIDGE_PORT,
  type AgentAppState,
  type AgentCommand,
  type AgentCommandResult,
  type AgentScreenshotResult,
  type AgentWindowInfo
} from '../shared/agentApi'
import type { Page } from '../shared/pages'

export type AgentBridgeControllers = {
  listWindows: () => AgentWindowInfo[]
  findWindow: (windowId?: number, page?: string) => BrowserWindow | null
  openPage: (page: Page, displayId?: number) => void
  focusMain: () => void
  closeDetached: (page?: Page) => boolean
  executeRendererCommand: (
    window: BrowserWindow,
    command: AgentCommand
  ) => Promise<AgentCommandResult>
  getRendererState: (window: BrowserWindow) => Promise<AgentAppState | null>
}

let server: Server | null = null
let activePort: number | null = null

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body, null, 2)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  })
  res.end(payload)
}

function isLocalRequest(req: IncomingMessage): boolean {
  const host = (req.socket.remoteAddress ?? '').replace('::ffff:', '')
  return host === '127.0.0.1' || host === '::1' || host === 'localhost'
}

function capturesDir(): string {
  const dir = path.join(app.getPath('userData'), 'agent-captures')
  mkdirSync(dir, { recursive: true })
  return dir
}

export function getAgentBridgePort(): number | null {
  return activePort
}

export async function startAgentBridge(controllers: AgentBridgeControllers): Promise<number> {
  if (server) {
    return activePort ?? DEFAULT_AGENT_BRIDGE_PORT
  }

  const preferred = Number(process.env.OW_AGENT_PORT ?? DEFAULT_AGENT_BRIDGE_PORT)
  const port = Number.isFinite(preferred) && preferred > 0 ? preferred : DEFAULT_AGENT_BRIDGE_PORT

  server = createServer(async (req, res) => {
    if (!isLocalRequest(req)) {
      sendJson(res, 403, { ok: false, error: 'Agent bridge is localhost-only' })
      return
    }

    if (req.method === 'OPTIONS') {
      sendJson(res, 204, {})
      return
    }

    try {
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`)
      const route = url.pathname.replace(/\/+$/, '') || '/'

      if (req.method === 'GET' && route === '/health') {
        sendJson(res, 200, {
          ok: true,
          service: 'open-weather-agent-bridge',
          port,
          cdpPort: process.env.OW_CDP_PORT ?? null,
          windows: controllers.listWindows().length
        })
        return
      }

      if (req.method === 'GET' && route === '/windows') {
        sendJson(res, 200, { ok: true, windows: controllers.listWindows() })
        return
      }

      if (req.method === 'GET' && route === '/state') {
        const windowId = url.searchParams.get('windowId')
        const page = url.searchParams.get('page') ?? undefined
        const win = controllers.findWindow(
          windowId ? Number(windowId) : undefined,
          page ?? undefined
        )
        if (!win) {
          sendJson(res, 404, { ok: false, error: 'Window not found' })
          return
        }
        const state = await controllers.getRendererState(win)
        sendJson(res, 200, { ok: true, state })
        return
      }

      if (req.method === 'POST' && route === '/screenshot') {
        const raw = await readBody(req)
        const body = raw ? (JSON.parse(raw) as { windowId?: number; page?: string }) : {}
        const win = controllers.findWindow(body.windowId, body.page)
        if (!win || win.isDestroyed()) {
          sendJson(res, 404, { ok: false, error: 'Window not found' })
          return
        }
        if (win.isMinimized()) win.restore()
        win.show()
        const image = await win.webContents.capturePage()
        const size = image.getSize()
        const png = image.toPNG()
        const stamp = new Date().toISOString().replace(/[:.]/g, '-')
        const pageLabel =
          controllers.listWindows().find((entry) => entry.id === win.id)?.page ?? 'window'
        const filePath = path.join(capturesDir(), `ow-${pageLabel}-${stamp}.png`)
        writeFileSync(filePath, png)
        const result: AgentScreenshotResult = {
          ok: true,
          windowId: win.id,
          page: String(pageLabel),
          path: filePath,
          mimeType: 'image/png',
          width: size.width,
          height: size.height
        }
        sendJson(res, 200, result)
        return
      }

      if (req.method === 'POST' && route === '/command') {
        const raw = await readBody(req)
        const body = JSON.parse(raw || '{}') as {
          windowId?: number
          page?: string
          command: AgentCommand
        }
        if (!body.command || typeof body.command !== 'object') {
          sendJson(res, 400, { ok: false, error: 'Missing command' })
          return
        }

        const command = body.command
        if (command.type === 'open_page') {
          controllers.openPage(command.page, command.displayId)
          sendJson(res, 200, { ok: true, message: `Opened ${command.page}` } satisfies AgentCommandResult)
          return
        }
        if (command.type === 'focus_main') {
          controllers.focusMain()
          sendJson(res, 200, { ok: true, message: 'Focused main window' } satisfies AgentCommandResult)
          return
        }
        if (command.type === 'close_detached') {
          const closed = controllers.closeDetached(command.page)
          sendJson(res, 200, {
            ok: closed,
            message: closed ? 'Closed detached window' : 'No detached window closed'
          } satisfies AgentCommandResult)
          return
        }
        if (command.type === 'reload') {
          const win = controllers.findWindow(body.windowId, body.page)
          if (!win) {
            sendJson(res, 404, { ok: false, error: 'Window not found' })
            return
          }
          // Bypass Vite HMR cache after compile errors — hard reload recovers blank screens.
          win.webContents.reloadIgnoringCache()
          sendJson(res, 200, { ok: true, message: 'Reloaded window' } satisfies AgentCommandResult)
          return
        }

        const win = controllers.findWindow(body.windowId, body.page)
        if (!win) {
          sendJson(res, 404, { ok: false, error: 'Window not found' })
          return
        }
        const result = await controllers.executeRendererCommand(win, command)
        sendJson(res, result.ok ? 200 : 400, result)
        return
      }

      sendJson(res, 404, { ok: false, error: `Unknown route ${route}` })
    } catch (error) {
      sendJson(res, 500, {
        ok: false,
        error: error instanceof Error ? error.message : 'Agent bridge error'
      })
    }
  })

  await new Promise<void>((resolve, reject) => {
    server!.once('error', reject)
    server!.listen(port, '127.0.0.1', () => {
      activePort = port
      console.log(`[agent-bridge] listening on http://127.0.0.1:${port}`)
      resolve()
    })
  })

  return port
}

export async function stopAgentBridge(): Promise<void> {
  if (!server) return
  const current = server
  server = null
  activePort = null
  await new Promise<void>((resolve) => {
    current.close(() => resolve())
  })
}
