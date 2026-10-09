const path = require("path");
// Lee `print-server/.env` (junto a este archivo, sin importar desde qué carpeta se
// inicie). No pisa variables ya definidas en la terminal, así que una variable
// puesta a mano al arrancar sigue teniendo prioridad sobre el archivo.
require("dotenv").config({ path: path.join(__dirname, ".env") });
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const sharp = require("sharp");
const qr = require("qr-image");
const { Printer, Image } = require("@node-escpos/core");
const USBAdapter = require("@node-escpos/usb-adapter");

// NIT del negocio — constante fija (no varía por sede, mismo criterio que
// "Mecatos el Santi" ya hardcodeado más abajo). Copia intencional de la
// misma constante en admin-frontend/src/components/SaleReceipt.tsx (ver
// punto 34 de backend/CLAUDE.md — rediseño de recibo).
const BUSINESS_NIT = "1144209364-9";

// Envuelve texto a un ancho fijo de columnas (para el pie legal en ESC/POS,
// que no hace wrap automático — a diferencia de la vista previa HTML, que
// trunca con ellipsis, ver docs/THERMAL_PRINTER_INTEGRATION.md sección 8).
function wrapText(text, width) {
  const words = String(text).split(" ");
  const lines = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length > width) {
      if (current) lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  return lines;
}

// --- Cola de impresión + retry de apertura USB ------------------------------
// Antes, cada POST /print-receipt creaba un USBAdapter nuevo y llamaba
// `device.open()` sin serializar: dos requests simultáneos peleaban el
// interface-claim exclusivo de libusb, el perdedor devolvía 500, y el
// "ganador" — si algo fallaba a mitad del trabajo — nunca llegaba a
// `printer.close()`, dejando el puerto USB bloqueado hasta que se
// desconectaba la impresora (visto en la práctica como "DiDi dejó de
// imprimir"). Dos piezas, ver punto 32 de CLAUDE.md:
//
//  - `PrintQueue`: FIFO en proceso, serializa TODAS las impresiones. Una
//    sola abre el USB a la vez; las demás esperan. Si la cola se llena
//    (cajero trabado en un bucle, DiDi monopolizando la impresora, etc.)
//    rechaza con 503 antes de aceptar más.
//  - `openWithRetry`: hasta 3 intentos con backoff lineal. Solo reintenta
//    en EBUSY/LIBUSB_ERROR_BUSY (otro cliente — típicamente el driver de
//    DiDi — tiene el interface-claim en ese instante).
const PRINT_QUEUE_MAX = Number(process.env.PRINT_QUEUE_MAX) || 50;
const PRINT_QUEUE_TIMEOUT_MS = Number(process.env.PRINT_QUEUE_TIMEOUT_MS) || 15000;
const USB_OPEN_RETRIES = 3;
const USB_OPEN_RETRY_BASE_MS = 200;

class PrintQueue {
  constructor() {
    this.queue = [];
    this.running = false;
    this.activeJob = null;
  }
  enqueue(jobFn) {
    return new Promise((resolve, reject) => {
      if (this.queue.length >= PRINT_QUEUE_MAX) {
        return reject(new Error("Print queue full — intente de nuevo"));
      }
      const entry = { jobFn, resolve, reject, enqueuedAt: Date.now(), timeoutHandle: null };
      entry.timeoutHandle = setTimeout(() => {
        const idx = this.queue.indexOf(entry);
        if (idx !== -1) {
          this.queue.splice(idx, 1);
          reject(new Error("Print queue timeout — intente de nuevo"));
        }
      }, PRINT_QUEUE_TIMEOUT_MS);
      this.queue.push(entry);
      this.#drain();
    });
  }
  async #drain() {
    if (this.running) return;
    this.running = true;
    while (this.queue.length) {
      const next = this.queue.shift();
      clearTimeout(next.timeoutHandle);
      this.activeJob = next;
      try {
        next.resolve(await next.jobFn());
      } catch (err) {
        next.reject(err);
      } finally {
        this.activeJob = null;
      }
    }
    this.running = false;
  }
}
const printQueue = new PrintQueue();

