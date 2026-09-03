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
// distinta, ver punto 32 de CLAUDE.md). Se redimensiona/prepara UNA sola
// vez al arrancar (no en cada impresión): la imagen original es a color y
// de alta resolución (815x614, pensada para pantalla), muy por encima de
// lo que una impresora térmica puede/necesita imprimir — se reduce a un
// ancho fijo de 384px (seguro tanto para papel de 58mm como de 80mm) y se
// convierte a escala de grises con más contraste, para que el
// medio-tono/dithering que hace @node-escpos/core al imprimir se vea
// nítido en papel térmico (blanco y negro puro), no borroso. El mismo
// buffer procesado se reutiliza para /print-receipt (convertido a Image
// de @node-escpos/core) y para /preview-receipt (como data URI en el
// <img> del HTML) — no se procesa dos veces.
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
// Se prepara apenas arranca el servidor, no en la primera impresión —
// así el primer recibo del día no espera el procesamiento de la imagen.
getLogoAssets();

// Anchos de columna compartidos entre la impresión real (tableCustom) y
// la vista previa en HTML (flexbox) — si cambias una proporción, cambia
// la otra, o la vista previa deja de reflejar lo que se imprime.
const TWO_COL_WIDTHS = [0.5, 0.5];
const ITEM_COL_WIDTHS = [0.4, 0.15, 0.2, 0.25];

function money(n) {
  return `$${Number(n).toLocaleString("es-CO")}`;
}

// El negocio es 100% en Colombia — la fecha/hora del ticket debe verse en
// Bogotá sin importar el reloj/zona horaria configurado en la máquina
// física donde corre este servidor (que puede no estar bien configurado,
// a diferencia de un servidor en la nube). `timeZone` explícito evita
// depender de eso.
const COLOMBIA_TIME_ZONE = "America/Bogota";
function formatBogotaDateTime(date) {
  return date.toLocaleString("es-CO", { timeZone: COLOMBIA_TIME_ZONE });
}

/**
 * POST /print-receipt
 * Recibe un recibo ya armado (branch/branchAddress/branchPhone/invoiceId/
 * items/subtotal/tax/total/cashier/paymentMethod — ver PrintReceiptPayload
 * en printerService.ts, duplicado en admin-frontend/src/services/ y
 * src/cajero/services/) y lo manda a la impresora térmica USB conectada a
 * ESTA máquina física. El formato imita EXACTAMENTE al recibo en pantalla
 * (SaleReceipt.tsx): logo, "Mecatos el Santi", datos de la sede, ticket/
 * fecha, cajero/método de pago, tabla de ítems con encabezado
 * (Producto/Cant./Precio/Subtotal), subtotal/impuesto/total, y el aviso de
 * DIAN. No hay cola ni reintento: si la impresora no responde, se
 * devuelve un error 500 y el frontend cae de vuelta a window.print() —
 * ver docs/THERMAL_PRINTER_INTEGRATION.md para el diseño completo.
 */
