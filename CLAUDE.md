# print-server — Mecatos el Santi

Contexto específico del paquete `print-server/` (servicio local de
impresión térmica ESC/POS — corre en la terminal física con la impresora
USB, NO en la nube). Lee primero el `CLAUDE.md` de la raíz del repo. Este
paquete ya tiene su propio `README.md` con el detalle operativo completo
(instalación, troubleshooting, cómo fijar un vendor/product id, variables
de entorno) y `docs/THERMAL_PRINTER_INTEGRATION.md` con el diseño completo
del lado del frontend — este archivo solo tiene las advertencias que un
agente de IA no debería repetir si vuelve a tocar este código. El número
de punto es el mismo que en el `CLAUDE.md` raíz (no se renumeró al
dividir el documento).

### 32. Impresión térmica: `print-server/` es un paquete aparte, y usa `@node-escpos/*`, no `escpos`/`escpos-usb`

Ver `docs/THERMAL_PRINTER_INTEGRATION.md` para el diseño completo — acá
solo los puntos que no son obvios leyendo el código:

- **`print-server/` (raíz del repo, junto a `backend`/`admin-frontend`/
  `pos-frontend`) es un paquete Express totalmente aparte de `backend/`**,
  pensado para correr en la máquina física que tiene la impresora térmica
  USB conectada (la terminal del cajero, o del admin) — no en la nube.
  Usa el puerto **4001**, no 4000 (ese ya es el backend real).
  `printThermalReceipt` (ver abajo) siempre intenta `localhost:4001` — si
  no hay nada corriendo ahí, cae a `window.print()` sin error visible.