async function openWithRetry(device, attempts = USB_OPEN_RETRIES, baseMs = USB_OPEN_RETRY_BASE_MS) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      await new Promise((resolve, reject) => {
        device.open((err) => (err ? reject(err) : resolve(undefined)));
      });
      return;
    } catch (err) {
      lastErr = err;
      // LIBUSB_ERROR_BUSY = -6 / EBUSY. Solo reintenta ese caso — cualquier
      // otro error (permiso, dispositivo inexistente) no se va a arreglar
      // esperando 200 ms.
      const isBusy = err?.errno === -6 || /busy|EBUSY/i.test(String(err?.message || err));
      if (!isBusy || i === attempts - 1) throw err;
      await new Promise((r) => setTimeout(r, baseMs * (i + 1)));
    }
  }
  throw lastErr;
}

// --- Aislamiento del servicio -----------------------------------------------
// Este servidor puede imprimir tickets y ABRIR EL CAJÓN DE DINERO
// (`printer.cashdraw()`), así que solo debe alcanzarlo el navegador de ESTA
// máquina. Tres capas, ver punto 68 de CLAUDE.md:
//  1. Escucha SOLO en 127.0.0.1 (más abajo, en `app.listen`) — ningún otro
//     equipo de la red puede conectarse.
//  2. CORS con lista de orígenes permitidos (no `*`): sin esto, CUALQUIER
//     página web que abra el cajero podría hacer `fetch("http://localhost:
//     4001/print-receipt")` y disparar impresiones / abrir el cajón.
//  3. Se valida el header `Host` (evita "DNS rebinding": una web maliciosa
//     que resuelve su dominio a 127.0.0.1 para saltarse el chequeo de origen).
const HOST = "127.0.0.1";
const PORT = Number(process.env.PRINT_SERVER_PORT) || 4001;

// Orígenes del frontend autorizados a imprimir. El de producción (dominio
// donde esté desplegado admin-frontend) se agrega con PRINT_ALLOWED_ORIGINS,
// separado por comas — si falta, el navegador bloquea la impresión directa y
// el frontend cae al diálogo de impresión del navegador.
const allowedOrigins = (process.env.PRINT_ALLOWED_ORIGINS || "http://localhost:5174,http://127.0.0.1:5174")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

