import {createServer, type IncomingMessage} from 'node:http'
import {randomBytes, timingSafeEqual} from 'node:crypto'
import {readFile, mkdir} from 'node:fs/promises'
import {GuiSession} from './gui-session.js'

export function authorized(headers: IncomingMessage['headers'], host: string, token: string) {
  if (headers.host !== host || (headers.origin && headers.origin !== `http://${host}`)) return false
  const supplied = headers.authorization ?? ''
  const expected = `Bearer ${token}`
  return Buffer.byteLength(supplied) === Buffer.byteLength(expected)
    && timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))
}

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (req.headers['content-type']?.split(';')[0] !== 'application/json') throw new Error('Se requiere JSON.')
  let size = 0
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    size += chunk.length
    if (size > 8192) throw new Error('La solicitud es demasiado grande.')
    chunks.push(chunk)
  }
  const value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Solicitud inválida.')
  return value
}

export function createGuiServer(outDir: string, assetRoot: URL, session = new GuiSession(outDir)) {
  const token = randomBytes(32).toString('hex')
  const assets: Record<string, [string, string]> = {
    '/': ['index.html', 'text/html; charset=utf-8'],
    '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
    '/style.css': ['style.css', 'text/css; charset=utf-8'],
  }
  const server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Referrer-Policy', 'no-referrer')
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'self'")
    const reply = (code: number, value: unknown) => {
      res.writeHead(code, {'Content-Type': 'application/json; charset=utf-8'})
      res.end(JSON.stringify(value))
    }
    const address = server.address()
    const host = `127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
    if (req.headers.host !== host) { reply(403, {error: 'Host no permitido.'}); return }
    const pathname = (req.url ?? '/').split('?')[0]!
    try {
      if (pathname.startsWith('/api/')) {
        if (!authorized(req.headers, host, token)) { reply(403, {error: 'Sesión inválida. Abre el enlace completo que aparece en tu terminal.'}); return }
        if (req.method === 'GET' && pathname === '/api/state') {
          reply(200, {...session.snapshot(), outDir}); return
        }
        if (req.method !== 'POST') { reply(405, {error: 'Método no permitido.'}); return }
        const data = await body(req)
        if (pathname === '/api/analyze') session.analyze(data.url)
        else if (pathname === '/api/download') {
          await mkdir(outDir, {recursive: true})
          session.start(data.index)
        } else if (pathname === '/api/cancel') session.cancel()
        else { reply(404, {error: 'Ruta no encontrada.'}); return }
        reply(202, session.snapshot()); return
      }
      const asset = assets[pathname]
      if (req.method !== 'GET' || !asset) { reply(404, {error: 'Ruta no encontrada.'}); return }
      const bytes = await readFile(new URL(asset[0], assetRoot))
      res.writeHead(200, {'Content-Type': asset[1]})
      res.end(bytes)
    } catch (error) {
      reply(400, {error: error instanceof Error ? error.message : 'No se pudo completar la solicitud.'})
    }
  })
  server.requestTimeout = 15_000
  server.headersTimeout = 10_000
  return {server, token, session}
}
