/* =================================================================
   Control de Asistencia Docente — app.js
   Todo el procesamiento es LOCAL. No hay backend ni envío a la nube.
   La imagen del documento NO se almacena: se procesa en memoria y se
   descarta tras el OCR.
   ================================================================= */

'use strict';

/* ---------- Configuración del matching (ajustable) ---------- */
const UMBRAL_VERDE   = 0.30; // score Fuse <= => coincidencia clara
const SEPARACION_MIN = 0.16; // distancia mínima al 2º candidato para auto
const UMBRAL_AMARILLO= 0.55; // score Fuse <= => dudoso (muestra candidatos)
// Por encima de UMBRAL_AMARILLO => rojo (sin coincidencia)

const GRUPOS = ['AI', 'B', 'C', 'V'];
const LS_ALUMNOS = 'asist_alumnos_v1';
const LS_ASIST   = 'asist_registros_v1';

/* ---------- Estado ---------- */
let alumnos = [];          // base única: {nombre,apellidos,usuario,id,email,grupo,_full,_rev}
let asistencias = [];      // registros
let fuse = null;
let stream = null;
let facing = 'environment';
let ocrWorker = null;
let audioCtx = null;

/* ---------- Utilidades ---------- */
const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);

function norm(str){
  return (str || '')
    .toString()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // quita acentos
    .toLowerCase().replace(/\s+/g, ' ').trim();
}
function soloDigitos(s){ return (s || '').replace(/\D/g, ''); }

