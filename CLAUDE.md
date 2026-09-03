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
  "Mecatos el Santi" en negrita, nombre/dirección/teléfono de la sede, una
  fila de dos columnas para "Ticket: X" / fecha y otra para "Atendido por:
  X" / método de pago (`tableCustom` con dos columnas de 0.5, igual que
  los `flex justify-between` en pantalla), la tabla de ítems con
  **encabezado** (Producto/Cant./Precio/Subtotal — 4 columnas, no solo 2)
  y las mismas etiquetas en el resumen final ("Subtotal", "Impuesto
  (INC)", "Total", "Factura electrónica en proceso de validación DIAN.",
  "¡Gracias por tu compra!"). `PrintReceiptPayload` (`printerService.ts`,
  ambas copias) reflejó esto: ahora incluye `branchAddress`/`branchPhone`
  (antes solo `branch`) y cada ítem lleva `price` (precio unitario)
  además de `quantity`/`subtotal` — si cambias qué muestra
  `SaleReceipt.tsx` en pantalla, actualiza también esta forma y el
  armado de la tabla en `print-server/index.js` para que no se
  desincronicen.
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
