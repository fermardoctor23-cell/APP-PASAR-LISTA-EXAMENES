# Control de Asistencia Docente (PWA local)

Pasa lista escaneando el documento del alumno. **Todo el procesamiento ocurre en el navegador**: OCR, matching y almacenamiento. No hay backend, no se envían datos a la nube y **no se guarda la imagen del documento**.

## Archivos

```
index.html          Pantallas (carga · cámara · resultado · manual · registro)
styles.css          Estilos mobile-first + semáforo verde/amarillo/rojo
app.js              Lógica: CSV, cámara, OCR, matching difuso, asistencia, export
manifest.json       Manifiesto PWA (instalable)
service-worker.js   Cacheo offline del shell y librerías
icons/              icon-192.png, icon-512.png
ejemplos_csv/       grupo_AI.csv, grupo_B.csv, grupo_C.csv, grupo_V.csv
```

Librerías locales en navegador, cargadas por CDN la primera vez y luego cacheadas: **PapaParse** (CSV), **Fuse.js** (matching difuso) y **Tesseract.js** (OCR).

## Cómo probarlo

La cámara y el service worker exigen un **contexto seguro**: `https://` o `http://localhost`. Abrir el `index.html` con doble clic (`file://`) **no funcionará** para la cámara.

**Opción A — local en el ordenador (rápido):**
```bash
cd asistencia
python3 -m http.server 8000
# Abre http://localhost:8000  (localhost cuenta como seguro)
```

**Opción B — en el móvil (recomendada):** publica la carpeta en **GitHub Pages** (HTTPS gratis) y abre la URL en el iPhone/Android. Luego *Añadir a pantalla de inicio* para instalarla como PWA.

### Flujo de uso
1. En **Cargar grupos**, asigna cada CSV a su grupo (AI, B, C, V). El grupo lo determina **el recuadro donde sueltas el archivo**, no el contenido del CSV.
2. Pulsa **Empezar a pasar lista** → se abre la cámara.
3. Encuadra el documento en el marco y pulsa el botón redondo.
4. Resultado:
   - 🟢 **Verde**: coincidencia clara → registra solo, sonido y vibración.
   - 🟡 **Amarillo**: dudoso → muestra los 3 candidatos más probables con su grupo; confirmas tú.
   - 🔴 **Rojo**: sin coincidencia → opción de búsqueda manual por nombre/apellidos.
   - 🟠 **Aviso**: ese alumno ya estaba registrado hoy (no se duplica).
5. En **📋 Registro** filtras por fecha y pulsas **Exportar CSV**.

## Formato del CSV

Cabeceras detectadas de forma flexible (se ignoran acentos y mayúsculas):

| Campo interno | Cabeceras reconocidas |
|---|---|
| nombre | contiene «nombre» (sin «usuario») |
| apellidos | contiene «apellido» |
| usuario | contiene «usuario» |
| id | contiene «id» (p. ej. «Número de ID») |
| email | contiene «correo», «email» o «e-mail» |

Si no hay columna de correo pero el «Nombre de usuario» contiene `@`, se usa como email. El export de asistencia siempre tiene estas columnas, en este orden:

```
fecha,hora,grupo,nombre,apellidos,usuario,id,email,confianza,modo_validacion
```

`modo_validacion` puede ser: `auto`, `manual_confirmado` (candidato amarillo) o `manual_busqueda`.

## Ajuste del matching

En `app.js`, parte superior:

```js
const UMBRAL_VERDE    = 0.30; // más bajo = más estricto para el verde automático
const SEPARACION_MIN  = 0.16; // distancia mínima al 2º candidato para auto
const UMBRAL_AMARILLO = 0.55; // por encima => rojo
```

Hay además una vía de match fuerte: si el OCR lee un número de ≥5 dígitos que coincide **exacto y único** con un «Número de ID», se valida en verde con 98 % directamente.

## Notas por plataforma

- **iPhone**: la vibración (`navigator.vibrate`) **no está soportada** en Safari/iOS; el resto funciona. La cámara en PWA instalada requiere **iOS 16.4 o superior**; en versiones previas, úsala desde Safari. El audio se «desbloquea» con el primer toque (por eso suena a partir de pulsar un botón).
- **Tesseract**: la **primera lectura** descarga el modelo de español (`spa.traineddata`, ~10–15 MB) y necesita internet; después queda cacheado para uso offline.
- **OCR de DNI**: la lectura del DNI español no es perfecta (tipografías, brillos, hologramas). El sistema combina nombre y número de ID y, ante la duda, te muestra candidatos en amarillo en lugar de arriesgar un registro erróneo. Buena luz y encuadre llenando el marco mejoran mucho el acierto.

---

## ⚠️ Advertencias RGPD / LOPDGDD

Esta herramienta trata **datos personales** (identidad de los alumnos y, momentáneamente, la imagen de un documento de identidad). Aunque el diseño es *privacy-by-design*, su uso real con alumnos exige cumplir el RGPD (UE 2016/679) y la LOPDGDD (LO 3/2018). Puntos clave:

1. **Base de licitud y responsable.** El responsable del tratamiento es tu institución (Universitat de València), no tú a título personal. Antes de usarla, confirma con la **Delegación de Protección de Datos (DPD)** la base jurídica del control de asistencia y que esta herramienta encaja en ella. No la despliegues por tu cuenta para tratar datos de alumnos sin ese visto bueno.

2. **Minimización y proporcionalidad.** Capturar la imagen de un documento de identidad para pasar lista puede considerarse **excesivo**: a menudo basta con el carnet universitario, una lista en pantalla o un código. Valora si el OCR del DNI es realmente necesario o si una **búsqueda manual / selección en lista** cumple el fin con menor intrusión.

3. **La imagen no se almacena.** La app procesa el fotograma en memoria y limpia el lienzo tras el OCR; nunca lo guarda ni lo envía. Aun así, informa a los alumnos de que **no se conserva** la imagen.

4. **Datos que sí se guardan.** En `localStorage` de **este dispositivo** quedan la base de alumnos y los registros de asistencia. Protege el dispositivo (bloqueo de pantalla), no lo compartas y **borra los datos** (botón «Borrar todo») cuando ya no los necesites. Establece un plazo de conservación y respétalo.

5. **Información a los interesados.** Los alumnos deben ser informados (fin, responsable, base jurídica, conservación, derechos ARSULIPO) antes del tratamiento. Coordínalo con la cláusula informativa de tu universidad.

6. **Documento de identidad de terceros.** Tratar el DNI conlleva mayor riesgo. Limita el uso, evita mostrar el número en pantalla más de lo imprescindible y considera **no usar el DNI** y sí el carnet universitario o el listado de matrícula.

7. **Exportaciones.** El CSV exportado contiene datos personales: trátalo como un fichero confidencial (cifrado/almacenamiento seguro) y no lo difundas por canales no autorizados.

8. **No es asesoramiento jurídico.** Esto es una guía técnica orientativa. Para el cumplimiento formal (evaluación de impacto si procede, registro de actividades, cláusulas) consulta a la **DPD de la Universitat de València**.

> Recomendación práctica: como MVP de aula, el modo más conforme es **cargar los grupos y usar la búsqueda manual / selección en lista** para registrar asistencia, reservando el OCR del documento solo si la DPD confirma que es proporcionado.
