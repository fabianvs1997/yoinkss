import {buildChoices, download, ensureYtDlp, findFfmpeg, probe, type DownloadChoice, type DownloadProgress} from './ytdlp.js'
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
  error?: string
}

/** One local session, no persistent history and no client-supplied executable arguments. */
export class GuiSession {
  private state: GuiState = {phase: 'idle'}
  private choices: DownloadChoice[] = []
  private binary = ''
  private controller?: AbortController
  private generation = 0

  constructor(readonly outDir: string, private services: GuiServices = defaultServices) {}

  snapshot(): GuiState { return structuredClone(this.state) }

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
    void (async () => {
      try {
        this.binary = await this.services.ensureYtDlp(() => {}, controller.signal)
        if (controller.signal.aborted) return
        const {info} = await this.services.probe(this.binary, url, controller.signal)
        if (generation !== this.generation) return
        this.choices = this.services.buildChoices(info)
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
    void (async () => {
      try {
        const ffmpegLocation = await this.services.findFfmpeg()
        if (controller.signal.aborted) return
        const filepath = await this.services.download({ytdlp: this.binary, ffmpegLocation, url, choice, outDir: this.outDir}, {
          onProgress: progress => {
            if (generation === this.generation) this.state = {...this.state, phase: 'downloading', progress}
          },
          onProcessing: () => {
            if (generation === this.generation) this.state = {...this.state, phase: 'processing'}
          },
        }, controller.signal)
        if (generation === this.generation) this.state = {...this.state, phase: 'done', filepath}
      } catch (error) { this.fail(error, generation) }
    })()
  }

  cancel() {
    if (!this.busy()) return
    ++this.generation
    this.controller?.abort()
    this.state = {...this.state, phase: 'cancelled'}
  }

  private fail(error: unknown, generation: number) {
    if (generation !== this.generation) return
    const detail = error instanceof Error ? error.message : String(error)
    const message = detail.includes('Install yt-dlp')
      ? 'No se encontró yt-dlp. Instálalo y agrégalo al PATH; después reinicia la interfaz. Consulta el README del proyecto.'
      : detail
    this.state = {...this.state, phase: 'error', error: message.slice(0, 2000)}
  }
}
