# mecatos-print-server

Servidor local de impresión térmica (ESC/POS) para Mecatos el Santi. Corre
**en la misma máquina física** que tiene la impresora térmica USB
conectada (la terminal del cajero, o del admin si también imprime desde
ahí) — no es parte del backend en la nube, no se despliega junto con él.
Ver `docs/THERMAL_PRINTER_INTEGRATION.md` en la raíz del repo para el
diseño completo (por qué existe, cómo lo llama el frontend, fallback a
`window.print()`).

## Por qué es un paquete aparte

La impresora térmica es un periférico físico de una terminal específica,
no un recurso compartido en la nube — por eso este servidor corre en
`localhost` de esa máquina, separado de `backend/` (que sí vive en la
nube/Docker y no tiene acceso a ningún hardware local). El frontend
(`admin-frontend`, corriendo en esa misma máquina) le pega a
`http://localhost:4001` — **no** al puerto 4000 del backend real, para
evitar el choque de puertos.

## Instalación y arranque

```bash
cd print-server
npm install
npm start          # o: npm run dev (con nodemon, reinicia solo al editar)
```

No hace falta instalar `libusb` ni ninguna herramienta de compilación
nativa por separado — ver la nota sobre `usb@2.18.0` más abajo, la
instalación usa binarios precompilados.

Con la impresora térmica conectada por USB, el servidor autodetecta el
primer dispositivo USB de tipo impresora (`new USBAdapter()`, sin
argumentos).

## `usb@2.18.0` está fijado a propósito — no lo actualices sin probarlo

Este paquete usa `@node-escpos/core` + `@node-escpos/usb-adapter` (la
organización mantenida — ver punto 33 de `CLAUDE.md` para por qué no se
usa el viejo `escpos`/`escpos-usb`), que a su vez dependen de `usb`
(bindings nativos de Node sobre libusb). **`usb-adapter@0.3.1` declara su
dependencia de `usb` como `"*"` (sin fijar versión)**, y en la práctica
eso importa mucho:

- `usb@3.x` (la última disponible en npm) **cambió su API exportada** —
  ya no expone `getDeviceList` en el nivel superior del módulo (ni
  tampoco en `usb.usb`, el namespace anidado). El código compilado de
  `usb-adapter@0.3.1` sí llama a `usb.getDeviceList()` directamente, así
  que con `usb@3.x` instalado, **cualquier intento de imprimir revienta
  con `TypeError: usb.getDeviceList is not a function`** — no es un error
  de impresora desconectada, es una incompatibilidad real entre estas dos
  librerías que ningún manejo de errores del lado de este servidor puede
  arreglar.
- `usb@2.18.0` sí tiene `getDeviceList` en el nivel superior — es la
  última versión de la serie 2.x, y es la que este paquete fija
  explícitamente (`"usb": "2.18.0"`, sin rango `^`/`~`) para evitar que un
  `npm install` futuro vuelva a resolver la 3.x rota.
- La buena noticia: `usb@2.18.0` (igual que la 3.x) se instala con
  **binarios precompilados** vía `node-gyp-build`/`prebuildify` para las
  plataformas comunes (macOS/Linux/Windows, x64/arm64) — no compila nada
  localmente en la instalación normal, así que tampoco pisa el problema
  de rutas con espacios que sí rompía al viejo `escpos-usb` (ver punto 33
  de `CLAUDE.md`).

**Si en algún momento actualizas `@node-escpos/usb-adapter` a una versión
más nueva**, primero prueba si esa versión ya soporta `usb@3.x` (revisa su
código fuente en npm/GitHub buscando `getDeviceList`) antes de quitar el
pin de `usb@2.18.0` — si lo quitas sin verificar, `npm install` puede
volver a resolver la 3.x y reintroducir el mismo crash.

## Si hay más de un dispositivo USB conectado (ambigüedad)

`new USBAdapter()` sin argumentos toma el primero que encuentre, lo cual
puede fallar o elegir el dispositivo equivocado si hay varios USB
conectados. Para fijar uno específico:

1. Lista los dispositivos USB conectados y anota el vendor id (`vid`) y
   product id (`pid`) de la impresora — en macOS/Linux, `lsusb` (Linux) o
   revisando "Información del sistema" → USB (macOS) suelen mostrarlos
   como `0x0483:0x5743` o similar.
2. En `index.js`, cambia:
   ```js
   device = new USBAdapter();
   ```
   por:
   ```js
   device = new USBAdapter(0x0483, 0x5743); // vid, pid reales de tu impresora
   ```

## El logo se prepara una sola vez al arrancar, no en cada impresión

`assets/logo.png` es una copia local del logo (`admin-frontend/public/img/
logo-santi-trimmed.png`) — este paquete no lee el `public/` del frontend
en tiempo de ejecución, porque puede correr en una máquina distinta. Al
arrancar el servidor, `getLogoImage()` la redimensiona a 384px de ancho
(seguro para papel de 58mm y 80mm), la convierte a escala de grises y
normaliza el contraste con `sharp` — así el ESC/POS que imprime la imagen
(medio-tono/dithering) se ve nítido en papel térmico en vez de borroso.
Ese resultado se cachea en memoria (`logoImagePromise`) y se reutiliza en
cada recibo; si necesitas cambiar el logo, reemplaza `assets/logo.png` y
reinicia el servidor (no hay recarga en caliente de ese archivo).

## Vista previa sin impresora física (`POST /preview-receipt`)

Mismo body que `/print-receipt`, pero en vez de tocar el USB devuelve una
página HTML (`Content-Type: text/html`) que aproxima visualmente el ticket
térmico: mismo logo ya procesado (gris/normalizado), mismos anchos de
columna que las tablas ESC/POS reales (`TWO_COL_WIDTHS`/`ITEM_COL_WIDTHS`
en `index.js`, compartidos entre ambos endpoints para que no se
desincronicen). Sirve para revisar el formato del recibo sin tener la
impresora conectada — ver `docs/THERMAL_PRINTER_INTEGRATION.md` sección 9.

Un detalle a propósito: el texto largo (nombre de producto, nombre del
cajero) se trunca con `text-overflow: ellipsis` en vez de hacer wrap a una
segunda línea — porque las columnas de texto de una impresora térmica real
tampoco ajustan el texto a otra línea (lo truncan o desbordan según el
modelo). Si ves puntos suspensivos en la vista previa, es una señal real de
que ese texto no cabrá en la columna en la impresora física — considera
acortar el nombre del producto o del cajero si eso pasa seguido.

Esto se usa desde el botón "Vista previa" de `SaleReceipt.tsx` (ambas
copias, panel admin y cajero), que abre el HTML en una pestaña nueva vía
`window.open` + `document.write` — a diferencia de `printThermalReceipt`,
`previewThermalReceipt` (en `printerService.ts`) NO cae a ningún fallback
silencioso si este servidor no está corriendo: lanza el error para que el
botón lo muestre con un `alert`, porque el propósito del botón es
justamente confirmar que la vista previa funcionó.

## Variables de entorno

- `PRINT_SERVER_PORT` (opcional, default `4001`) — puerto donde escucha
  este servidor. Si lo cambias, actualiza también la URL que usa
  `printerService.ts` en `admin-frontend` (ver `docs/
  THERMAL_PRINTER_INTEGRATION.md`).

## Troubleshooting

- **"Thermal printer not connected or busy"** (respuesta 500) — la
  impresora no está encendida/conectada, o otro proceso ya tiene el
  dispositivo USB abierto (ciérralo antes de reintentar). El frontend cae
  automáticamente a `window.print()` cuando esto pasa — no es necesario
  reintentar manualmente desde la UI.
- **`usb.getDeviceList is not a function`** — ver la sección de arriba:
  algo hizo que `usb` se actualizara a la serie 3.x. Revisa
  `node_modules/usb/package.json` y, si no es `2.18.0`, corre `npm install
  usb@2.18.0` de nuevo.
- Este servidor **no necesita estar corriendo** para que el resto de la
  app funcione — si no está disponible (apagado, o simplemente no
  instalado en esa máquina), el botón "Imprimir recibo" cae a
  `window.print()` sin ningún error visible para el cajero.
