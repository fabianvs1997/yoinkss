import os from 'node:os'

/** Diagnostics remain in memory. Remove complete URLs and terminal control sequences. */
export function redactDiagnostic(value: string): string {
  return value
    .replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/g, '')
    .replace(/https?:\/\/[^\s<>"']+/gi, '[URL omitida]')
    .replace(/\bBearer\s+[^\s]+/gi, 'Bearer [omitido]')
    .split(os.homedir()).join('~')
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')
    .slice(0, 2000)
}

export class Diagnostics {
  private entries: string[] = []
  constructor(private sink: (line: string) => void = line => console.error(line)) {}
  add(message: string) {
    const line = `[${new Date().toISOString()}] ${redactDiagnostic(message)}`
    this.entries.push(line)
    if (this.entries.length > 100) this.entries.shift()
    this.sink(line)
  }
  snapshot() { return [...this.entries] }
}