const allowedHosts = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`]);

const app = express();
app.disable("x-powered-by");
app.use(helmet());

app.use((req, res, next) => {
  if (!allowedHosts.has(String(req.headers.host || "").toLowerCase())) {
    return res.status(403).json({ success: false, error: "Host no permitido" });
  }
  next();
});

// (Va ANTES de `cors`: éste responde los OPTIONS y no dejaría llegar hasta acá.)
// Chrome exige este header en el preflight cuando una página HTTPS pública
// (el frontend desplegado) llama a un servidor en localhost ("Private Network
// Access"). Solo se responde si el origen ya pasó la lista de arriba.
app.use((req, res, next) => {
  if (req.headers["access-control-request-private-network"] === "true" && allowedOrigins.includes(req.headers.origin)) {
    res.setHeader("Access-Control-Allow-Private-Network", "true");
  }
  next();
});

app.use(
  cors({
    origin(origin, callback) {
      // Sin `Origin` (curl, herramientas locales) se deja pasar: el servidor ya
      // solo escucha en loopback. Con `Origin`, debe estar en la lista.
      if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
      console.warn(`[print-server] Origen rechazado: ${origin} (permitidos: ${allowedOrigins.join(", ")})`);
      return callback(null, false);
    },
    methods: ["POST", "OPTIONS"],
  })
);

// Un ticket real pesa unos pocos KB; 100kb sobra y evita cuerpos gigantes.
app.use(express.json({ limit: "100kb" }));

// --- Validación del payload del recibo --------------------------------------
const MAX_TEXT = 200;
const MAX_ITEMS = 100;

const isText = (v, max = MAX_TEXT) => typeof v === "string" && v.length <= max;
const isOptText = (v, max = MAX_TEXT) => v === undefined || v === null || isText(v, max);
const isNum = (v) => typeof v === "number" && Number.isFinite(v) && Math.abs(v) < 1e12;
const isOptNum = (v) => v === undefined || v === null || isNum(v);

/**
 * Coerce de "lo que venga" a un número finito. Acepta:
 *  - numbers  → 그대로
 *  - strings numéricas ("3500", "3500.5", "  3500 ") → Number(v)
 *  - null/undefined → 0  (campo faltante en ventas viejas / ticket offline)
 * Rechaza objetos, arrays, booleanos, strings no numéricos, NaN, Infinity.
 */
function toSafeNumber(v) {
  if (v === undefined || v === null) return 0;
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return null; // señal de "esto no es un número, ni lo vamos a inventar"
}

/**
 * Devuelve un mensaje de error, o `null` si el payload tiene la forma esperada.
 *
 * Antes, `item.con campos inválidos` rechazaba CUALQUIER ítem con `quantity`,
 * `price` o `subtotal` null/undefined — típico de ventas guardadas con un
 * campo faltante (ej. tickets offline viejos encolados antes del corte del
 * punto 8 de CLAUDE.md, ventas migradas con campos parciales, o un campo
 * que el schema Mongoose marca como `Number` pero la data real tenía `null`).
 * Eso bloqueaba imprimir/previsualizar recibos de ventas perfectamente
 * legibles, con un 400 que el frontend mostraba como "Print-server local no
 * disponible para vista previa" — diagnóstico falso, parecía problema de
 * red cuando en realidad era un campo con null.
 *
 * La política nueva es tolerante con la data del recibo (un item con
 * `price` faltante se imprime como `$0`; con `name` faltante como "Producto")
 * y estricta solo con lo que podría romper el render (item no-objeto,
 * subtotal/total del documento que no se puede leer como número).
 */
function validateReceiptPayload(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return "Payload inválido";
  const b = body;
  if (!isText(b.invoiceId)) return "invoiceId inválido";
  if (!isText(b.cashier)) return "cashier inválido";
  if (!isText(b.paymentMethod)) return "paymentMethod inválido";
  if (b.dianProvider !== undefined && !["MOCK", "SIIGO", "FACTUS", "LEGACY"].includes(b.dianProvider)) {
    return "dianProvider inválido";
  }
  if (!isText(b.branch)) return "branch inválido";
  if (!isOptText(b.branchAddress) || !isOptText(b.branchPhone)) return "datos de sede inválidos";
  // `subtotal`/`total` a nivel de venta: rechazar si NO se pueden leer como
  // número (incluso tolerando strings numéricas). Una venta sin total
  // imprimible NO debe salir.
  if (toSafeNumber(b.subtotal) === null || toSafeNumber(b.total) === null) {
    return "subtotal/total inválidos";
  }
  if (!Array.isArray(b.items) || b.items.length > MAX_ITEMS) return "items inválidos";
  for (const item of b.items) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return "item inválido";
    // `name` puede faltar → cae a "Producto" en el render; no es 400.
    // `quantity`/`price`/`subtotal` faltantes o null → 0 en el render.
    // Solo 400 si vienen con un TIPO que claramente no es número (objeto,
    // array, booleano) — `toSafeNumber` devuelve null en ese caso.
    if (
      toSafeNumber(item.quantity) === null ||
      toSafeNumber(item.price) === null ||
      toSafeNumber(item.subtotal) === null
    ) {
      return "item con campos numéricos inválidos";
    }
    // `name` sigue opcional — vacío/no-string no rompe el render. Si es un
    // objeto/array (raro, pero defensivo) → 400.
    if (item.name !== undefined && item.name !== null && typeof item.name !== "string") {
      return "item.name debe ser string";
    }
  }
  if (b.showDianBlock !== undefined && b.showDianBlock !== null && typeof b.showDianBlock !== "boolean") {
    return "showDianBlock inválido";
  }
  if (b.showDianBlock === true && b.dianProvider === "MOCK") {
    return "Una factura simulada no puede imprimir el bloque DIAN";
  }
  if (!isOptText(b.cufe, 300) || !isOptText(b.qrCodeUrl, 600)) return "cufe/qrCodeUrl inválidos";
  if (!isOptText(b.dianInvoiceNumber) || !isOptText(b.resolutionNumber) || !isOptText(b.resolutionPrefix)) {
    return "datos DIAN inválidos";
  }
  if (!isOptNum(b.resolutionFrom) || !isOptNum(b.resolutionTo)) return "rango de resolución inválido";
  return null;
}

function requireValidReceipt(req, res, next) {
  const error = validateReceiptPayload(req.body);
  if (error) return res.status(400).json({ success: false, error });
  next();
}

// El logo es una copia local (no se lee del public/ de admin-frontend —
// print-server es un paquete aparte que puede correr en una máquina
// distinta). Se redimensiona/prepara UNA sola vez al arrancar:
// se reduce a un ancho fijo de 384px y se convierte a escala de grises con
// alto contraste para nitidez en papel térmico.
const LOGO_PATH = path.join(__dirname, "assets", "logo.png");
const LOGO_PRINT_WIDTH = 384;

let logoAssetsPromise = null;
function getLogoAssets() {
  if (!logoAssetsPromise) {
    logoAssetsPromise = sharp(LOGO_PATH)
      .resize({ width: LOGO_PRINT_WIDTH })
      .grayscale()
      .normalize()
      .png()
      .toBuffer()
      .then(async (buffer) => ({
        escposImage: await Image.load(buffer, "image/png"),
        dataUri: `data:image/png;base64,${buffer.toString("base64")}`,
      }))
      .catch((err) => {
        console.error("[print-server] No se pudo preparar el logo para impresión:", err);
        return { escposImage: null, dataUri: null };
      });
  }
  return logoAssetsPromise;
}

getLogoAssets();

// Anchos de columna compartidos entre la impresión real (tableCustom) y la vista previa en HTML.
const TWO_COL_WIDTHS = [0.5, 0.5];
const ITEM_COL_WIDTHS = [0.4, 0.15, 0.2, 0.25];

function money(n) {
  return `$${Number(n).toLocaleString("es-CO")}`;
}

function dianProviderAttribution(provider) {
  if (provider === "FACTUS") {
    return "Documento electrónico emitido a través de Factus, proveedor tecnológico autorizado por la DIAN.";
  }
  if (provider === "SIIGO") {
    return "Documento electrónico emitido a través de Siigo, proveedor tecnológico autorizado por la DIAN.";
  }
  return "Documento electrónico emitido a través de un proveedor tecnológico autorizado por la DIAN.";
}

const COLOMBIA_TIME_ZONE = "America/Bogota";
function formatBogotaDateTime(date) {
  return date.toLocaleString("es-CO", { timeZone: COLOMBIA_TIME_ZONE });
}

/**
 * POST /print-receipt
 * Manda el recibo a la impresora térmica USB conectada a esta máquina.
 *
 * Solo encola: el trabajo se hace dentro de `runPrintJob`, que SIEMPRE
 * libera el interface-claim USB (printer.close + device.close) en un
 * `finally` — esa es la pieza que evita que un job que falló a la mitad
 * bloquee el puerto y haga que DiDi (u otro cliente) "deje de imprimir".
 */
app.post("/print-receipt", requireValidReceipt, async (req, res) => {
  const jobId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  console.log(`[print-server] [job ${jobId}] enqueued`);
  try {
    await printQueue.enqueue(() => runPrintJob(req.body, jobId));
    res.json({ success: true, jobId, message: "Receipt printed successfully" });
  } catch (error) {
    console.error(`[print-server] [job ${jobId}] failed:`, error);
    res.status(500).json({ success: false, jobId, error: error.message || "Print failed" });
  }
});

/**
 * Construye y manda UN recibo a la impresora. Garantiza que `printer.close()`
 * y `device.close()` se ejecuten en TODAS las rutas (éxito, excepción,
 * timeout) — esto es lo que evita que un trabajo a medias deje el puerto
 * USB bloqueado.
 */
async function runPrintJob(payload, jobId) {
  const {
    branch,
    branchAddress,
    branchPhone,
    invoiceId,
    items = [],
    subtotal,
    total,
    cashier,
    paymentMethod,
    dianProvider = "LEGACY",
    showDianBlock,
    cufe,
    qrCodeUrl,
    dianInvoiceNumber,
    resolutionNumber,
    resolutionPrefix,
    resolutionFrom,
    resolutionTo,
  } = payload;

  let device = null;
  let printer = null;
  try {
    try {
      device = new USBAdapter();
    } catch (err) {
      throw new Error("Thermal printer not connected or busy");
    }

    // Reintenta hasta 3 veces si otro cliente (driver de DiDi, otro
    // servicio) tiene el interface-claim en ese instante. Ver `openWithRetry`
    // arriba.
    await openWithRetry(device);

    // 1. CODIFICACIÓN EN ESPAÑOL (PC850 / Latin-1)
    // Permite imprimir tildes, eñes y signos como "¡" sin caracteres raros.
    const printerOptions = { encoding: "850" };
    printer = new Printer(device, printerOptions);

    // ESC @ — resetea TODO el estado de hardware de la impresora al
    // arrancar cada trabajo. Limpia cualquier basura residual de un job
    // previo (típico: un trabajo de DiDi que se cayó a la mitad justo
    // antes de que nos cedieran el puerto).
    printer.hardware("init");

    // Normaliza items: campos faltantes se rellenan con defaults tolerantes
    // (mismo criterio que `validateReceiptPayload` relajado, arriba). Esto
    // permite imprimir/previsualizar ventas con data parcial sin tronar el
    // render: nombre "Producto", numéricos → 0.
    const safeItems = items.map((it) => ({
      name: typeof it?.name === "string" ? it.name : "Producto",
      quantity: toSafeNumber(it?.quantity) ?? 0,
      price: toSafeNumber(it?.price) ?? 0,
      subtotal: toSafeNumber(it?.subtotal) ?? 0,
    }));
    // `subtotal`/`total` a nivel de venta — `validateReceiptPayload` ya
    // garantiza que estos son números legibles; los pasamos por `toSafeNumber`
    // igual para no asumir nada.
    const safeSubtotal = toSafeNumber(subtotal) ?? 0;
    const safeTotal = toSafeNumber(total) ?? 0;

    // Encabezado: Logo + Nombre + Datos de la sede
    printer.align("ct");
    const { escposImage } = await getLogoAssets();
    if (escposImage) {
      await printer.image(escposImage, "d24");
    }
    printer
      .style("b")
      .size(1, 1)
      .text("Mecatos el Santi")
      .size(0, 0)
      .style("normal")
      .text(`NIT: ${BUSINESS_NIT}`)
      .text(branch || "")
      .text(branchAddress || "")
      .text(branchPhone || "")
      .text("================================");

    if (dianInvoiceNumber && dianProvider !== "MOCK") {
      printer.align("ct").text(`Factura electrónica de venta No. ${dianInvoiceNumber}`);
    }

    // Datos del Ticket y Cajero
    printer.align("lt");
    printer.tableCustom([
      { text: `Ticket: ${invoiceId}`, align: "LEFT", width: TWO_COL_WIDTHS[0] },
      { text: formatBogotaDateTime(new Date()), align: "RIGHT", width: TWO_COL_WIDTHS[1] },
    ]);
    printer.tableCustom([
      { text: `Atendido por: ${cashier}`, align: "LEFT", width: TWO_COL_WIDTHS[0] },
      { text: paymentMethod, align: "RIGHT", width: TWO_COL_WIDTHS[1] },
    ]);
    printer.text("================================");

    // Tabla de Ítems
    printer.tableCustom([
      { text: "Producto", align: "LEFT", width: ITEM_COL_WIDTHS[0] },
      { text: "Cant.", align: "RIGHT", width: ITEM_COL_WIDTHS[1] },
      { text: "Precio", align: "RIGHT", width: ITEM_COL_WIDTHS[2] },
      { text: "Subtotal", align: "RIGHT", width: ITEM_COL_WIDTHS[3] },
    ]);
    safeItems.forEach((item) => {
      printer.tableCustom([
        { text: item.name, align: "LEFT", width: ITEM_COL_WIDTHS[0] },
        { text: String(item.quantity), align: "RIGHT", width: ITEM_COL_WIDTHS[1] },
        { text: money(item.price), align: "RIGHT", width: ITEM_COL_WIDTHS[2] },
        { text: money(item.subtotal), align: "RIGHT", width: ITEM_COL_WIDTHS[3] },
      ]);
    });

    // Totales
    printer.text("--------------------------------");
    printer.tableCustom([
      { text: "Subtotal", align: "LEFT", width: TWO_COL_WIDTHS[0] },
      { text: money(safeSubtotal), align: "RIGHT", width: TWO_COL_WIDTHS[1] },
    ]);
    printer.style("b");
    printer.tableCustom([
      { text: "Total", align: "LEFT", width: TWO_COL_WIDTHS[0] },
      { text: money(safeTotal), align: "RIGHT", width: TWO_COL_WIDTHS[1] },
    ]);
    printer.style("normal");

    // Mensaje Final — CUFE/QR/pie legal si la venta ya está timbrada de
    // verdad (mismo criterio que SaleReceipt.tsx, `showDianBlock` ya
    // viene calculado desde ahí), si no el mensaje genérico de siempre.
    printer.align("ct").text("================================");
    if (showDianBlock) {
      printer.text("CUFE:");
      wrapText(cufe || "", 32).forEach((line) => printer.text(line));
      if (qrCodeUrl || cufe) {
        // `mode: "d24"` — misma densidad que ya usa el logo (`printer.
        // image(escposImage, "d24")` más arriba) para nitidez consistente.
        await printer.qrimage(qrCodeUrl || cufe, { type: "png", mode: "d24" });
      }
      wrapText(
        "Al pago de esta factura de venta le aplican las normas relativas a la letra de cambio (artículo 5, Ley 1231 de 2008).",
        32
      ).forEach((line) => printer.text(line));
      wrapText(
        dianProviderAttribution(dianProvider),
        32
      ).forEach((line) => printer.text(line));
      if (resolutionNumber) {
        const range = resolutionFrom != null && resolutionTo != null ? `, del ${resolutionFrom} al ${resolutionTo}` : "";
        wrapText(`Resolución DIAN No. ${resolutionNumber}, prefijo ${resolutionPrefix || ""}${range}.`, 32).forEach(
          (line) => printer.text(line)
        );
      }
    } else {
      printer.text(
        dianProvider === "MOCK"
          ? "Simulación local (MOCK); no es factura válida ante la DIAN."
          : "Factura electrónica en proceso de validación DIAN."
      );
    }
    printer.text("¡Gracias por tu compra!");

    // Avance de Papel y Corte
    //
    // `printer.cut(false, 4)` hace el corte físico Y ya hace su propio feed
    // (3 líneas por defecto en @node-escpos/core@0.6.x; acá lo subimos a 4).
    // NO llamar `.feed(...)` justo antes de `.cut(...)` — antes había un
    // `.feed(4).cut()` que resultaba en 7 líneas de avance (doble feed),
    // desperdiciando papel. Ver punto 32 de CLAUDE.md.
    printer.cut(false, 4);
    printer.cashdraw();

    // ESC @ al FINAL: deja la impresora en estado limpio para el siguiente
    // cliente (típicamente el driver USB de DiDi Food). Belt-and-suspenders:
    // combinado con el `hardware("init")` del principio, garantiza que ni
    // nuestro trabajo ni un trabajo externo a medias dejen bytes huérfanos
    // en el buffer interno de la impresora.
    printer.hardware("init");
  } finally {
    // ALWAYS release — éxito, excepción, timeout. Esta es la línea que
    // arregla el bug "DiDi dejó de imprimir" (ver punto 32 de CLAUDE.md):
    // `device.close()` libera el interface-claim de libusb; sin esto, un
    // solo trabajo a medias dejaba el puerto bloqueado hasta que se
    // desconectaba físicamente la impresora.
    if (printer) {
      try {
        await printer.close();
      } catch (e) {
        console.warn(`[print-server] [job ${jobId}] printer.close() failed:`, e);
      }
    }
    if (device) {
      try {
        await new Promise((resolve) => device.close(() => resolve(undefined)));
      } catch (e) {
        console.warn(`[print-server] [job ${jobId}] device.close() failed:`, e);
      }
    }
  }
}

