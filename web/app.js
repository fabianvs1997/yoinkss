'use strict';
const $ = id => document.getElementById(id);
const fragment = location.hash.slice(1);
if (fragment) sessionStorage.setItem('yoinkss-session', fragment);
const token = fragment || sessionStorage.getItem('yoinkss-session') || '';
history.replaceState(null, '', '/');
let state = {phase: 'idle'};
let selected = 0;
let choicesKey = '';
let pending = false;
let connected = false;
let revision = 0;
let lastError = '';
let logText = '';
const busy = () => ['probing', 'downloading', 'processing'].includes(state.phase);
const bytes = n => {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(3, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i ? 1 : 0)} ${units[i]}`;
};
const duration = n => `${Math.floor(n / 60)}:${String(Math.floor(n % 60)).padStart(2, '0')}`;
function notice(message = '') { $('notice').textContent = message; $('notice').hidden = !message; }
async function api(path, data) {
  const response = await fetch(`/api/${path}`, {
    method: data === undefined ? 'GET' : 'POST',
    headers: {Authorization: `Bearer ${token}`, ...(data === undefined ? {} : {'Content-Type': 'application/json'})},
    ...(data === undefined ? {} : {body: JSON.stringify(data)}),
    signal: AbortSignal.timeout(15000),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'No se pudo completar la solicitud.');
  return result;
}
function render() {
  $('analyze').disabled = !connected || pending || busy();
  $('url').disabled = pending || busy();
  $('analyze').firstChild.textContent = state.phase === 'probing' ? 'Analizando… ' : 'Analizar enlace ';
  if (state.outDir) $('out-dir').textContent = state.outDir;
  $('result').hidden = !state.title;
  $('picker').hidden = state.phase !== 'ready';
  $('video-title').textContent = state.title || '';
  $('video-meta').textContent = [state.uploader, state.duration ? duration(state.duration) : ''].filter(Boolean).join(' · ');
  const key = JSON.stringify([state.url, state.choices]);
  if (state.choices && key !== choicesKey) {
    choicesKey = key;
    selected = 0;
    $('choices').replaceChildren();
    state.choices.forEach((choice, index) => {
      const button = document.createElement('button');
      button.type = 'button'; button.className = 'choice';
      button.setAttribute('aria-pressed', String(index === selected));
      const title = document.createElement('strong');
      const detail = document.createElement('small');
      const parts = choice.label.split(' · ');
      title.textContent = choice.kind === 'audio' ? 'Solo audio' : parts[0] === 'best available' ? 'Mejor calidad' : parts[0];
      detail.textContent = [choice.kind === 'audio' ? 'MP3' : 'MP4', parts[2]].filter(Boolean).join(' · ');
      button.append(title, detail);
      button.addEventListener('click', () => {
        selected = index;
        [...$('choices').children].forEach((item, i) => item.setAttribute('aria-pressed', String(i === selected)));
      });
      $('choices').append(button);
    });
  }
  $('download').disabled = pending || !connected || state.phase !== 'ready';
  $('activity').hidden = !['probing', 'downloading', 'processing', 'done', 'cancelled'].includes(state.phase);
  $('cancel').hidden = !busy(); $('cancel').disabled = pending || !connected;
  $('file-path').textContent = state.phase === 'done' ? state.filepath || '' : '';
  $('progress').hidden = ['done', 'cancelled'].includes(state.phase);
  const labels = {probing: 'Buscando formatos disponibles…', downloading: 'Guardando tu archivo…', processing: 'Preparando el archivo final…', done: '✓ Tu archivo está listo', cancelled: 'Descarga cancelada'};
  $('activity-label').textContent = labels[state.phase] || '';
  const p = state.progress;
  if (state.phase === 'downloading' && p) {
    const percent = p.totalBytes ? Math.min(100, Math.max(0, p.downloadedBytes / p.totalBytes * 100)) : null;
    if (percent === null) $('progress').removeAttribute('value'); else $('progress').value = percent;
    $('activity-detail').textContent = [percent === null ? bytes(p.downloadedBytes) : `${Math.round(percent)}% · ${bytes(p.downloadedBytes)} de ${bytes(p.totalBytes)}`, p.speed ? `${bytes(p.speed)}/s` : '', p.eta ? `${duration(p.eta)} restantes` : '', p.totalParts > 1 ? `Parte ${p.part + 1} de ${p.totalParts}` : ''].filter(Boolean).join(' · ');
  } else {
    $('progress').removeAttribute('value');
    const details = {probing: 'Conectando con el sitio. Esto puede tardar unos segundos.', downloading: 'Iniciando la descarga…', processing: 'Uniendo video y audio o convirtiendo a MP3.', done: 'Lo encontrarás en tu carpeta de descargas.', cancelled: 'Los archivos parciales se conservan. Puedes volver a analizar el enlace.'};
    $('activity-detail').textContent = details[state.phase] || '';
  }
  const nextLogs = (state.logs || []).join('\n');
  if (nextLogs !== logText) {
    const output = $('log-output');
    const atBottom = output.scrollHeight - output.scrollTop - output.clientHeight < 30;
    logText = nextLogs;
    output.textContent = logText || 'Todavía no hay eventos. Analiza un enlace para comenzar.';
    if (atBottom) output.scrollTop = output.scrollHeight;
  }
  if (state.phase === 'error') {
    notice(state.error);
    if (state.error !== lastError) $('diagnostics').open = true;
    lastError = state.error;
  } else lastError = '';

}
async function action(path, data) {
  if (pending) return;
  ++revision;
  pending = true; notice(); render();
  try { state = {...await api(path, data), outDir: state.outDir}; }
  catch (error) { notice(error.message); }
  finally { pending = false; render(); }
}
$('url-form').addEventListener('submit', event => {
  event.preventDefault();
  const value = $('url').value.trim();
  try { if (!['http:', 'https:'].includes(new URL(value).protocol)) throw new Error(); }
  catch { notice('Pega un enlace que empiece con http:// o https://.'); return; }
  void action('analyze', {url: value});
});
$('download').addEventListener('click', () => void action('download', {index: selected}));
$('copy-logs').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(logText || 'No hay eventos registrados.');
    $('copy-status').textContent = 'Copiado';
  } catch {
    const range = document.createRange();
    range.selectNodeContents($('log-output'));
    const selection = window.getSelection();
    selection.removeAllRanges(); selection.addRange(range);
    $('copy-status').textContent = 'Seleccionado. Usa Ctrl+C para copiar.';
  }
});
$('cancel').addEventListener('click', () => void action('cancel', {}));
async function poll() {
  if (!pending) {
    try {
      const requestedRevision = revision;
      const next = await api('state');
      if (requestedRevision !== revision) { setTimeout(poll, 900); return; }
      state = next;
      if (!connected) notice();
      connected = true; render();
    } catch (error) {
      connected = false; render();
      notice(error.name === 'TypeError' ? 'Se perdió la conexión. Comprueba que la terminal siga abierta y vuelve a abrir el enlace de sesión.' : error.message);
    }
  }
  setTimeout(poll, 900);
}
render();
if (token) void poll();
else notice('Abre el enlace completo que aparece al ejecutar npm run gui en la terminal.');
