import {spawn, type ChildProcess} from 'node:child_process'
import path from 'node:path'
import {isProbablyUrl} from './platforms.js'
import {formatBytes} from './format.js'

export type Diagnostic = (message: string) => void

// async on purpose: a spawnSync here blocks the event loop, which freezes
// ink mid-frame — the user hits enter and sees nothing until it returns
function commandWorks(cmd: string, args: string[], diagnostic?: Diagnostic): Promise<boolean> {
  return new Promise(resolve => {
    let child
    let stderr = ''
    let stdout = ''
    diagnostic?.(`Comprobando ${cmd} ${args.join(' ')}`)
    try {
      child = spawn(cmd, args, {stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000})
    } catch (error) {
      diagnostic?.(`No se pudo iniciar ${cmd}: ${String(error)}`)
      resolve(false)
      return
    }
    child.stdout.on('data', chunk => { stdout = (stdout + chunk).slice(-1024) })
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-8192) })
    child.on('error', (error: NodeJS.ErrnoException) => {
      diagnostic?.(`${cmd}: ${error.code ?? 'ERROR'} — ${error.message}`)
      resolve(false)
    })
    child.on('close', (code, signal) => {
      if (code === 0) diagnostic?.(`${cmd} disponible: ${stdout.trim().split('\n')[0] || 'OK'}`)
      else diagnostic?.(`${cmd} falló: código ${code}, señal ${signal ?? 'ninguna'}. ${stderr.trim() || 'Sin salida de error.'}`)
      resolve(code === 0)
    })
  })
}

/** Use an explicitly installed binary; never download and execute a moving release. */
export async function ensureYtDlp(_onStatus: (message: string) => void, signal?: AbortSignal, diagnostic?: Diagnostic): Promise<string> {
  signal?.throwIfAborted()
  if (await commandWorks('yt-dlp', ['--ignore-config', '--no-plugin-dirs', '--version'], diagnostic)) return 'yt-dlp'
  throw new Error('Install yt-dlp from its official distribution and add it to PATH. Automatic executable downloads are disabled.')
}

/**
 * Find ffmpeg for stream merging / mp3 extraction: system install first,
 * ffmpeg-static as fallback. Returns undefined if neither exists — yt-dlp
 * still works for single-file formats without it.
 */
export async function findFfmpeg(diagnostic?: Diagnostic): Promise<string | undefined> {
  if (await commandWorks('ffmpeg', ['-version'], diagnostic)) return undefined // on PATH, yt-dlp finds it itself
  try {
    const mod = await import('ffmpeg-static')
    const ffmpegPath = (mod.default ?? mod) as unknown as string | null
    if (ffmpegPath && (await commandWorks(ffmpegPath, ['-version'], diagnostic))) return ffmpegPath
  } catch {
    // ffmpeg-static not installed or unsupported platform
  }
  diagnostic?.('FFmpeg no está disponible. La unión de video/audio y conversión MP3 pueden fallar.')
  return undefined
}

export type VideoInfo = {
  title: string
  uploader?: string
  duration?: number
  webpage_url?: string
  extractor_key?: string
  formats?: RawFormat[]
}

type RawFormat = {
  format_id: string
  ext?: string
  vcodec?: string
  acodec?: string
  height?: number
  width?: number
  abr?: number
  tbr?: number
  filesize?: number
  filesize_approx?: number
}

export type ProbeResult = {
  info: VideoInfo
}