function hoy(){
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}`;
}
function ahora(){
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

let toastTimer;
function toast(msg, ms = 2600){
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

/* ---------- Navegación entre pantallas ---------- */
function showScreen(id){
  $$('.screen').forEach(s => s.classList.remove('active'));
  $('#' + id).classList.add('active');
  if (id === 'screen-escaneo') startCamera(); else stopCamera();
}

/* ---------- Almacenamiento local ---------- */
function guardar(){
  localStorage.setItem(LS_ALUMNOS, JSON.stringify(alumnos));
  localStorage.setItem(LS_ASIST, JSON.stringify(asistencias));
}
function cargarEstado(){
  try { alumnos = JSON.parse(localStorage.getItem(LS_ALUMNOS)) || []; } catch { alumnos = []; }
  try { asistencias = JSON.parse(localStorage.getItem(LS_ASIST)) || []; } catch { asistencias = []; }
  reindexar();
  actualizarContadores();
}

/* ---------- Detección flexible de columnas ---------- */
function detectarColumnas(campos){
  const map = { nombre:null, apellidos:null, usuario:null, id:null, email:null };
  campos.forEach((raw) => {
    const h = norm(raw);
    if (h.includes('usuario')) map.usuario = raw;
    else if (h.includes('apellido')) map.apellidos = raw;
    else if (h.includes('nombre')) map.nombre = raw;
    else if (h.includes('correo') || h.includes('email') || h.includes('e-mail')) map.email = raw;
    else if (h.includes('id')) map.id = raw;          // "Número de ID"
    else if (h.includes('grupo')) map._grupo = raw;   // por si trae grupo propio
  });
  return map;
}

/* ---------- Carga de un CSV de grupo ---------- */
function cargarCSV(file, grupo){
  Papa.parse(file, {
    header: true,
    skipEmptyLines: true,
    transformHeader: (h) => h.trim(),
    complete: (res) => {
      const campos = res.meta.fields || [];
      const col = detectarColumnas(campos);
      if (!col.nombre && !col.apellidos){
        toast(`Grupo ${grupo}: no se reconocen las columnas. Revisa las cabeceras.`);
        return;
      }
      // elimina alumnos previos de ESTE grupo (recarga limpia)
      alumnos = alumnos.filter(a => a.grupo !== grupo);

      let n = 0;
      res.data.forEach((fila) => {
        const nombre    = (fila[col.nombre]    || '').trim();
        const apellidos = (fila[col.apellidos] || '').trim();
        const usuario   = (fila[col.usuario]   || '').trim();
        const id        = (fila[col.id]        || '').trim();
        let   email     = (col.email ? (fila[col.email] || '').trim() : '');
        if (!email && usuario.includes('@')) email = usuario; // UV: usuario suele ser correo
        if (!nombre && !apellidos) return;
        alumnos.push({
          nombre, apellidos, usuario, id, email, grupo,
          _full: norm(nombre + ' ' + apellidos),
          _rev:  norm(apellidos + ' ' + nombre),
          _id:   soloDigitos(id),
        });
        n++;
      });

      marcarGrupoCargado(grupo, n);
      reindexar();
      guardar();
      actualizarContadores();
      validarBotonEmpezar();
      toast(`Grupo ${grupo}: ${n} alumnos cargados.`);
    },
    error: (err) => toast(`Error leyendo CSV ${grupo}: ${err.message}`),
  });
}

function marcarGrupoCargado(grupo, n){
  const loader = document.querySelector(`.grupo-loader[data-grupo="${grupo}"]`);
  const state  = document.querySelector(`.grupo-state[data-state="${grupo}"]`);
  if (loader) loader.classList.add('loaded');
  if (state)  state.textContent = `${n} alumnos`;
}

/* ---------- Índice Fuse ---------- */
function reindexar(){
  fuse = new Fuse(alumnos, {
    keys: ['_full', '_rev', 'nombre', 'apellidos'],
    includeScore: true,
    ignoreLocation: true,
    threshold: 0.6,
    minMatchCharLength: 3,
  });
}

function actualizarContadores(){
  $('#dbCount').textContent = `${alumnos.length} alumnos`;
  // refleja grupos ya cargados al reabrir la app
  GRUPOS.forEach(g => {
    const n = alumnos.filter(a => a.grupo === g).length;
    if (n > 0) marcarGrupoCargado(g, n);
  });
}

function validarBotonEmpezar(){
  $('#btnIrEscaneo').disabled = alumnos.length === 0;
}

/* ---------- Cámara ---------- */
async function startCamera(){
  stopCamera();
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: facing, width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
    $('#video').srcObject = stream;
  } catch (e) {
    toast('No se pudo acceder a la cámara. Usa HTTPS y concede permisos. ' + e.message, 5000);
  }
}
function stopCamera(){
  if (stream){ stream.getTracks().forEach(t => t.stop()); stream = null; }
}

/* ---------- OCR (Tesseract.js) ---------- */
function setOcr(msg){
  const el = $('#ocrStatus');
  if (!msg){ el.hidden = true; return; }
  el.hidden = false; el.textContent = msg;
}

async function getWorker(){
  if (ocrWorker) return ocrWorker;
  setOcr('Cargando modelo OCR (solo la 1ª vez; requiere internet)…');
  ocrWorker = await Tesseract.createWorker('spa', 1, {
    logger: (m) => {
      if (m.status === 'recognizing text')
        setOcr('Leyendo documento… ' + Math.round(m.progress * 100) + '%');
    },
  });
  return ocrWorker;
}

async function capturarYProcesar(){
  const video = $('#video');
  if (!video.videoWidth){ toast('La cámara aún no está lista.'); return; }

  const canvas = $('#canvas');
  canvas.width  = video.videoWidth;
  canvas.height = video.videoHeight;
  canvas.getContext('2d').drawImage(video, 0, 0);

  setOcr('Procesando imagen…');
  let texto = '';
  try {
    const worker = await getWorker();
    const { data } = await worker.recognize(canvas);
    texto = data.text || '';
  } catch (e) {
    setOcr(); toast('Fallo de OCR: ' + e.message, 4000); return;
  } finally {
    // No se guarda la imagen: limpiamos el canvas.
    canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
  }
  setOcr();
  analizarTexto(texto);
}

/* ---------- Extracción de nombre / ID del texto OCR ---------- */
function extraerCandidatoTexto(texto){
  const lineas = texto.split(/\n+/)
    .map(l => l.replace(/[^A-Za-zÁÉÍÓÚÜÑáéíóúüñ ]/g, ' ').replace(/\s+/g, ' ').trim())
    .filter(l => l.replace(/\s/g, '').length >= 3);
  // descarta etiquetas típicas del DNI
  const ruido = ['dni','documento','nacional','identidad','espana','espa','reino','apellidos','nombre','sexo','nacionalidad','validez','soporte','can','idesp'];
  const utiles = lineas.filter(l => {
    const nl = norm(l);
    return !ruido.some(r => nl === r || nl.startsWith(r + ' '));
  });
  // las 1-3 líneas alfabéticas más largas suelen ser apellidos + nombre
  utiles.sort((a, b) => b.length - a.length);
  return utiles.slice(0, 3).join(' ').trim();
}
function extraerIds(texto){
  return (texto.match(/\d{5,}/g) || []).map(soloDigitos);
}

/* ---------- Análisis y decisión (semáforo) ---------- */
function analizarTexto(texto){
  if (!alumnos.length){ mostrarRojo('Sin alumnos', 'Carga los CSV primero.', ''); return; }

  // 1) Coincidencia por Número de ID (señal fuerte)
  const ids = extraerIds(texto);
  for (const idTok of ids){
    const exactos = alumnos.filter(a => a._id && a._id === idTok);
    if (exactos.length === 1){
      decidir(exactos[0], 98, 'auto'); return;
    }
  }

  // 2) Coincidencia difusa por nombre
  const query = extraerCandidatoTexto(texto);
  if (!query){ mostrarRojo('Sin lectura', 'No se ha podido leer texto del documento.', texto); return; }

  const res = fuse.search(query).slice(0, 5);
  if (!res.length){ mostrarRojo('Sin coincidencia', 'No hay ningún alumno que coincida.', query); return; }

  const best = res[0];
  const second = res[1];
  const conf = Math.round((1 - best.score) * 100);

  const claro = best.score <= UMBRAL_VERDE &&
                (!second || (second.score - best.score) >= SEPARACION_MIN);

  if (claro){
    decidir(best.item, conf, 'auto');
  } else if (best.score <= UMBRAL_AMARILLO){
    mostrarAmarillo(res.slice(0, 3));
  } else {
    mostrarRojo('Sin coincidencia', 'La lectura no encaja con ningún alumno.', query);
  }
}

/* Comprueba duplicados antes de registrar */
function yaRegistrado(al){
  const f = hoy();
  const clave = al.id || al.usuario || (al.nombre + al.apellidos);
  return asistencias.some(r => r.fecha === f && r.grupo === al.grupo &&
    (r.id || r.usuario || (r.nombre + r.apellidos)) === clave);
}

/* Punto de decisión común: registra o avisa de duplicado */
function decidir(al, conf, modo){
  if (yaRegistrado(al)){
    mostrarAviso(al);
    return;
  }
  registrar(al, conf, modo);
  mostrarVerde(al, conf);
}

/* ---------- Registro de asistencia ---------- */
function registrar(al, conf, modo){
  asistencias.push({
    fecha: hoy(), hora: ahora(), grupo: al.grupo,
    nombre: al.nombre, apellidos: al.apellidos,
    usuario: al.usuario, id: al.id, email: al.email,
    confianza: conf, modo_validacion: modo,
  });
  guardar();
  actualizarContadores();
}

/* ---------- Pantallas de resultado (semáforo) ---------- */
function abrirResultado(clase){
  const r = $('#resultado');
  r.className = 'resultado ' + clase;
  r.hidden = false;
  $('#resCandidatos').hidden = true;
  $('#resCandidatos').innerHTML = '';
}
function cerrarResultado(){ $('#resultado').hidden = true; }

function mostrarVerde(al, conf){
  abrirResultado('verde');
  $('#resIcon').textContent = '✓';
  $('#resTitulo').textContent = 'Asistencia registrada';
  $('#resNombre').textContent = `${al.nombre} ${al.apellidos}`;
  $('#resMeta').textContent = `Grupo ${al.grupo} · confianza ${conf}%`;
  beepOk(); vibrar([60, 40, 120]);
}

function mostrarAmarillo(resultados){
  abrirResultado('amarillo');
  $('#resIcon').textContent = '?';
  $('#resTitulo').textContent = 'Coincidencia dudosa';
  $('#resNombre').textContent = 'Confirma el alumno';
  $('#resMeta').textContent = 'Pulsa el candidato correcto:';
  const cont = $('#resCandidatos');
  cont.hidden = false;
  resultados.forEach((r) => {
    const al = r.item;
    const conf = Math.round((1 - r.score) * 100);
    const div = document.createElement('div');
    div.className = 'candidato';
    div.innerHTML = `<div><div class="c-nombre">${al.nombre} ${al.apellidos}</div>
        <div class="c-sub">${al.usuario || al.id || ''} · ${conf}%</div></div>
        <span class="c-grupo">${al.grupo}</span>`;
    div.addEventListener('click', () => {
      cerrarResultado();
      if (yaRegistrado(al)){ mostrarAviso(al); return; }
      registrar(al, conf, 'manual_confirmado');
      mostrarVerde(al, conf);
    });
    cont.appendChild(div);
  });
  beepOk(false); vibrar([120]);
}

function mostrarRojo(titulo, meta, debug){
  abrirResultado('rojo');
  $('#resIcon').textContent = '✕';
  $('#resTitulo').textContent = titulo;
  $('#resNombre').textContent = 'No reconocido';
  $('#resMeta').textContent = meta;
  const cont = $('#resCandidatos');
  cont.hidden = false;
  const b = document.createElement('div');
  b.className = 'candidato';
  b.innerHTML = `<div class="c-nombre">🔎 Buscar manualmente</div>`;
  b.addEventListener('click', () => { cerrarResultado(); abrirManual(); });
  cont.appendChild(b);
  beepError(); vibrar([200, 80, 200]);
}

function mostrarAviso(al){
  abrirResultado('aviso');
  $('#resIcon').textContent = '!';
  $('#resTitulo').textContent = 'Ya registrado hoy';
  $('#resNombre').textContent = `${al.nombre} ${al.apellidos}`;
  $('#resMeta').textContent = `Grupo ${al.grupo} · no se duplica`;
  beepError(); vibrar([90, 60, 90]);
}

/* ---------- Búsqueda manual ---------- */
function abrirManual(){
  stopCamera();
  showScreen('screen-manual');
  $('#manualInput').value = '';
  $('#manualResultados').innerHTML = '';
  setTimeout(() => $('#manualInput').focus(), 150);
}
function buscarManual(){
  const q = $('#manualInput').value.trim();
  const cont = $('#manualResultados');
  cont.innerHTML = '';
  if (q.length < 2) return;
  const res = fuse.search(norm(q)).slice(0, 8);
  res.forEach((r) => {
    const al = r.item;
    const item = document.createElement('div');
    item.className = 'item';
    item.innerHTML = `<div><div class="i-nombre">${al.nombre} ${al.apellidos}</div>
        <div class="i-sub">${al.usuario || al.id || ''}</div></div>
        <span class="c-grupo">${al.grupo}</span>`;
    item.addEventListener('click', () => {
      if (yaRegistrado(al)){ mostrarAviso(al); return; }
      registrar(al, 100, 'manual_busqueda');
      mostrarVerde(al, 100);
    });
    cont.appendChild(item);
  });
}

/* ---------- Registro: lista, filtro y export ---------- */
function refrescarFiltroFechas(){
  const sel = $('#filtroFecha');
  const fechas = [...new Set(asistencias.map(r => r.fecha))].sort().reverse();
  if (!fechas.length){ sel.innerHTML = '<option>— sin registros —</option>'; return; }
  sel.innerHTML = fechas.map(f => `<option value="${f}">${f}</option>`).join('');
}
function refrescarListaAsistencia(){
  const f = $('#filtroFecha').value;
  const filas = asistencias.filter(r => r.fecha === f)
    .sort((a, b) => b.hora.localeCompare(a.hora));
  $('#asistCount').textContent = filas.length;
  const cont = $('#listaAsistencia');
  cont.innerHTML = '';
  filas.forEach((r) => {
    const item = document.createElement('div');
    item.className = 'item';
    item.innerHTML = `<div><div class="i-nombre">${r.nombre} ${r.apellidos}</div>
        <div class="i-sub">${r.hora} · ${r.modo_validacion} · ${r.confianza}%</div></div>
        <span class="c-grupo">${r.grupo}</span>`;
    cont.appendChild(item);
  });
}
function abrirAsistencia(){
  stopCamera();
  showScreen('screen-asistencia');
  refrescarFiltroFechas();
  refrescarListaAsistencia();
}
function exportarCSV(){
  if (!asistencias.length){ toast('No hay asistencias que exportar.'); return; }
  const columnas = ['fecha','hora','grupo','nombre','apellidos','usuario','id','email','confianza','modo_validacion'];
  const csv = Papa.unparse({ fields: columnas, data: asistencias.map(r => columnas.map(c => r[c])) });
  const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `asistencia_${hoy()}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