- **NO uses `escpos`/`escpos-usb`** (el plan original los mencionaba) —
  se descartaron por dos problemas reales, en este orden: (1)
  `escpos-usb` fija `"usb": "*"` sin versión, así que npm resuelve el
  `usb` moderno (v3.x, reescrito en Rust/napi-rs con API distinta) y el
  código viejo de `escpos-usb` llama a `usb.getDeviceList()` de una forma
  que ya no existe → crash inmediato; (2) fijar `usb` a una versión vieja
  compatible (`1.9.2`) para arreglar eso hace que la instalación intente
  compilar bindings nativos, y esa compilación (`node-gyp`/`make`) falla
  en este repo porque la ruta tiene espacios ("Proyecto Mecatos el
  Santi") — el Makefile generado no la escapa bien y `clang++` interpreta
  `Mecatos`, `el`, `Santi/...` como argumentos separados. Esto no es un
  bug de este proyecto, es una limitación conocida de GYP con rutas con
  espacios — afectaría a cualquier dependencia nativa vieja instalada
  bajo esa misma ruta. Si en algún momento hace falta tocar
  `print-server/`, no vuelvas a introducir `escpos`/`escpos-usb` — usa la
  misma familia `@node-escpos/*`.
  - **`usb` queda fijado a `2.18.0` exacto (`"usb": "2.18.0"`, sin `^`) en
    `print-server/package.json` — no es opcional ni cosmético.**
    `@node-escpos/usb-adapter@0.3.1` también declara su dependencia de
    `usb` como `"*"` (el mismo problema de fondo que tenía `escpos-usb`,
    solo que en la librería mantenida) — así que sin este pin, npm
    resuelve `usb@3.x`, cuyo export de nivel superior **ya no tiene
    `getDeviceList`** (ni siquiera en el namespace anidado `usb.usb`), y
    cualquier intento de imprimir revienta con `TypeError:
    usb.getDeviceList is not a function`. `usb@2.18.0` sí lo tiene, y —
    a diferencia del viejo `usb@1.9.2` — se instala con binarios
    precompilados (`node-gyp-build`/`prebuildify`), así que tampoco pisa
    el problema de compilación con espacios en la ruta. Ver
    `print-server/README.md` para el detalle completo; si actualizas
    `@node-escpos/usb-adapter` a futuro, verifica que la nueva versión ya
    soporte `usb@3.x` antes de quitar este pin.
  - **Diferencias de API a tener en cuenta**: `@node-escpos/core` es
    `Promise`/`async-await` (no callbacks) — `printer.close()` es `async`
    y ya hace su propio `flush()` internamente. `printer.cut(partial?,
    feed?)` ya hace su propio `feed()` antes de cortar (default 3
    líneas) — no llames `.feed(3)` justo antes de `.cut()`, o el papel
    avanza el doble.
- **El logo se imprime de verdad, redimensionado y en escala de grises**:
  `print-server/assets/logo.png` es una copia local de
  `admin-frontend/public/img/logo-santi-trimmed.png` (este paquete no lee
  el `public/` del frontend en tiempo de ejecución — puede correr en otra
  máquina). Al arrancar, `getLogoImage()` la reduce a 384px de ancho con
  `sharp` (la original es 815×614, pensada para pantalla, no para una
  impresora térmica de 58/80mm) y la convierte a escala de grises con más
  contraste, para que el dithering de `@node-escpos/core` se vea nítido
  en papel — y cachea el resultado en memoria, no la reprocesa en cada
  recibo. Si cambias el logo, reemplaza ese archivo y reinicia el
  servidor (no hay recarga en caliente).
- **El formato impreso replica exactamente el recibo en pantalla**
  (`SaleReceipt.tsx`, ver punto 19 en `admin-frontend/CLAUDE.md`): logo,
  "Mecatos el Santi" en negrita, NIT, nombre/dirección/teléfono de la
  sede, una fila de dos columnas para "Ticket: X" / fecha y otra para
  "Atendido por: X" / método de pago (`tableCustom` con dos columnas de
  0.5, igual que los `flex justify-between` en pantalla), la tabla de
  ítems con **encabezado** (Producto/Cant./Precio/Subtotal — 4 columnas,
  no solo 2) y las mismas etiquetas en el resumen final ("Subtotal",
  "Total" — **sin** línea de impuesto, ver punto 65 de
  `backend/CLAUDE.md`: el negocio no declara/cobra impuestos, así que
  `tax` ya no se calcula ni se imprime — el campo `tax` se quitó por
  completo de `PrintReceiptPayload` y del payload que le llega a este
  servicio, no solo se dejó de mostrar en 0). `PrintReceiptPayload`
  (`printerService.ts`, ambas copias) reflejó esto: ahora incluye
  `branchAddress`/`branchPhone` (antes solo `branch`) y cada ítem lleva
  `price` (precio unitario) además de `quantity`/`subtotal` — si cambias
  qué muestra `SaleReceipt.tsx` en pantalla, actualiza también esta forma
  y el armado de la tabla en `print-server/index.js` para que no se
  desincronicen.
- **Pie del ticket — CUFE/QR/aviso legal cuando la venta ya está timbrada
  por SIIGO o FACTUS; atribución por provider** (ver fase DIAN en
  `backend/CLAUDE.md`): `SaleReceipt.tsx` calcula
  `showDianBlock = sale.dianStatus === "APPROVED" && Boolean(sale.cufe)`
  **una sola vez** y lo manda en el payload junto con `dianProvider`;
  `print-server` NO reimplementa la condición, solo lee el booleano y usa el
  provider para la atribución dinámica. Si es `true`, ambos
  endpoints (`/print-receipt` y `/preview-receipt`) imprimen: "Factura
  electrónica de venta No. {dianInvoiceNumber}" (arriba, junto al Ticket,
  si viene), CUFE en texto, el QR, el aviso de letra de cambio (Ley 1231
  de 2008), la atribución dinámica de marca (`Siigo`/`Factus`, sin inventar
  razón social o sufijo legal), y — solo si
  `resolutionNumber` viene poblado (hoy vacío en todas las sedes, ver
  `Branch.dianConfig`) — la línea de Resolución DIAN. Para `MOCK` el
  frontend apaga `showDianBlock` y el ticket imprime un aviso explícito de
  simulación, nunca el CUFE/QR ficticio. Para ventas históricas sin provider
  registrado se usa atribución genérica. `NIT` (`1144209364-9`) es
  una constante hardcodeada en `index.js` (mismo criterio que "Mecatos el
  Santi" — no varía por sede, así que no hace falta plumbing por el
  payload ni un campo nuevo en `Branch`).