export async function probe(ytdlp: string, url: string, signal?: AbortSignal, diagnostic?: Diagnostic): Promise<ProbeResult> {
  if (!isProbablyUrl(url)) throw new Error('Only HTTP and HTTPS URLs are supported.')
  const stdout = await new Promise<string>((resolve, reject) => {
    const child = spawn(ytdlp, ['--ignore-config', '--no-plugin-dirs', '-J', '--no-playlist', ...(diagnostic ? [] : ['--no-warnings']), '--', url], {signal})
    let out = ''
    let stderr = ''
    child.stdout.on('data', chunk => (out += chunk))
    child.stderr.on('data', chunk => {
      stderr = (stderr + chunk).slice(-32768)
      diagnostic?.(`yt-dlp: ${String(chunk).trim()}`)
    })
    child.on('error', error => { diagnostic?.(`yt-dlp: ${error.message}`); reject(error) })
    child.on('close', (code, signal) => {
      diagnostic?.(`Análisis terminado: código ${code}, señal ${signal ?? 'ninguna'}`)
      if (code !== 0) {
        reject(new Error(cleanYtDlpError(stderr) || `yt-dlp exited with code ${code}`))
      } else {
        resolve(out)
      }
    })
  })

  let info: VideoInfo
  try {
    info = JSON.parse(stdout) as VideoInfo
  } catch {
    throw new Error('Could not parse video info from yt-dlp.')
  }

  return {info}
}

export type DownloadChoice = {
  label: string
  kind: 'video' | 'audio'
  args: string[]
}

const MAX_VIDEO_CHOICES = 8

export function buildChoices(info: VideoInfo): DownloadChoice[] {
  const formats = info.formats ?? []
  const choices: DownloadChoice[] = []

  const audioOnly = formats.filter(f => f.acodec && f.acodec !== 'none' && (!f.vcodec || f.vcodec === 'none'))
  const bestAudio = [...audioOnly].sort((a, b) => (b.abr ?? b.tbr ?? 0) - (a.abr ?? a.tbr ?? 0))[0]
  const audioSize = bestAudio?.filesize ?? bestAudio?.filesize_approx

  const videos = formats.filter(f => f.vcodec && f.vcodec !== 'none' && f.height)
  const heights = [...new Set(videos.map(f => f.height as number))].sort((a, b) => b - a)

  for (const height of heights.slice(0, MAX_VIDEO_CHOICES)) {
    const candidates = videos.filter(f => f.height === height)
    const best = [...candidates].sort((a, b) => scoreVideo(b) - scoreVideo(a))[0]
    const muxed = best.acodec && best.acodec !== 'none'
    const size = (best.filesize ?? best.filesize_approx ?? 0) + (muxed ? 0 : audioSize ?? 0)
    const sizeLabel = size > 0 ? ` · ~${formatBytes(size)}` : ''
    choices.push({
      kind: 'video',
      label: `${height}p · mp4${sizeLabel}`,
      args: [
        '-f',
        `bv*[height=${height}]+ba/b[height=${height}]/bv*[height<=${height}]+ba/b`,
        '--merge-output-format',
        'mp4',
      ],
    })
  }

  if (choices.length === 0) {
    choices.push({
      kind: 'video',
      label: 'best available · mp4',
      args: ['-f', 'bv*+ba/b', '--merge-output-format', 'mp4'],
    })
  }

  const audioSizeLabel = audioSize ? ` · ~${formatBytes(audioSize)}` : ''
  choices.push({
    kind: 'audio',
    label: `audio only · mp3${audioSizeLabel}`,
    args: ['-f', 'ba/b', '-x', '--audio-format', 'mp3', '--audio-quality', '0'],
  })

  return choices
}

function scoreVideo(f: RawFormat): number {
  let score = f.tbr ?? 0
  if (f.ext === 'mp4') score += 10_000
  if (f.vcodec?.startsWith('avc')) score += 5_000
  return score
}

export type DownloadProgress = {
  downloadedBytes: number
  totalBytes?: number
  speed?: number
  eta?: number
  part: number
  /** How many files this download resolves to (video+audio merges are 2). */
  totalParts: number
}

export type DownloadHandlers = {
  onProgress: (progress: DownloadProgress) => void
  onProcessing: () => void
  onDiagnostic?: Diagnostic
}

const PROGRESS_PREFIX = 'YOINK|'
const PROGRESS_TEMPLATE = `${PROGRESS_PREFIX}%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s|%(progress.speed)s|%(progress.eta)s`

