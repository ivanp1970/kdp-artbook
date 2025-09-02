import React, { useMemo, useState } from "react";
import { jsPDF } from "jspdf";

// Converte newline di vario tipo in \n
const nl = (s) => (s || "").replace(/\r\n?|\u2028|\u2029/g, "\n");

/**
 * Pagina il testo usando la stessa logica dell'export:
 * - unità in pollici
 * - larghezza = pageW - 2*m, altezza utile = pageH - 2*m
 * - leading = (fontSize/72) * lineHeight (in pollici)
 * - +0.5 leading dopo ogni paragrafo
 * - aggiunge pagina del titolo e (se presente) pagine di introduzione/bibliografia
 */
function paginateToLines({
  body,
  title,
  author,
  intro,
  bibliography,
  pageW,
  pageH,
  marginIn,
  fontSize,
  lineHeight,
  useSerif,
}) {
  const doc = new jsPDF({ unit: "in", format: [pageW, pageH], orientation: "portrait" });
  doc.setFont(useSerif ? "Times" : "Helvetica", "normal");
  doc.setFontSize(fontSize);

  const leading = (fontSize / 72) * lineHeight; // in
  const contentW = pageW - marginIn * 2;
  const contentH = pageH - marginIn * 2;

  const pages = [];

  // 1) Pagina del titolo (semplice)
  if ((title || "").trim()) {
    pages.push({
      type: "title",
      lines: [
        { text: title, align: "center", size: fontSize + 8, bold: true },
        ...(author ? [{ text: author, align: "center", size: fontSize + 2 }] : []),
      ],
    });
  }

  // Helper: aggiunge testo normale su più pagine
  function addFlowText(label, text) {
    if (!text || !text.trim()) return;
    // intestazione
    let curPage = { type: "text", lines: [] };
    let curY = marginIn;
    const pushPage = () => {
      pages.push(curPage);
      curPage = { type: "text", lines: [] };
      curY = marginIn;
    };

    // Titolo sezione (es. "Introduzione", "Appendici e Bibliografia")
    if (label) {
      curPage.lines.push({ text: label, x: marginIn, y: curY, size: fontSize + 3, bold: true });
      curY += leading * 1.2;
    }

    // Paragrafi con wrap
    const paragraphs = nl(text).split(/\n\n+/);
    for (const p of paragraphs) {
      const lines = doc.splitTextToSize(p, contentW);
      for (const ln of lines) {
        if (curY + leading > pageH - marginIn) {
          // pagina piena
          pushPage();
        }
        curPage.lines.push({ text: ln, x: marginIn, y: curY, size: fontSize });
        curY += leading;
      }
      // spazio tra paragrafi
      if (curY + leading * 0.5 > pageH - marginIn) {
        pushPage();
      } else {
        curY += leading * 0.5;
      }
    }

    // ultima pagina rimasta
    if (curPage.lines.length) pages.push(curPage);
  }

  // 2) Introduzione (se c'è)
  if (intro && intro.trim()) addFlowText("Introduzione", intro);

  // 3) Corpo principale
  addFlowText(null, body || "");

  // 4) Bibliografia/Appendici
  if (bibliography && bibliography.trim()) addFlowText("Appendici e Bibliografia", bibliography);

  return { pages, pageW, pageH, marginIn, leading, fontSize, useSerif };
}

export default function FinalPreview(props) {
  const {
    body,
    title,
    author,
    intro,
    bibliography,
    trimW,
    trimH,
    bleed,
    marginIn,
    fontSize,
    lineHeight,
    useSerif,
  } = props;

  const pageW = (trimW || 6) + (bleed ? 0.125 : 0); // KDP: bleed aggiunge 0.125" a W e 0.25" a H complessivi
  const pageH = (trimH || 9) + (bleed ? 0.25 : 0);

  const [zoom, setZoom] = useState(0.9); // 0.5–2.0
  const [spreads, setSpreads] = useState(true);

  const layout = useMemo(
    () =>
      paginateToLines({
        body,
        title,
        author,
        intro,
        bibliography,
        pageW,
        pageH,
        marginIn,
        fontSize,
        lineHeight,
        useSerif,
      }),
    [body, title, author, intro, bibliography, pageW, pageH, marginIn, fontSize, lineHeight, useSerif]
  );

  const inch = 96; // 1in = 96px nel browser
  const pageStyle = {
    width: `${pageW * inch * zoom}px`,
    height: `${pageH * inch * zoom}px`,
  };
  const contentStyle = {
    padding: `${marginIn * inch * zoom}px`,
    fontFamily: useSerif ? "serif" : "system-ui",
    fontSize: `${fontSize * (zoom * 1)}px`,
    lineHeight: lineHeight,
  };

  // Raggruppa in doppie pagine
  const pagePairs = [];
  for (let i = 0; i < layout.pages.length; i += 2) {
    pagePairs.push([layout.pages[i], layout.pages[i + 1] || null]);
  }

  return (
    <div className="bg-white rounded-2xl shadow p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="font-semibold">Anteprima finale (impaginata)</h3>
        <div className="flex items-center gap-3 text-sm">
          <label className="inline-flex items-center gap-2">
            <input type="checkbox" checked={spreads} onChange={(e) => setSpreads(e.target.checked)} />
            Doppia pagina
          </label>
          <span>Zoom</span>
          <input
            type="range"
            min="0.5"
            max="2"
            step="0.05"
            value={zoom}
            onChange={(e) => setZoom(parseFloat(e.target.value) || 1)}
          />
          <span className="w-10 text-right">{Math.round(zoom * 100)}%</span>
          <span className="text-neutral-500">Pagine: {layout.pages.length}</span>
        </div>
      </div>

      {/* Render */}
      {!spreads && (
        <div className="grid grid-cols-1 gap-6">
          {layout.pages.map((pg, idx) => (
            <div key={idx} className="mx-auto border rounded-xl overflow-hidden bg-neutral-50" style={pageStyle}>
              {pg.type === "title" ? (
                <div className="w-full h-full flex flex-col items-center justify-center text-center" style={contentStyle}>
                  {pg.lines.map((ln, i) => (
                    <div key={i} style={{ fontWeight: ln.bold ? 700 : 400, fontSize: `${ln.size * zoom}px` }}>
                      {ln.text}
                    </div>
                  ))}
                </div>
              ) : (
                <div className="w-full h-full" style={contentStyle}>
                  {pg.lines.map((ln, i) => (
                    <div key={i}>{ln.text}</div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {spreads && (
        <div className="grid grid-cols-1 gap-8">
          {pagePairs.map((pair, i) => (
            <div key={i} className="flex justify-center gap-6">
              {pair.map((pg, j) =>
                pg ? (
                  <div key={j} className="border rounded-xl overflow-hidden bg-neutral-50" style={pageStyle}>
                    {pg.type === "title" ? (
                      <div className="w-full h-full flex flex-col items-center justify-center text-center" style={contentStyle}>
                        {pg.lines.map((ln, k) => (
                          <div key={k} style={{ fontWeight: ln.bold ? 700 : 400, fontSize: `${ln.size * zoom}px` }}>
                            {ln.text}
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="w-full h-full" style={contentStyle}>
                        {pg.lines.map((ln, k) => (
                          <div key={k}>{ln.text}</div>
                        ))}
                      </div>
                    )}
                  </div>
                ) : (
                  <div key={j} style={{ ...pageStyle, visibility: "hidden" }} />
                )
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
