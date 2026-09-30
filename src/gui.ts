import os from 'node:os'
import path from 'node:path'
import {spawn} from 'node:child_process'
import {createGuiServer} from './lib/gui-server.js'

const {server, token, session} = createGuiServer(path.join(os.homedir(), 'Downloads'), new URL('../web/', import.meta.url))
server.on('error', error => {
  console.error(`No se pudo abrir la interfaz: ${error.message}`)
  process.exitCode = 1
})
server.listen(0, '127.0.0.1', () => {
  const address = server.address()
  if (!address || typeof address === 'string') return
  const url = `http://127.0.0.1:${address.port}/#${token}`
  console.log(`\n  yoinkss · interfaz local\n\n  ${url}\n\n  Deja esta terminal abierta. Ctrl+C para cerrar.\n`)
  if (process.argv.includes('--open')) {
    const [command, args] = process.platform === 'win32'
      ? ['rundll32.exe', ['url.dll,FileProtocolHandler', url]] as const
      : process.platform === 'darwin' ? ['open', [url]] as const : ['xdg-open', [url]] as const
    const child = spawn(command, [...args], {stdio: 'ignore', detached: true})
    child.on('error', () => console.log('Abre manualmente el enlace anterior en tu navegador.'))
    child.unref()
  }
})
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    session.cancel()
    server.close()
    server.closeAllConnections()
  })
}