/**
 * POST /preview-receipt
 * Muestra la vista previa del recibo en formato HTML para navegador.
 */
app.post("/preview-receipt", requireValidReceipt, async (req, res) => {
  try {
    const { dataUri } = await getLogoAssets();
    const html = buildReceiptHtml(req.body, dataUri);
    // CSP estricta para el HTML de la vista previa: solo imágenes `data:` y
    // estilos inline — ningún script podría ejecutarse aunque algún campo
    // escapara el `escapeHtml` de `buildReceiptHtml`.
    res
      .set("Content-Type", "text/html; charset=utf-8")
      .set("Content-Security-Policy", "default-src 'none'; img-src data:; style-src 'unsafe-inline'")
      .send(html);
  } catch (error) {
    console.error("Preview build failed:", error);
    res.status(500).json({ success: false, error: error.message || "Preview failed" });
  }
});

function twoColRow(left, right, bold) {
  return `<div class="row"${bold ? ' style="font-weight:bold"' : ""}><span style="flex:${TWO_COL_WIDTHS[0]}">${escapeHtml(
    left
  )}</span><span style="flex:${TWO_COL_WIDTHS[1]};text-align:right">${escapeHtml(right)}</span></div>`;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[c]));
}

function buildReceiptHtml(data, logoDataUri) {
  const {
    branch,
    branchAddress,
    branchPhone,
    invoiceId,
    items = [],
    subtotal,
    total,
    cashier,
    paymentMethod,
    dianProvider = "LEGACY",
    showDianBlock,
    cufe,
    qrCodeUrl,
    dianInvoiceNumber,
    resolutionNumber,
    resolutionPrefix,
    resolutionFrom,
    resolutionTo,
  } = data;

  // Mismo mecanismo que el logo (buffer PNG -> data URI) — `qr-image` ya
  // es dependencia directa de este paquete (ver arriba), independiente de
  // `printer.qrimage()` que usa el path real de impresión.
  let qrDataUri = "";
  if (showDianBlock && (qrCodeUrl || cufe)) {
    try {
      const qrBuffer = qr.imageSync(qrCodeUrl || cufe, { type: "png", size: 4 });
      qrDataUri = `data:image/png;base64,${qrBuffer.toString("base64")}`;
    } catch (err) {
      console.error("[print-server] No se pudo generar el QR para la vista previa:", err);
    }
  }

  const dianResolutionText =
    showDianBlock && resolutionNumber
      ? `Resolución DIAN No. ${resolutionNumber}, prefijo ${resolutionPrefix || ""}${
          resolutionFrom != null && resolutionTo != null ? `, del ${resolutionFrom} al ${resolutionTo}` : ""
        }.`
      : "";

  // Misma normalización tolerante que la impresión real (ver `safeItems` en
  // `runPrintJob`): un item con campos faltantes se previsualiza con
  // defaults en vez de fallar el render. El validador ya garantizó que
  // `subtotal`/`total` a nivel de venta son números legibles.
  const safeItems = items.map((it) => ({
    name: typeof it?.name === "string" ? it.name : "Producto",
    quantity: toSafeNumber(it?.quantity) ?? 0,
    price: toSafeNumber(it?.price) ?? 0,
    subtotal: toSafeNumber(it?.subtotal) ?? 0,
  }));
  const safeSubtotal = toSafeNumber(subtotal) ?? 0;
  const safeTotal = toSafeNumber(total) ?? 0;

  const itemRows = safeItems
    .map(
      (item) => `<div class="row">
        <span style="flex:${ITEM_COL_WIDTHS[0]}">${escapeHtml(item.name)}</span>
        <span style="flex:${ITEM_COL_WIDTHS[1]};text-align:right">${escapeHtml(item.quantity)}</span>
        <span style="flex:${ITEM_COL_WIDTHS[2]};text-align:right">${escapeHtml(money(item.price))}</span>
        <span style="flex:${ITEM_COL_WIDTHS[3]};text-align:right">${escapeHtml(money(item.subtotal))}</span>
      </div>`
    )
    .join("\n");

  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'" />
<title>Vista previa — recibo térmico</title>
<style>
  body { background: #ddd; margin: 0; padding: 24px; display: flex; justify-content: center; font-family: "Courier New", Courier, monospace; }
  .paper { background: #fff; width: 320px; padding: 16px; box-shadow: 0 2px 12px rgba(0,0,0,0.25); font-size: 13px; line-height: 1.35; color: #111; }
  .center { text-align: center; }
  .row { display: flex; gap: 8px; }
  .row > span { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .logo { width: 100%; display: block; margin: 0 auto 8px; image-rendering: pixelated; }
  .sep { border: none; border-top: 1px dashed #000; margin: 6px 0; }
  .sep-solid { border: none; border-top: 1px solid #000; margin: 6px 0; }
  .name { font-weight: bold; font-size: 16px; }
  .muted { color: #333; }
  .note { padding: 6px 0; }
  .bottom { padding-bottom: 30px }
</style>
</head>
<body>
  <div class="paper">
    <div class="center">
      ${logoDataUri ? `<img class="logo" src="${logoDataUri}" alt="logo" />` : ""}
      <div class="name">Mecatos el Santi</div>
      <div>NIT: ${escapeHtml(BUSINESS_NIT)}</div>
      <div>${escapeHtml(branch)}</div>
      <div>${escapeHtml(branchAddress)}</div>
      <div>${escapeHtml(branchPhone)}</div>
    </div>
    <hr class="sep-solid" />
    ${dianInvoiceNumber && dianProvider !== "MOCK" ? `<div class="center" style="font-weight:600">Factura electrónica de venta No. ${escapeHtml(dianInvoiceNumber)}</div>` : ""}
    ${twoColRow(`Ticket: ${invoiceId}`, formatBogotaDateTime(new Date()))}
    ${twoColRow(`Atendido por: ${cashier}`, paymentMethod)}
    <hr class="sep-solid" />
    <div class="row muted" style="font-size:11px">
      <span style="flex:${ITEM_COL_WIDTHS[0]}">Producto</span>
      <span style="flex:${ITEM_COL_WIDTHS[1]};text-align:right">Cant.</span>
      <span style="flex:${ITEM_COL_WIDTHS[2]};text-align:right">Precio</span>
      <span style="flex:${ITEM_COL_WIDTHS[3]};text-align:right">Subtotal</span>
    </div>
    ${itemRows}
    <hr class="sep" />
    ${twoColRow("Subtotal", money(safeSubtotal))}
    ${twoColRow("Total", money(safeTotal), true)}
    <hr class="sep-solid" />
    ${
      showDianBlock
        ? `<div class="center note" style="font-size:11px">
      <div style="font-weight:600">CUFE</div>
      <div style="word-break:break-all">${escapeHtml(cufe)}</div>
      ${qrDataUri ? `<img src="${qrDataUri}" alt="QR" style="width:120px;height:120px;margin:6px auto;display:block" />` : ""}
      <div style="margin-top:4px">Al pago de esta factura de venta le aplican las normas relativas a la letra de cambio (artículo 5, Ley 1231 de 2008).</div>
       <div style="margin-top:4px">${escapeHtml(dianProviderAttribution(dianProvider))}</div>
      ${dianResolutionText ? `<div style="margin-top:4px">${escapeHtml(dianResolutionText)}</div>` : ""}
    </div>`
        : `<div class="center note">
      <div>${dianProvider === "MOCK" ? "Simulación local (MOCK); no es factura válida ante la DIAN." : "Factura electrónica en proceso de validación DIAN."}</div>
    </div>`
    }
    <div class="center note bottom">¡Gracias por tu compra!</div>
  </div>
</body>
</html>`;
}

// GET /health — probe liviano (no toca el USB ni la cola): útil para un
// monitor externo (UptimeRobot, etc.) y para confirmar que no hay jobs
// atascados. Mismo patrón que `GET /health` del backend (punto 58 del
// CLAUDE.md raíz).
app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    queueDepth: printQueue.queue.length,
    runningJob: !!printQueue.activeJob,
  });
});

// Solo loopback — ver "Aislamiento del servicio" arriba.
app.listen(PORT, HOST, () => {
  console.log(`[print-server] Servicio de impresión térmica activo en http://${HOST}:${PORT}`);
  console.log(`[print-server] Orígenes permitidos: ${allowedOrigins.join(", ")}`);
});