- **QR: dos mecanismos distintos, uno por endpoint, a propósito**. El
  print real (`/print-receipt`) usa `printer.qrimage(texto, { type:
  "png", mode: "d24" })` de `@node-escpos/core` — un método `async`
  propio (no el `printer.qrcode()` de más bajo nivel/comando ESC/POS
  nativo, sin verificar contra el hardware real todavía) que internamente
  ya usa `qr-image` para generar un PNG y lo imprime por el mismo camino
  de imagen que el logo, con la misma densidad (`"d24"`). La vista previa
  (`/preview-receipt`, sin USB) no puede llamar a `printer.qrimage`
  (necesita un `Printer` real conectado a un `device`), así que genera su
  propio PNG con `qr.imageSync(texto, { type: "png", size: 4 })` — por
  eso `qr-image` se agregó como **dependencia directa** de
  `print-server/package.json` (antes solo llegaba transitivamente vía
  `@node-escpos/core`, sin pinearla, algo fragil si esa librería alguna
  vez deja de usarla internamente) — y la codifica a base64 igual que ya
  hace `getLogoAssets()` con el logo.
- **`wrapText(texto, 32)`** (nuevo helper en `index.js`) — el pie legal
  (dos-tres oraciones largas) SÍ necesita wrap manual a 32 columnas para
  el ticket físico, a diferencia de la vista previa HTML (que trunca con
  `text-overflow: ellipsis`, ver la nota de "Vista previa" más abajo) —
  `printer.text()` no hace wrap automático. Si agregas otro bloque de
  texto largo al ticket físico, reutiliza este helper en vez de escribir
  uno nuevo.
- **`printerService.ts` (dos copias — `admin-frontend/src/services/` y
  `admin-frontend/src/cajero/services/`, mismo patrón de duplicación
  intencional que `SaleReceipt.tsx`, ver punto 12 en `admin-frontend/src/
  cajero/CLAUDE.md`) es la ÚNICA excepción documentada a "no fetch en este
  proyecto"** (ver stack en el `CLAUDE.md` raíz) — usa `fetch` en vez de
  los clientes axios (`httpClient.ts`), porque `print-server` es un
  proceso local de la terminal física, no la API en la nube: no necesita
  cookies/credenciales ni el interceptor de errores de axios. Si ves
  `fetch` en cualquier otro archivo de este proyecto, SÍ es una desviación
  real de la convención — corrígela a axios, a menos que sea otro caso
  igual de justificado (hablar con hardware/servicio local, no con la API
  propia).
- **El fallback a `window.print()` vive dentro de `printThermalReceipt`
  mismo**, no en los componentes que lo llaman — `SaleReceipt.tsx` (ambas
  copias) solo llama `await printThermalReceipt(payload)` dentro de un
  `handlePrint` con un estado `printing` para deshabilitar el botón
  mientras tanto (sin `disabled` permanente después: se pueden pedir
  copias adicionales sin cerrar el modal). Si agregas otro punto de
  impresión térmica, sigue este mismo patrón — no dupliques el manejo
  del fallback en el componente.
- **Alcance**: a diferencia de otras features de este proyecto, esta se
  pidió explícitamente para AMBAS copias de `SaleReceipt.tsx` (panel
  admin y cajero), no solo una.
- **Vista previa sin impresora física (`POST /preview-receipt`, botón
  "Vista previa" junto a "Imprimir recibo")**: mismo body que
  `/print-receipt`, pero devuelve una página HTML (no toca el USB) que
  aproxima el ticket con el mismo logo ya procesado y los mismos anchos
  de columna (`TWO_COL_WIDTHS`/`ITEM_COL_WIDTHS`, constantes compartidas
  en `index.js` entre ambos endpoints). `previewThermalReceipt`
  (`printerService.ts`, ambas copias) abre el HTML en una pestaña nueva
  (`window.open` + `document.write`) — a diferencia de
  `printThermalReceipt`, **no tiene fallback silencioso**: si el
  print-server no responde, lanza el error y `handlePreview` en
  `SaleReceipt.tsx` lo muestra con un `alert()`, porque el propósito del
  botón es justamente confirmar el resultado visual. El texto largo se
  trunca con `text-overflow: ellipsis` en vez de hacer wrap — imita cómo
  una impresora térmica real no ajusta el texto de una columna fija a una
  segunda línea (lo trunca/desborda). Ver `docs/
  THERMAL_PRINTER_INTEGRATION.md` sección 8.
