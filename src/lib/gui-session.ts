import {buildChoices, download, ensureYtDlp, findFfmpeg, probe, type DownloadChoice, type DownloadProgress} from './ytdlp.js'
import {Diagnostics, redactDiagnostic} from './diagnostics.js'
import {isProbablyUrl} from './platforms.js'

const defaultServices = {buildChoices, download, ensureYtDlp, findFfmpeg, probe}
export type GuiServices = typeof defaultServices
export type GuiState = {
  phase: 'idle' | 'probing' | 'ready' | 'downloading' | 'processing' | 'done' | 'cancelled' | 'error'
  url?: string
  title?: string
  uploader?: string
  duration?: number
  choices?: Array<{label: string; kind: 'video' | 'audio'}>
  selected?: number
  progress?: DownloadProgress
  filepath?: string
  logs?: string[]
  error?: string
}

/** One local session, no persistent history and no client-supplied executable arguments. */
export class GuiSession {
  private state: GuiState = {phase: 'idle'}
  private choices: DownloadChoice[] = []
  private binary = ''
  private controller?: AbortController
  private generation = 0

  constructor(readonly outDir: string, private services: GuiServices = defaultServices, private diagnostics = new Diagnostics()) {}

  snapshot(): GuiState { return structuredClone({...this.state, logs: this.diagnostics.snapshot()}) }

  log = (message: string) => { this.diagnostics.add(message) }

  private busy() {
    return ['probing', 'downloading', 'processing'].includes(this.state.phase)
  }

  analyze(value: unknown) {
    if (this.busy()) throw new Error('Espera a que termine la tarea o cancélala.')
    if (typeof value !== 'string' || value.length > 4096 || !isProbablyUrl(value)) {
      throw new Error('Pega un enlace válido que empiece con http:// o https://.')
    }
    const url = value.trim()
    const controller = new AbortController()
    this.controller = controller
    const generation = ++this.generation
    this.choices = []
    this.state = {phase: 'probing', url}
    this.log('Iniciando análisis del enlace. Comprobando yt-dlp en el PATH.')
    void (async () => {
      try {
        this.binary = await this.services.ensureYtDlp(() => {}, controller.signal, this.log)
        if (controller.signal.aborted) return
        const {info} = await this.services.probe(this.binary, url, controller.signal, this.log)
        if (generation !== this.generation) return
        this.choices = this.services.buildChoices(info)
        this.log(`Análisis correcto: ${this.choices.length} formatos disponibles.`)
        this.state = {
          phase: 'ready', url, title: info.title, uploader: info.uploader, duration: info.duration,
          choices: this.choices.map(({label, kind}) => ({label, kind})),
        }
      } catch (error) { this.fail(error, generation) }
    })()
  }

  start(index: unknown) {
    if (this.state.phase !== 'ready') throw new Error('Primero analiza un enlace.')
    if (typeof index !== 'number' || !Number.isInteger(index) || !this.choices[index]) {
      throw new Error('Selecciona un formato disponible.')
    }
    const choice = this.choices[index]!
    const url = this.state.url!
    const controller = new AbortController()
    this.controller = controller
    const generation = ++this.generation
    this.state = {...this.state, phase: 'downloading', selected: index}
    this.log(`Iniciando descarga: ${choice.label}`)
    void (async () => {
      try {
        const ffmpegLocation = await this.services.findFfmpeg(this.log)
        if (controller.signal.aborted) return
        const filepath = await this.services.download({ytdlp: this.binary, ffmpegLocation, url, choice, outDir: this.outDir}, {
          onDiagnostic: this.log,
          onProgress: progress => {
            if (generation === this.generation) this.state = {...this.state, phase: 'downloading', progress}
          },
          onProcessing: () => {
            if (generation === this.generation) {
              this.state = {...this.state, phase: 'processing'}
              this.log('Procesando el archivo con FFmpeg.')
            }
          },
        }, controller.signal)
        if (generation === this.generation) {
          this.state = {...this.state, phase: 'done', filepath}
          this.log('Descarga finalizada correctamente.')
        }
      } catch (error) { this.fail(error, generation) }
    })()
  }

  cancel() {
    if (!this.busy()) return
    ++this.generation
    this.log('Cancelación solicitada por el usuario.')
    this.controller?.abort()
    this.state = {...this.state, phase: 'cancelled'}
  }

  private fail(error: unknown, generation: number) {
    if (generation !== this.generation) return
    const detail = error instanceof Error ? error.message : String(error)
    this.log(`ERROR: ${detail}`)
    const message = detail.includes('Install yt-dlp')
      ? 'No se encontró yt-dlp o no pudo ejecutarse. Revisa el diagnóstico de abajo. Comprueba yt-dlp --version en una terminal nueva; instala o actualiza yt-dlp si falla.'
      : detail
    this.state = {...this.state, phase: 'error', error: redactDiagnostic(message)}
  }
}