/* ---------- Audio (Web Audio API, sin archivos externos) ---------- */
function unlockAudio(){
  if (!audioCtx){
    const AC = window.AudioContext || window.webkitAudioContext;
    if (AC) audioCtx = new AC();
  }
  if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
}
function tono(freq, t0, dur, type = 'sine', vol = 0.2){
  if (!audioCtx) return;
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.type = type; osc.frequency.value = freq;
  gain.gain.setValueAtTime(vol, audioCtx.currentTime + t0);
  gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + t0 + dur);
  osc.connect(gain).connect(audioCtx.destination);
  osc.start(audioCtx.currentTime + t0);
  osc.stop(audioCtx.currentTime + t0 + dur);
}
function beepOk(doble = true){ unlockAudio(); tono(660, 0, 0.12); if (doble) tono(990, 0.13, 0.16); }
function beepError(){ unlockAudio(); tono(200, 0, 0.35, 'square', 0.25); }

/* ---------- Vibración (no soportada en iPhone) ---------- */
function vibrar(patron){ if (navigator.vibrate) { try { navigator.vibrate(patron); } catch {} } }

/* ---------- Borrados ---------- */
function borrarTodo(){
  if (!confirm('¿Borrar TODOS los alumnos y asistencias de este dispositivo?')) return;
  alumnos = []; asistencias = [];
  localStorage.removeItem(LS_ALUMNOS);
  localStorage.removeItem(LS_ASIST);
  reindexar();
  $$('.grupo-loader').forEach(l => l.classList.remove('loaded'));
  $$('.grupo-state').forEach(s => s.textContent = 'Sin cargar');
  actualizarContadores(); validarBotonEmpezar();
  toast('Datos borrados.');
}
function borrarDia(){
  const f = $('#filtroFecha').value;
  if (!f) return;
  if (!confirm(`¿Borrar las asistencias del ${f}?`)) return;
  asistencias = asistencias.filter(r => r.fecha !== f);
  guardar(); refrescarFiltroFechas(); refrescarListaAsistencia(); actualizarContadores();
  toast('Día borrado.');
}