- **Cola FIFO en proceso + retry de apertura + `/health`** (lo que evita
  que un trabajo a medias bloquee la térmica y haga que DiDi/u otro
  cliente "deje de imprimir" — el bug clásico de interface-claim USB
  filtrado):
  - **`PrintQueue`** (clase en `index.js`): serializa TODAS las llamadas
    a `/print-receipt`; una sola abre el USB a la vez, las demás
    esperan. Cap `PRINT_QUEUE_MAX` (default 50) y timeout
    `PRINT_QUEUE_TIMEOUT_MS` (default 15 s) — un cashier en bucle no
    puede hacer crecer la cola sin límite, y un job que se quedó pegado
    en el extremo frontal de la cola no bloquea al resto para siempre.
  - **`openWithRetry`** (helper en `index.js`): hasta 3 intentos con
    backoff lineal (200, 400, 600 ms) solo en `LIBUSB_ERROR_BUSY`
    (`errno === -6` / "EBUSY") — el caso típico es que el driver de DiDi
    tenga el interface-claim en ese instante. Otros errores (permiso,
    dispositivo inexistente) NO se reintentan, fallarían igual.
  - **`runPrintJob(payload, jobId)`**: el cuerpo real del trabajo vive
    acá, **NO** inline en el handler de Express. La pieza clave: TODA la
    apertura/uso del dispositivo va dentro de un `try { ... } finally
    { ... }` que ejecuta `printer.close()` y `device.close()` en TODAS
    las rutas (éxito, excepción, timeout). Antes, `printer.close()`
    corría solo en el camino feliz — un solo `await` que fallara a la
    mitad dejaba el puerto USB bloqueado hasta que se desconectaba
    físicamente la impresora. Ahora, aunque el handler de Express se
    caiga, el `finally` libera el interface-claim.
  - **ESC @ al inicio Y al final** (`printer.hardware("init")`): limpia
    basura residual del trabajo anterior (típico: un ticket DiDi que se
    cayó a la mitad justo antes de cedernos el puerto) y deja el
    dispositivo en estado conocido para el siguiente cliente.
  - **`printer.cut(false, 4)`** (sin `.feed(...)` antes): `@node-escpos/
    core@0.6.x` ya hace su propio feed dentro de `cut()`. El código
    original tenía `.feed(4).cut()`, que resultaba en 7 líneas de
    avance (doble feed). Ya está corregido — un solo `.cut(false, 4)`.
  - **`GET /health`** (probe liviano, NO toca el USB): mismo patrón que
    `GET /health` del backend (punto 58 del `CLAUDE.md` raíz) — útil
    para un monitor externo (UptimeRobot, etc.) y para confirmar en
    campo que no hay jobs atascados. Responde `{ ok: true, queueDepth,
    runningJob }`.
  - **Mixed Content / HTTPS en producción**: las DOS copias de
    `printerService.ts` (`src/services/` y `src/cajero/services/`)
    resuelven la URL vía `printServerUrl(path)`: si la página está en
    HTTPS, van a `http://127.0.0.1:4001/...` (loopback, no bloqueado
    por Mixed Content porque `127.0.0.1` está en la allowlist de los
    navegadores); en HTTP siguen usando `localhost:4001` como antes.
    Sin esto, el frontend en producción HTTPS hacía `fetch` a
    `http://localhost:4001`, el navegador lo bloqueaba, el catch
    silencioso caía a `window.print()`, y desde el cajero parecía "la
    térmica está ocupada".

### 68. Aislamiento del servicio de impresión — solo `127.0.0.1`, CORS con lista de orígenes, `Host` validado y payload validado

