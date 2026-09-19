const path = require("path");
const express = require("express");
const cors = require("cors");
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
    showDianBlock,
    cufe,
    qrCodeUrl,
    dianInvoiceNumber,
    resolutionNumber,
    resolutionPrefix,
    resolutionFrom,
    resolutionTo,
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
      .text(`NIT: ${BUSINESS_NIT}`)
      .text(branch || "")
      .text(branchAddress || "")
      .text(branchPhone || "")
      .text("================================");

    if (dianInvoiceNumber) {
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
        "Documento electrónico emitido a través de Siigo S.A.S., proveedor tecnológico autorizado por la DIAN.",
        32
      ).forEach((line) => printer.text(line));
      if (resolutionNumber) {
        const range = resolutionFrom != null && resolutionTo != null ? `, del ${resolutionFrom} al ${resolutionTo}` : "";
        wrapText(`Resolución DIAN No. ${resolutionNumber}, prefijo ${resolutionPrefix || ""}${range}.`, 32).forEach(
          (line) => printer.text(line)
        );
      }
    } else {
      printer.text("Factura electrónica en proceso de validación DIAN.");
    }
    printer.text("¡Gracias por tu compra!");

    // Avance de Papel y Corte
    printer
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
      <div>NIT: ${escapeHtml(BUSINESS_NIT)}</div>
      <div>${escapeHtml(branch)}</div>
      <div>${escapeHtml(branchAddress)}</div>
      <div>${escapeHtml(branchPhone)}</div>
    </div>
    <hr class="sep-solid" />
    ${dianInvoiceNumber ? `<div class="center" style="font-weight:600">Factura electrónica de venta No. ${escapeHtml(dianInvoiceNumber)}</div>` : ""}
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
    ${
      showDianBlock
        ? `<div class="center note" style="font-size:11px">
      <div style="font-weight:600">CUFE</div>
      <div style="word-break:break-all">${escapeHtml(cufe)}</div>
      ${qrDataUri ? `<img src="${qrDataUri}" alt="QR" style="width:120px;height:120px;margin:6px auto;display:block" />` : ""}
      <div style="margin-top:4px">Al pago de esta factura de venta le aplican las normas relativas a la letra de cambio (artículo 5, Ley 1231 de 2008).</div>
      <div style="margin-top:4px">Documento electrónico emitido a través de Siigo S.A.S., proveedor tecnológico autorizado por la DIAN.</div>
      ${dianResolutionText ? `<div style="margin-top:4px">${escapeHtml(dianResolutionText)}</div>` : ""}
    </div>`
        : `<div class="center note">
      <div>Factura electrónica en proceso de validación DIAN.</div>
    </div>`
    }
    <div class="center note bottom">¡Gracias por tu compra!</div>
  </div>
</body>
</html>`;
}

const PORT = process.env.PRINT_SERVER_PORT || 4001;
app.listen(PORT, () => {
  console.log(`[print-server] Servicio de impresión térmica activo en http://localhost:${PORT}`);
});