/* ---------- Conexión de eventos ---------- */
function init(){
  // carga CSV
  $$('.grupo-loader input[type=file]').forEach((inp) => {
    inp.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (file) cargarCSV(file, inp.dataset.grupo);
    });
  });

  $('#btnIrEscaneo').addEventListener('click', () => { unlockAudio(); showScreen('screen-escaneo'); });
  $('#btnBorrarDatos').addEventListener('click', borrarTodo);
  $('#navConfig').addEventListener('click', () => showScreen('screen-carga'));
  $('#navAsistencia').addEventListener('click', abrirAsistencia);

  // escaneo
  $('#btnCapturar').addEventListener('click', () => { unlockAudio(); capturarYProcesar(); });
  $('#btnCambiarCam').addEventListener('click', () => {
    facing = (facing === 'environment') ? 'user' : 'environment';
    startCamera();
  });
  $('#btnBuscarManual').addEventListener('click', abrirManual);

  // resultado
  $('#btnSeguir').addEventListener('click', () => { cerrarResultado(); showScreen('screen-escaneo'); });

  // manual
  $('#manualInput').addEventListener('input', buscarManual);
  $('#btnCerrarManual').addEventListener('click', () => showScreen('screen-escaneo'));

  // asistencia
  $('#filtroFecha').addEventListener('change', refrescarListaAsistencia);
  $('#btnExportar').addEventListener('click', exportarCSV);
  $('#btnBorrarDia').addEventListener('click', borrarDia);
  $('#btnVolverEscaneo').addEventListener('click', () => showScreen('screen-escaneo'));

  cargarEstado();
  validarBotonEmpezar();

  // service worker (PWA offline)
  if ('serviceWorker' in navigator){
    navigator.serviceWorker.register('service-worker.js').catch(() => {});
  }
}

document.addEventListener('DOMContentLoaded', init);