Este servidor puede **imprimir tickets y abrir el cajón de dinero** (`printer.cashdraw()` al final de
cada recibo), así que se trata como un servicio privilegiado de la máquina de la caja. Antes escuchaba
en todas las interfaces con `cors()` abierto: cualquier equipo de la red local, **o cualquier página web
que abriera el cajero en su navegador**, podía llamar a `http://localhost:4001/print-receipt`.

- **Bind estricto a `127.0.0.1`** (`app.listen(PORT, HOST)` con `HOST` constante, sin variable de
  entorno a propósito — que nadie lo abra a la red por accidente). Verificado con `lsof`: el socket es
  `127.0.0.1:<puerto>`, no `*:<puerto>`.
- **CORS con lista**, no `*`. Por defecto solo `http://localhost:5174` y `http://127.0.0.1:5174`
  (frontend en desarrollo). **Para producción hay que definir `PRINT_ALLOWED_ORIGINS`** con el dominio
  donde esté desplegado `admin-frontend` (varios separados por coma). Si falta, el navegador bloquea la
  petición y el frontend hace su fallback silencioso a `window.print()` (ver punto 32) — la impresión
  "funciona" pero por el diálogo del navegador, no directo a la térmica, y no hay un error visible: el
  primer síntoma es que dejó de imprimir directo. Al arrancar y al rechazar un origen se loguea la
  lista permitida para diagnosticarlo.
- **Header `Access-Control-Allow-Private-Network`**: Chrome lo exige en el preflight cuando una página
  HTTPS pública llama a un servidor en `localhost`. Solo se responde si el origen ya está en la lista, y
  su middleware va **antes** de `cors` (éste responde los `OPTIONS` y, si va antes, el header nunca se envía).
- **Chequeo del header `Host`** (`localhost:<puerto>` / `127.0.0.1:<puerto>`) contra "DNS rebinding".
- **Validación del payload** (`validateReceiptPayload`, sin dependencias nuevas) en `/print-receipt` y
  `/preview-receipt`: textos ≤ 200 caracteres, hasta 100 ítems, números finitos,
  `showDianBlock` booleano y `dianProvider` (`MOCK`/`SIIGO`/`FACTUS`/`LEGACY`).
  Rechaza además un `showDianBlock=true` para MOCK.
  Un payload inválido responde 400 **antes** de tocar la impresora (antes, un `items` que no fuera un arreglo
  reventaba a mitad de impresión con el puerto USB ya abierto). **Si cambias `PrintReceiptPayload`** en
  `printerService.ts` (las dos copias), actualiza este validador o la impresión empezará a devolver 400.
- **`express.json({ limit: "100kb" })`** (un ticket real pesa unos KB) y `helmet()` (nueva dependencia,
  `helmet@7`, instalada con `--ignore-scripts` para no tocar el binario nativo de `usb`).
- **Vista previa**: además de `escapeHtml` en cada campo, el HTML lleva un `<meta http-equiv=
  "Content-Security-Policy">` (`default-src 'none'; img-src data:; style-src 'unsafe-inline'`) — el header
  HTTP no serviría porque el frontend inyecta el HTML con `document.write` en una ventana nueva.
- **Variables de entorno**: `PRINT_SERVER_PORT` (default 4001, ya existía) y `PRINT_ALLOWED_ORIGINS`. Se leen de `print-server/.env` (vía `dotenv`, ruta relativa a `index.js`), que **sí va en el repo** porque solo tiene direcciones, no secretos — así llega a cada terminal con un `git pull`. Una variable definida en la terminal al arrancar gana sobre el archivo. **Para producción, agrega el dominio de Vercel a `PRINT_ALLOWED_ORIGINS` en ese `.env`** (sin `/` final ni ruta). No pongas secretos ahí.
- **Verificado en vivo**: `Host: evil.com` → 403; preflight desde origen ajeno sin `Allow-Origin`; `items`
  no arreglo → 400; cuerpo de 200 KB → 413; vista previa escapa `<b>` y lleva la CSP.
- **Higiene del repo**: `print-server/` tiene `node_modules/` **versionado** y sin `.gitignore` (por eso
  instalar `helmet` aparece en `git status` como archivos de `node_modules`). Conviene ignorarlo y sacarlo del control de versiones.
