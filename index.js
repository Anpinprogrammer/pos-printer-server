const path = require("path");
const express = require("express");
const cors = require("cors");
const sharp = require("sharp");
const { Printer, Image } = require("@node-escpos/core");
const USBAdapter = require("@node-escpos/usb-adapter");

const app = express();
app.use(cors());
app.use(express.json());

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

const COLOMBIA_TIME_ZONE = "America/Bogota";
function formatBogotaDateTime(date) {
  return date.toLocaleString("es-CO", { timeZone: COLOMBIA_TIME_ZONE });
}

/**
 * POST /print-receipt
 * Manda el recibo a la impresora térmica USB conectada a esta máquina.
 */
app.post("/print-receipt", async (req, res) => {
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
  } = req.body;

  let device;
  try {
    device = new USBAdapter();
  } catch (err) {
    console.error("Printer detection error:", err);
    return res.status(500).json({ success: false, error: "Thermal printer not connected or busy" });
  }

  try {
    await new Promise((resolve, reject) => {
      device.open((err) => (err ? reject(err) : resolve(undefined)));
    });

    // 1. CODIFICACIÓN EN ESPAÑOL (PC850 / Latin-1)
    // Permite imprimir tildes, eñes y signos como "¡" sin caracteres raros.
    const printerOptions = {
      encoding: "850",
    };
    const printer = new Printer(device, printerOptions);

    // Recompone el estado de hardware de la impresora
    printer.hardware("init");

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
      .text(branch || "")
      .text(branchAddress || "")
      .text(branchPhone || "")
      .text("================================");

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
    items.forEach((item) => {
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
      { text: money(subtotal), align: "RIGHT", width: TWO_COL_WIDTHS[1] },
    ]);
    printer.style("b");
    printer.tableCustom([
      { text: "Total", align: "LEFT", width: TWO_COL_WIDTHS[0] },
      { text: money(total), align: "RIGHT", width: TWO_COL_WIDTHS[1] },
    ]);
    printer.style("normal");

    // Mensaje Final, Avance de Papel y Corte
    printer
      .align("ct")
      .text("================================")
      .text("Factura electrónica en proceso de validación DIAN.")
      .text("¡Gracias por tu compra!")
      .feed(4) // <--- AVANZA 4 LÍNEAS PARA QUE EL TEXTO REBASA LA GUILLOTINA ANTES DE CORTAR
      .cut()   // Realiza el corte físico del papel
      .cashdraw();

    // Cierra el puerto USB enviando el buffer restante
    await printer.close();

    res.json({ success: true, message: "Receipt printed successfully" });
  } catch (error) {
    console.error("Print execution failed:", error);
    res.status(500).json({ success: false, error: error.message || "Print failed" });
  }
});

/**
 * POST /preview-receipt
 * Muestra la vista previa del recibo en formato HTML para navegador.
 */
app.post("/preview-receipt", async (req, res) => {
  try {
    const { dataUri } = await getLogoAssets();
    const html = buildReceiptHtml(req.body, dataUri);
    res.set("Content-Type", "text/html; charset=utf-8").send(html);
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
  } = data;

  const itemRows = items
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
      <div>${escapeHtml(branch)}</div>
      <div>${escapeHtml(branchAddress)}</div>
      <div>${escapeHtml(branchPhone)}</div>
    </div>
    <hr class="sep-solid" />
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
    ${twoColRow("Subtotal", money(subtotal))}
    ${twoColRow("Total", money(total), true)}
    <hr class="sep-solid" />
    <div class="center note bottom">
      <div>Factura electrónica en proceso de validación DIAN.</div>
      <div>¡Gracias por tu compra!</div>
    </div>
  </div>
</body>
</html>`;
}

const PORT = process.env.PRINT_SERVER_PORT || 4001;
app.listen(PORT, () => {
  console.log(`[print-server] Servicio de impresión térmica activo en http://localhost:${PORT}`);
});