let activeChild: ChildProcess | undefined
process.on('exit', () => activeChild?.kill('SIGTERM'))

export function download(
  opts: {
    ytdlp: string
    ffmpegLocation?: string
    url: string
    choice: DownloadChoice
    outDir: string
  },
  handlers: DownloadHandlers,
  signal?: AbortSignal,
): Promise<string> {
  if (!isProbablyUrl(opts.url)) return Promise.reject(new Error('Only HTTP and HTTPS URLs are supported.'))
  const args = [
    '--ignore-config',
    '--no-plugin-dirs',
    ...opts.choice.args,
    '--no-playlist',
    ...(handlers.onDiagnostic ? [] : ['--no-warnings']),
    '--newline',
    // --print implies --quiet, which suppresses progress bars and the
    // [Merger]/[ExtractAudio] lines we detect the processing phase from
    '--no-quiet',
    '--progress',
    '--progress-template',
    `download:${PROGRESS_TEMPLATE}`,
    '--print',
    'after_move:filepath',
    '--no-simulate',
    '-o',
    path.join(opts.outDir, '%(title).60s.%(ext)s'),
  ]
  if (opts.ffmpegLocation) args.push('--ffmpeg-location', opts.ffmpegLocation)

  args.push('--', opts.url)

  return new Promise((resolve, reject) => {
    const child = spawn(opts.ytdlp, args, {signal})
    activeChild = child

    let stderr = ''
    let filepath = ''
    let part = 0
    let totalParts = 1
    let lastDownloaded = 0
    let buffer = ''

    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString()
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const rawLine of lines) {
        const line = rawLine.trim()
        if (!line) continue
        if (line.startsWith(PROGRESS_PREFIX)) {
          const [downloaded, total, totalEstimate, speed, eta] = line.slice(PROGRESS_PREFIX.length).split('|')
          const downloadedBytes = toNumber(downloaded) ?? 0
          if (downloadedBytes < lastDownloaded) part++
          lastDownloaded = downloadedBytes
          handlers.onProgress({
            downloadedBytes,
            totalBytes: toNumber(total) ?? toNumber(totalEstimate),
            speed: toNumber(speed),
            eta: toNumber(eta),
            part,
            totalParts,
          })
        } else if (line.includes('Downloading 1 format(s):')) {
          // "[info] xxx: Downloading 1 format(s): 395+251" — each id is one file
          totalParts = (line.split('format(s):')[1] ?? '').trim().split('+').length
        } else if (line.includes('[Merger]') || line.includes('[ExtractAudio]')) {
          handlers.onProcessing()
        } else if (path.isAbsolute(line)) {
          filepath = line
        }
      }
    })
    child.stderr.on('data', chunk => {
      stderr = (stderr + chunk).slice(-32768)
      handlers.onDiagnostic?.(`yt-dlp: ${String(chunk).trim()}`)
    })
    child.on('error', error => { handlers.onDiagnostic?.(`yt-dlp: ${error.message}`); reject(error) })
    child.on('close', (code, signalName) => {
      handlers.onDiagnostic?.(`Descarga terminada: código ${code}, señal ${signalName ?? 'ninguna'}`)
      activeChild = undefined
      if (signal?.aborted) {
        // Preserve partial files: subprocess output is not authority to delete paths.
        reject(new Error('Download cancelled.'))
        return
      }
      if (code === 0 && filepath) {
        resolve(filepath)
      } else {
        reject(new Error(cleanYtDlpError(stderr) || `Download failed (yt-dlp exit code ${code}).`))
      }
    })
  })
}

function toNumber(value: string | undefined): number | undefined {
  if (!value || value === 'NA' || value === 'None') return undefined
  const n = Number.parseFloat(value)
  return Number.isFinite(n) ? n : undefined
}

function cleanYtDlpError(stderr: string): string {
  const lines = stderr
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.startsWith('ERROR:'))
  const last = lines.at(-1)
  return last ? last.replace(/^ERROR:\s*(\[[^\]]+\]\s*)?/, '') : ''
}