app.post("/print-receipt", async (req, res) => {
  const {
    branch,
    branchAddress,
    branchPhone,
    invoiceId,
    items,
    subtotal,
    tax,
    total,
    cashier,
    paymentMethod,
  } = req.body;

  let device;
  try {
    // Autodetecta la primera impresora USB conectada. Si hay más de un
    // dispositivo USB de tipo impresora en la máquina, usa
    // `new USBAdapter(vid, pid)` con el vendor/product id específico —
    // ver README.md de este paquete para cómo encontrarlos.
    device = new USBAdapter();
  } catch (err) {
    console.error("Printer detection error:", err);
    return res.status(500).json({ success: false, error: "Thermal printer not connected or busy" });
  }

  try {
    await new Promise((resolve, reject) => {
      device.open((err) => (err ? reject(err) : resolve(undefined)));
    });

    const printer = new Printer(device, {});

    // Encabezado: logo + nombre + datos de la sede — mismo orden que
    // SaleReceipt.tsx en pantalla. Si el logo no se pudo preparar
    // (ver getLogoAssets), se sigue sin él en vez de fallar todo el
    // recibo.
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

    // Ticket/fecha y cajero/método de pago en dos columnas — igual que
    // los `flex justify-between` del recibo en pantalla.
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

    // Tabla de ítems CON encabezado — mismas 4 columnas que la tabla en
    // pantalla (Producto/Cant./Precio/Subtotal), no solo 2.
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

    printer.text("--------------------------------");
    printer.tableCustom([
      { text: "Subtotal", align: "LEFT", width: TWO_COL_WIDTHS[0] },
      { text: money(subtotal), align: "RIGHT", width: TWO_COL_WIDTHS[1] },
    ]);
    printer.tableCustom([
      { text: "Impuesto (INC)", align: "LEFT", width: TWO_COL_WIDTHS[0] },
      { text: money(tax), align: "RIGHT", width: TWO_COL_WIDTHS[1] },
    ]);
    printer.style("b");
    printer.tableCustom([
      { text: "Total", align: "LEFT", width: TWO_COL_WIDTHS[0] },
      { text: money(total), align: "RIGHT", width: TWO_COL_WIDTHS[1] },
    ]);
    printer.style("normal");

    printer
      .align("ct")
      .text("================================")
      .text("Factura electrónica en proceso de validación DIAN.")
      .text("¡Gracias por tu compra!")
      .cut() // ya hace su propio feed antes de cortar (default 3 líneas)
      .cashdraw();

    // close() hace flush() del buffer (manda todo a la impresora) y
    // después cierra el dispositivo USB — no hace falta llamar flush()
    // aparte.
    await printer.close();

    res.json({ success: true, message: "Receipt printed successfully" });
  } catch (error) {
    console.error("Print execution failed:", error);
    res.status(500).json({ success: false, error: error.message || "Print failed" });
  }
});

/**
 * POST /preview-receipt
 * Mismo body que /print-receipt, pero en vez de mandar nada a una
 * impresora física devuelve una página HTML que imita el recibo impreso
 * (mismo ancho de "papel", misma fuente monoespaciada, mismas
 * proporciones de columna en las tablas, el logo ya procesado). Pensado
 * para revisar el formato/los datos sin tener la impresora térmica a la
 * mano — no reemplaza una prueba real (el dithering del logo y el
 * espaciado exacto de fuente de la impresora real pueden variar), pero
 * confirma que el contenido y el layout son correctos antes de probar en
 * hardware real. No toca USB para nada.
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
    tax,
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
  /* Una impresora térmica real no ajusta el texto a una segunda línea
     dentro de una misma columna de tabla — lo trunca (o se desborda
     sobre la columna vecina, según el modelo). nowrap + ellipsis imitan
     mejor ese comportamiento que dejar que el texto haga wrap como en
     una página web normal — si ves puntos suspensivos acá, es una señal
     real de que ese texto no cabe en la columna en la impresora física. */
  .row { display: flex; gap: 8px; }
  .row > span { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .logo { width: 100%; display: block; margin: 0 auto 8px; image-rendering: pixelated; }
  .sep { border: none; border-top: 1px dashed #000; margin: 6px 0; }
  .sep-solid { border: none; border-top: 1px solid #000; margin: 6px 0; }
  .name { font-weight: bold; font-size: 16px; }
  .muted { color: #333; }
  .note { padding: 6px 0; }
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
    ${twoColRow("Impuesto (INC)", money(tax))}
    ${twoColRow("Total", money(total), true)}
    <hr class="sep-solid" />
    <div class="center note">
      <div>Factura electrónica en proceso de validación DIAN.</div>
      <div>¡Gracias por tu compra!</div>
    </div>
  </div>
</body>
</html>`;
}

// Puerto distinto del backend real (que ya usa 4000) — ver punto sobre
// esto en CLAUDE.md y docs/THERMAL_PRINTER_INTEGRATION.md.
const PORT = process.env.PRINT_SERVER_PORT || 4001;
app.listen(PORT, () => {
  console.log(`[print-server] Servicio de impresión térmica activo en http://localhost:${PORT}`);
});
