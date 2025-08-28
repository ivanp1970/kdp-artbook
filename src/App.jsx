import React, { useEffect, useMemo, useRef, useState } from "react";
import { jsPDF } from "jspdf";

/**
 * KDP ArtBook Builder – Caravaggio (v6)
 *
 * Novità:
 * - Ridimensiona immagine per opera: scala (%) + offset X/Y (cover/crop o dentro i margini)
 * - Override dimensione testo per opera
 * - Anteprima 1:1 aggiornata (rispetta scala/offset/text override)
 * - Salva bozza (file .kdpbook.json) + Carica bozza (nessun DB richiesto)
 * - KDP checker (pagine minime, margini, DPI), formati fotolibro e bleed
 */

const TRIMS = [
  { key: "6x9", w: 6, h: 9, label: "6 × 9 in (15.24 × 22.86 cm)" },
  { key: "8x10", w: 8, h: 10, label: "8 × 10 in (20.32 × 25.4 cm)" },
  { key: "8.25x11", w: 8.25, h: 11, label: "8.25 × 11 in (20.96 × 27.94 cm)" },
  { key: "8.5x11", w: 8.5, h: 11, label: "8.5 × 11 in (21.59 × 27.94 cm)" },
  { key: "9x12", w: 9, h: 12, label: "9 × 12 in – fotolibro" },
  { key: "10x13", w: 10, h: 13, label: "10 × 13 in – fotolibro" },
  { key: "11x14", w: 11, h: 14, label: "11 × 14 in – fotolibro" },
  { key: "square8.25", w: 8.25, h: 8.25, label: "Quadrato 8.25 × 8.25 in" },
  { key: "square10", w: 10, h: 10, label: "Quadrato 10 × 10 in – fotolibro" },
  { key: "custom", w: 9.8, h: 13.4, label: "Personalizzato (imposta sotto)" }, // ~25×34 cm
];

const INK_OPTIONS = [
  { key: "premium_color", label: "Premium Color" },
  { key: "standard_color", label: "Standard Color" },
  { key: "bw", label: "B/N" },
];

const CSS_PPI = 96; // px/inch per anteprima a schermo

function pxNeeded(widthIn, heightIn, dpi = 300) {
  return { w: Math.round(widthIn * dpi), h: Math.round(heightIn * dpi) };
}
function calcBleedSize(trimW, trimH, bleed) {
  if (!bleed) return { w: trimW, h: trimH };
  // KDP bleed: +0.125" W, +0.25" H
  return { w: trimW + 0.125, h: trimH + 0.25 };
}

export default function KdpArtBookBuilder() {
  const fileInputRef = useRef(null);
  const draftFileInputRef = useRef(null);

  // immagini/items
  const [items, setItems] = useState([]); // {id,name,src,width,height,title,description,warnings,scalePct,offX,offY,textSize}
  const [selectedIndex, setSelectedIndex] = useState(0);

  // libro
  const [bookTitle, setBookTitle] = useState("Caravaggio – Opere");
  const [author, setAuthor] = useState("");
  const [includeTitlePage, setIncludeTitlePage] = useState(true);
  const [inkType, setInkType] = useState("premium_color");

  // impaginazione
  const [trimKey, setTrimKey] = useState("8.25x11");
  const [customW, setCustomW] = useState(9.8);
  const [customH, setCustomH] = useState(13.4);
  const baseTrim = useMemo(() => {
    const t = TRIMS.find((t) => t.key === trimKey) || TRIMS[0];
    return t.key === "custom" ? { ...t, w: customW, h: customH } : t;
  }, [trimKey, customW, customH]);

  const [bleed, setBleed] = useState(false);
  const [fullBleedLeft, setFullBleedLeft] = useState(false);
  const [marginIn, setMarginIn] = useState(0.5);
  const [fontSize, setFontSize] = useState(11);
  const [lineHeight, setLineHeight] = useState(1.35);
  const [useSerif, setUseSerif] = useState(true);

  // AI
  const [apiKey, setApiKey] = useState("");
  useEffect(() => {
    const k = localStorage.getItem("OPENAI_API_KEY") || "";
    if (k) setApiKey(k);
  }, []);
  function saveKey() {
    localStorage.setItem("OPENAI_API_KEY", apiKey || "");
    alert("Chiave salvata sul browser attuale.");
  }

  // anteprima 1:1
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewZoom, setPreviewZoom] = useState(1);
  const [showGuides, setShowGuides] = useState(true);

  const trimWithBleed = useMemo(
    () => calcBleedSize(baseTrim.w, baseTrim.h, bleed),
    [baseTrim, bleed]
  );
  const fontClass = useSerif ? "font-serif" : "font-sans";

  // ---------- Import immagini ----------
  function onFilesSelected(files) {
    const arr = Array.from(files || []);
    if (!arr.length) return;
    const readers = arr.map((file, idx) =>
      new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = (e) => {
          const src = e.target.result;
          const img = new Image();
          img.onload = () => {
            resolve({
              id: `${Date.now()}_${idx}`,
              name: file.name,
              src,
              width: img.width,
              height: img.height,
              title: file.name.replace(/\.[^/.]+$/, ""),
              description: "",
              warnings: [],
              scalePct: 100,
              offX: 0, // -50..50 (%)
              offY: 0, // -50..50 (%)
              textSize: null, // override (pt) o null per usare globale
            });
          };
          img.src = src;
        };
        reader.readAsDataURL(file);
      })
    );
    Promise.all(readers).then((newItems) => {
      const validated = newItems.map((it) => ({ ...it, warnings: validateImage(it) }));
      setItems((prev) => {
        const merged = [...prev, ...validated];
        if (prev.length === 0) setSelectedIndex(0);
        return merged;
      });
    });
  }

  // ---------- Validazione immagini (DPI 300) ----------
  function validateImage(it) {
    const { w: pageW, h: pageH } = trimWithBleed;
    const m = marginIn;
    const boxW = fullBleedLeft ? pageW : pageW - m * 2;
    const boxH = fullBleedLeft ? pageH : pageH - m * 2;
    const needs = pxNeeded(boxW, boxH, 300);
    const warns = [];
    if (it.width < needs.w || it.height < needs.h) {
      warns.push(
        `Risoluzione bassa: minimo ${needs.w}×${needs.h}px per ${
          fullBleedLeft ? "piena pagina con bleed" : "area utile"
        }. Hai ${it.width}×${it.height}px.`
      );
    }
    if (fullBleedLeft && !bleed) warns.push("‘Piena pagina’ ON ma bleed OFF: attiva bleed per stampa a vivo.");
    return warns;
  }
  function revalidateAll() {
    setItems((prev) => prev.map((it) => ({ ...it, warnings: validateImage(it) })));
  }
  useEffect(() => {
    revalidateAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trimKey, customW, customH, bleed, fullBleedLeft, marginIn]);

  // ---------- CRUD lista ----------
  function removeItem(index) {
    setItems((prev) => {
      const copy = [...prev];
      copy.splice(index, 1);
      setSelectedIndex((s) => Math.min(s, Math.max(0, copy.length - 1)));
      return copy;
    });
  }
  function moveItem(index, dir) {
    setItems((prev) => {
      const copy = [...prev];
      const n = index + dir;
      if (n < 0 || n >= copy.length) return prev;
      const [moved] = copy.splice(index, 1);
      copy.splice(n, 0, moved);
      setSelectedIndex(n);
      return copy;
    });
  }
  function updateField(index, field, value) {
    setItems((prev) => {
      const copy = [...prev];
      copy[index] = { ...copy[index], [field]: value };
      return copy;
    });
  }

  // ---------- AI ----------
  async function generateWithAI(index) {
    const it = items[index];
    if (!it) return;
    if (!apiKey) {
      alert("Inserisci la tua OPENAI_API_KEY in Impostazioni.");
      return;
    }
    const prompt = `Scrivi una scheda per il libro su Caravaggio per l'opera "${it.title}". Struttura: Storia, Aneddoti, Analisi (chiaroscuro, composizione, contesto), Bibliografia essenziale. Tono autorevole ma accessibile. Lingua: italiano.`;
    try {
      const res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          messages: [
            { role: "system", content: "Sei un editor d'arte e curatore museale." },
            { role: "user", content: prompt },
          ],
          temperature: 0.7,
        }),
      });
      const data = await res.json();
      const text = data?.choices?.[0]?.message?.content?.trim();
      if (!text) throw new Error("Risposta vuota");
      updateField(index, "description", text);
    } catch (e) {
      console.error(e);
      alert("Errore AI: " + (e?.message || ""));
    }
  }

  // ---------- Calcolo immagine (PDF e Anteprima) ----------
  function computeImageDraw(it, pageW, pageH, m) {
    const scale = Math.max(0.1, (it.scalePct || 100) / 100);
    let drawW, drawH, offsetX, offsetY;

    if (fullBleedLeft) {
      // COVER: riempi tutta la pagina (può tagliare ai bordi)
      const imgR = it.width / it.height;
      const pageR = pageW / pageH;
      if (imgR > pageR) {
        drawH = pageH * scale;
        drawW = pageH * imgR * scale;
      } else {
        drawW = pageW * scale;
        drawH = (pageW / imgR) * scale;
      }
      // offset percentuale -50..50 → sposta all'interno del crop
      const ox = ((it.offX || 0) / 100) * (drawW - pageW);
      const oy = ((it.offY || 0) / 100) * (drawH - pageH);
      offsetX = (pageW - drawW) / 2 + ox;
      offsetY = (pageH - drawH) / 2 + oy;
    } else {
      // CONTAIN: dentro i margini
      const boxW = pageW - m * 2;
      const boxH = pageH - m * 2;
      const imgR = it.width / it.height;
      const boxR = boxW / boxH;
      if (imgR > boxR) {
        drawW = boxW * scale;
        drawH = (boxW / imgR) * scale;
      } else {
        drawH = boxH * scale;
        drawW = (boxH * imgR) * scale;
      }
      const freeX = Math.max(0, (pageW - drawW) / 2 - 0); // spazio residuo
      const freeY = Math.max(0, (pageH - drawH) / 2 - 0);
      const ox = ((it.offX || 0) / 100) * Math.max(0, (pageW - drawW) / 2);
      const oy = ((it.offY || 0) / 100) * Math.max(0, (pageH - drawH) / 2);
      offsetX = (pageW - drawW) / 2 + ox;
      offsetY = (pageH - drawH) / 2 + oy;
    }
    return { drawW, drawH, offsetX, offsetY };
  }

  // ---------- Export PDF ----------
  async function exportToPdf() {
    if (!items.length) {
      alert("Carica almeno una immagine.");
      return;
    }
    const { w: pageW, h: pageH } = trimWithBleed;
    const doc = new jsPDF({ unit: "in", format: [pageW, pageH], orientation: "portrait" });
    const m = marginIn;

    // frontespizio
    if (includeTitlePage) {
      doc.setFont(useSerif ? "Times" : "Helvetica", "bold");
      doc.setFontSize(22);
      doc.text(bookTitle || "", pageW / 2, pageH * 0.4, { align: "center" });
      doc.setFont(useSerif ? "Times" : "Helvetica", "normal");
      doc.setFontSize(14);
      if (author) doc.text(author, pageW / 2, pageH * 0.47, { align: "center" });
      doc.addPage();
    }

    for (let i = 0; i < items.length; i++) {
      const it = items[i];

      // sinistra: immagine
      const { drawW, drawH, offsetX, offsetY } = computeImageDraw(it, pageW, pageH, m);
      try {
        doc.addImage(it.src, "JPEG", offsetX, offsetY, drawW, drawH, undefined, "FAST");
      } catch {
        try {
          doc.addImage(it.src, "PNG", offsetX, offsetY, drawW, drawH, undefined, "FAST");
        } catch (e2) {
          console.warn("Immagine non aggiunta", e2);
        }
      }

      // destra: testo
      doc.addPage();
      const titleSize = (it.textSize ? it.textSize : fontSize) + 3;
      const bodySize = it.textSize ? it.textSize : fontSize;

      doc.setFont(useSerif ? "Times" : "Helvetica", "bold");
      doc.setFontSize(titleSize);
      doc.text(it.title || "", m, m);

      doc.setFont(useSerif ? "Times" : "Helvetica", "normal");
      doc.setFontSize(bodySize);
      const text = (it.description || "").replace(/\r\n|\r/g, "\n");
      const maxWidth = pageW - m * 2;
      const lines = doc.splitTextToSize(text, maxWidth);
      const leading = (bodySize / 72) * lineHeight; // in
      let y = m + 0.35;
      lines.forEach((ln) => {
        if (y > pageH - m) {
          doc.addPage();
          y = m;
        }
        doc.text(ln, m, y);
        y += leading;
      });

      // mantieni pari
      const total = doc.getNumberOfPages();
      if (total % 2 !== 0 && i < items.length - 1) doc.addPage();
    }

    const safeTitle = (bookTitle || "Caravaggio ArtBook")
      .normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9 _-]/gi, "_").trim().replace(/\s+/g, "_");
    doc.save(safeTitle + (bleed ? "_BLEED" : "") + ".pdf");
  }

  // ---------- KDP checker ----------
  function kdpCheck() {
    const issues = [];
    const pageCount = (includeTitlePage ? 1 : 0) + items.length * 2;
    if (inkType === "standard_color" && pageCount < 72) issues.push(`Pagine minime Standard Color: 72 (attuali ${pageCount}).`);
    if ((inkType === "premium_color" || inkType === "bw") && pageCount < 24) issues.push(`Pagine minime: 24 (attuali ${pageCount}).`);
    const outsideMin = bleed ? 0.375 : 0.25;
    if (marginIn < outsideMin) issues.push(`Margine esterno troppo piccolo: ${marginIn}" (min ${outsideMin}"${bleed ? " con bleed" : ""}).`);
    if (fullBleedLeft && !bleed) issues.push("‘Piena pagina’ ON ma bleed OFF.");
    items.forEach((it, i) => {
      const warns = validateImage(it);
      if (warns.length) issues.push(`Opera #${i + 1} (${it.title}): ${warns.join(" ")}`);
    });
    alert(issues.length ? `Problemi:\n- ` + issues.join("\n- ") : "Nessun problema critico.");
  }

  // ---------- Bozze: salva/carica (file) ----------
  function buildDraft() {
    return {
      version: 3,
      book: {
        bookTitle,
        author,
        includeTitlePage,
        inkType,
        trimKey,
        customW,
        customH,
        bleed,
        fullBleedLeft,
        marginIn,
        fontSize,
        lineHeight,
        useSerif,
      },
      items: items.map((it) => ({
        name: it.name,
        src: it.src, // dataURL; file singolo si porta dietro tutto
        width: it.width,
        height: it.height,
        title: it.title,
        description: it.description,
        scalePct: it.scalePct,
        offX: it.offX,
        offY: it.offY,
        textSize: it.textSize,
      })),
    };
  }
  function saveDraftToFile() {
    const data = buildDraft();
    const title = (bookTitle || "Caravaggio ArtBook").replace(/[^a-z0-9 _-]/gi, "_").trim().replace(/\s+/g, "_");
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${title}.kdpbook.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  }
  function loadDraftFromFile(file) {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const data = JSON.parse(e.target.result);
        if (!data?.book || !Array.isArray(data?.items)) throw new Error("File bozza non valido.");
        const b = data.book;
        setBookTitle(b.bookTitle || "");
        setAuthor(b.author || "");
        setIncludeTitlePage(!!b.includeTitlePage);
        setInkType(b.inkType || "premium_color");
        setTrimKey(b.trimKey || "8.25x11");
        setCustomW(parseFloat(b.customW) || 9.8);
        setCustomH(parseFloat(b.customH) || 13.4);
        setBleed(!!b.bleed);
        setFullBleedLeft(!!b.fullBleedLeft);
        setMarginIn(parseFloat(b.marginIn) || 0.5);
        setFontSize(parseInt(b.fontSize || 11));
        setLineHeight(parseFloat(b.lineHeight || 1.35));
        setUseSerif(!!b.useSerif);

        const its = data.items.map((it, idx) => ({
          id: `${Date.now()}_${idx}`,
          name: it.name || `img_${idx + 1}`,
          src: it.src,
          width: it.width,
          height: it.height,
          title: it.title || "",
          description: it.description || "",
          warnings: [],
          scalePct: it.scalePct ?? 100,
          offX: it.offX ?? 0,
          offY: it.offY ?? 0,
          textSize: it.textSize ?? null,
        }));
        setItems(its);
        setSelectedIndex(0);
        setTimeout(() => revalidateAll(), 0);
      } catch (err) {
        alert("Errore nel caricamento della bozza: " + (err?.message || ""));
      }
    };
    reader.readAsText(file);
  }

  const selected = items[selectedIndex];

  // ---------- Modale Anteprima 1:1 ----------
  function SpreadPreviewModal() {
    if (!previewOpen || !selected) return null;

    const { w: pageWIn, h: pageHIn } = trimWithBleed;
    const pageWpx = Math.round(pageWIn * CSS_PPI * previewZoom);
    const pageHpx = Math.round(pageHIn * CSS_PPI * previewZoom);
    const mPx = Math.round(marginIn * CSS_PPI * previewZoom);

    const bodySizePt = selected.textSize ? selected.textSize : fontSize;
    const fontPx = (bodySizePt / 72) * CSS_PPI * previewZoom;
    const titlePx = ((bodySizePt + 3) / 72) * CSS_PPI * previewZoom;
    const text = (selected.description || "").replace(/\r\n|\r/g, "\n");

    // calcola draw immagine in pollici ⇒ converti in px
    const { drawW, drawH, offsetX, offsetY } = computeImageDraw(selected, pageWIn, pageHIn, marginIn);
    const drawWpx = Math.round(drawW * CSS_PPI * previewZoom);
    const drawHpx = Math.round(drawH * CSS_PPI * previewZoom);
    const offXpx = Math.round(offsetX * CSS_PPI * previewZoom);
    const offYpx = Math.round(offsetY * CSS_PPI * previewZoom);

    return (
      <div className="fixed inset-0 z-50 flex flex-col bg-black/70">
        <div className="p-3 flex items-center gap-3 bg-white">
          <strong>Anteprima 1:1</strong>
          <label className="text-sm">Zoom: {Math.round(previewZoom * 100)}%</label>
          <input type="range" min={0.5} max={2} step={0.05} value={previewZoom} onChange={(e)=>setPreviewZoom(parseFloat(e.target.value))} />
          <button className="px-2 py-1 border rounded" onClick={()=>setPreviewZoom(1)}>100%</button>
          <label className="ml-4 text-sm inline-flex items-center gap-2">
            <input type="checkbox" checked={showGuides} onChange={(e)=>setShowGuides(e.target.checked)} /> Guide margini
          </label>
          <button className="ml-auto px-3 py-1 border rounded" onClick={()=>setPreviewOpen(false)}>Chiudi</button>
        </div>

        <div className="flex-1 overflow-auto p-6">
          <div className="mx-auto flex gap-6" style={{ width: pageWpx * 2 + 80 }}>
            {/* Sinistra: immagine */}
            <div className="relative bg-white shadow rounded overflow-hidden" style={{ width: pageWpx, height: pageHpx }}>
              {showGuides && (
                <div
                  className="absolute inset-0 border border-emerald-500/50 pointer-events-none"
                  style={{ boxShadow: `inset ${mPx}px 0 0 0 rgba(16,185,129,0.15), inset -${mPx}px 0 0 0 rgba(16,185,129,0.15), inset 0 ${mPx}px 0 0 rgba(16,185,129,0.15), inset 0 -${mPx}px 0 0 rgba(16,185,129,0.15)` }}
                />
              )}
              <img
                src={selected.src}
                alt={selected.name}
                style={{
                  position: "absolute",
                  left: offXpx,
                  top: offYpx,
                  width: drawWpx,
                  height: drawHpx,
                  objectFit: "fill",
                }}
              />
            </div>

            {/* Destra: testo */}
            <div className="relative bg-white shadow rounded" style={{ width: pageWpx, height: pageHpx }}>
              {showGuides && (
                <div
                  className="absolute inset-0 border border-emerald-500/50 pointer-events-none"
                  style={{ boxShadow: `inset ${mPx}px 0 0 0 rgba(16,185,129,0.15), inset -${mPx}px 0 0 0 rgba(16,185,129,0.15), inset 0 ${mPx}px 0 0 rgba(16,185,129,0.15), inset 0 -${mPx}px 0 0 rgba(16,185,129,0.15)` }}
                />
              )}
              <div
                className="absolute overflow-auto"
                style={{ left: mPx, top: mPx + Math.round(0.35 * CSS_PPI * previewZoom), right: mPx, bottom: mPx }}
              >
                <div
                  style={{
                    fontWeight: 700,
                    fontFamily: useSerif ? "Times, serif" : "Helvetica, Arial, sans-serif",
                    fontSize: titlePx,
                    marginBottom: 8,
                  }}
                >
                  {selected.title || selected.name}
                </div>
                <div
                  style={{
                    fontFamily: useSerif ? "Times, serif" : "Helvetica, Arial, sans-serif",
                    fontSize: fontPx,
                    lineHeight: lineHeight,
                  }}
                >
                  {text.split("\n").map((ln, i) => (
                    <p key={i} style={{ margin: 0 }}>
                      {ln}
                    </p>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ---------- UI ----------
  return (
    <div className={`min-h-screen ${fontClass} bg-neutral-50`}>
      <SpreadPreviewModal />
      <div className="max-w-7xl mx-auto p-6">
        <header className="mb-6 flex items-center gap-2 justify-between">
          <div>
            <h1 className="text-2xl font-bold">KDP ArtBook Builder – Caravaggio</h1>
            <p className="text-sm text-neutral-600">Doppia pagina: sinistra immagine, destra testo • PDF pronto KDP</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button onClick={()=>setPreviewOpen(true)} className="px-3 py-2 rounded-2xl border shadow-sm">Anteprima 1:1</button>
            <button onClick={kdpCheck} className="px-3 py-2 rounded-2xl border shadow-sm">KDP Checker</button>
            <button onClick={saveDraftToFile} className="px-3 py-2 rounded-2xl border shadow-sm">Salva bozza (file)</button>
            <button onClick={()=>draftFileInputRef.current?.click()} className="px-3 py-2 rounded-2xl border shadow-sm">Carica bozza</button>
            <input ref={draftFileInputRef} type="file" accept=".json,.kdpbook.json,application/json" className="hidden" onChange={(e)=> e.target.files?.[0] && loadDraftFromFile(e.target.files[0]) }/>
            <button onClick={exportToPdf} className="px-4 py-2 rounded-2xl shadow bg-black text-white hover:opacity-90">Esporta PDF</button>
          </div>
        </header>

        {/* impostazioni */}
        <section className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-6">
          <div className="bg-white rounded-2xl shadow p-4">
            <h2 className="font-semibold mb-3">Dettagli libro</h2>
            <label className="block text-sm mb-1">Titolo</label>
            <input value={bookTitle} onChange={(e)=>setBookTitle(e.target.value)} className="w-full border rounded-xl px-3 py-2 mb-3"/>
            <label className="block text-sm mb-1">Autore/Editore</label>
            <input value={author} onChange={(e)=>setAuthor(e.target.value)} className="w-full border rounded-xl px-3 py-2 mb-3"/>
            <label className="block text-sm mb-1">Tipo inchiostro</label>
            <select value={inkType} onChange={(e)=>setInkType(e.target.value)} className="w-full border rounded-xl px-3 py-2 mb-1">
              {INK_OPTIONS.map(o=> <option key={o.key} value={o.key}>{o.label}</option>)}
            </select>
            <label className="inline-flex items-center gap-2 text-sm mt-2">
              <input type="checkbox" checked={includeTitlePage} onChange={(e)=>setIncludeTitlePage(e.target.checked)} />
              Includi pagina del titolo
            </label>
          </div>

          <div className="bg-white rounded-2xl shadow p-4">
            <h2 className="font-semibold mb-3">Formato</h2>
            <label className="block text-sm mb-1">Trim size</label>
            <select value={trimKey} onChange={(e)=>setTrimKey(e.target.value)} className="w-full border rounded-xl px-3 py-2 mb-3">
              {TRIMS.map(t=> <option key={t.key} value={t.key}>{t.label}</option>)}
            </select>

            {trimKey === "custom" && (
              <div className="grid grid-cols-2 gap-2 mb-3">
                <div>
                  <label className="block text-xs mb-1">Larghezza (in)</label>
                  <input type="number" step="0.01" min="4" value={customW} onChange={(e)=>setCustomW(parseFloat(e.target.value)||customW)} className="w-full border rounded-xl px-3 py-2"/>
                </div>
                <div>
                  <label className="block text-xs mb-1">Altezza (in)</label>
                  <input type="number" step="0.01" min="6" value={customH} onChange={(e)=>setCustomH(parseFloat(e.target.value)||customH)} className="w-full border rounded-xl px-3 py-2"/>
                </div>
                <p className="col-span-2 text-[11px] text-neutral-500">Formati grandi stile coffee-table (simulazione). Su KDP i più comuni: 8.25×11" e 8.5×11".</p>
              </div>
            )}

            <label className="inline-flex items-center gap-2 text-sm mb-2">
              <input type="checkbox" checked={bleed} onChange={(e)=>setBleed(e.target.checked)} /> Con bleed (+0.125" W, +0.25" H)
            </label>
            <label className="inline-flex items-center gap-2 text-sm mb-3">
              <input type="checkbox" checked={fullBleedLeft} onChange={(e)=>setFullBleedLeft(e.target.checked)} /> Immagine sinistra a piena pagina
            </label>

            <label className="block text-sm mb-1">Margini (in)</label>
            <input type="number" step="0.1" min="0" value={marginIn} onChange={(e)=>setMarginIn(parseFloat(e.target.value)||0)} className="w-full border rounded-xl px-3 py-2 mb-1"/>
            <p className="text-xs text-neutral-500">Minimi KDP: 0.25" (no bleed) • 0.375" (con bleed).</p>
          </div>

          <div className="bg-white rounded-2xl shadow p-4">
            <h2 className="font-semibold mb-3">Testo (globale)</h2>
            <label className="block text-sm mb-1">Dimensione font (pt)</label>
            <input type="number" step="1" min="8" value={fontSize} onChange={(e)=>setFontSize(parseInt(e.target.value)||11)} className="w-full border rounded-xl px-3 py-2 mb-3"/>
            <label className="block text-sm mb-1">Interlinea</label>
            <input type="number" step="0.05" min="1" value={lineHeight} onChange={(e)=>setLineHeight(parseFloat(e.target.value)||1.35)} className="w-full border rounded-xl px-3 py-2 mb-3"/>
            <label className="inline-flex items-center gap-2 text-sm">
              <input type="checkbox" checked={useSerif} onChange={(e)=>setUseSerif(e.target.checked)} /> Usa font con grazie (serif)
            </label>
          </div>

          <div className="bg-white rounded-2xl shadow p-4">
            <h2 className="font-semibold mb-3">Impostazioni AI</h2>
            <label className="block text-sm mb-1">OpenAI API Key</label>
            <input type="password" placeholder="sk-..." value={apiKey} onChange={(e)=>setApiKey(e.target.value)} className="w-full border rounded-xl px-3 py-2 mb-2"/>
            <div className="flex gap-2">
              <button onClick={saveKey} className="px-3 py-2 rounded-xl border shadow-sm">Salva chiave</button>
              <button onClick={()=>setPreviewOpen(true)} className="px-3 py-2 rounded-xl border shadow-sm">Anteprima 1:1</button>
            </div>
            <p className="text-xs text-neutral-500 mt-2">La chiave resta sul tuo dispositivo. Per sicurezza totale usa un endpoint /api.</p>
          </div>
        </section>

        {/* area lavoro */}
        <section className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {/* elenco */}
          <div className="bg-white rounded-2xl shadow p-4 h-[70vh] overflow-auto">
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-semibold">Opere ({items.length})</h3>
              <div className="text-xs text-neutral-500">Target: 300 DPI</div>
            </div>
            <div className="border-2 border-dashed rounded-2xl p-4 text-center cursor-pointer hover:bg-neutral-50 mb-3" onClick={()=>fileInputRef.current?.click()}>
              <p className="text-sm">Trascina qui le immagini o clicca per selezionare</p>
              <p className="text-xs text-neutral-500 mt-1">JPG/PNG ad alta risoluzione consigliati</p>
              <input ref={fileInputRef} type="file" accept="image/*" multiple className="hidden" onChange={(e)=>onFilesSelected(e.target.files)} />
            </div>
            {items.length === 0 && <p className="text-sm text-neutral-500">Nessuna immagine. Importane alcune per iniziare.</p>}
            <ul className="space-y-2">
              {items.map((it, idx) => (
                <li key={it.id} className={`rounded-xl border p-2 flex items-center gap-2 ${idx===selectedIndex?"ring-2 ring-black":""}`}>
                  <img src={it.src} alt={it.name} className="w-12 h-12 object-cover rounded-lg" onClick={()=>setSelectedIndex(idx)} />
                  <div className="flex-1 min-w-0" onClick={()=>setSelectedIndex(idx)}>
                    <p className="text-sm font-medium truncate">{it.title || it.name}</p>
                    <p className="text-[11px] text-neutral-500 truncate">{it.width}×{it.height}px</p>
                    {it.warnings?.length ? (
                      <p className="text-[11px] text-amber-600">⚠︎ {it.warnings[0]}</p>
                    ) : (
                      <p className="text-[11px] text-emerald-600">✓ idonea (stima 300 DPI)</p>
                    )}
                  </div>
                  <div className="flex items-center gap-1">
                    <button title="Su" onClick={()=>moveItem(idx,-1)} className="px-2 py-1 border rounded-lg">↑</button>
                    <button title="Giù" onClick={()=>moveItem(idx,1)} className="px-2 py-1 border rounded-lg">↓</button>
                    <button title="Rimuovi" onClick={()=>removeItem(idx)} className="px-2 py-1 border rounded-lg">✕</button>
                  </div>
                </li>
              ))}
            </ul>
          </div>

          {/* anteprima ridotta */}
          <div className="bg-white rounded-2xl shadow p-4 h-[70vh] overflow-auto">
            <h3 className="font-semibold mb-3">Anteprima doppia pagina (ridotta)</h3>
            {selected ? (
              <div className="grid grid-cols-2 gap-4">
                <div className="aspect-[2/3] border rounded-xl overflow-hidden relative bg-neutral-100">
                  {/* draw semplificato in CSS: usiamo compute in px */}
                  {(() => {
                    const { w: pageWIn, h: pageHIn } = trimWithBleed;
                    const { drawW, drawH, offsetX, offsetY } = computeImageDraw(selected, pageWIn, pageHIn, marginIn);
                    const pw = 300, ph = 450; // proporzione 2/3 per preview
                    const scaleX = pw / pageWIn, scaleY = ph / pageHIn;
                    return (
                      <img
                        src={selected.src}
                        alt={selected.name}
                        style={{
                          position: "absolute",
                          left: offsetX * scaleX,
                          top: offsetY * scaleY,
                          width: drawW * scaleX,
                          height: drawH * scaleY,
                          objectFit: "fill",
                        }}
                      />
                    );
                  })()}
                </div>
                <div className="aspect-[2/3] border rounded-xl p-3 overflow-auto">
                  <h4 className="font-semibold mb-2 break-words">{selected.title || selected.name}</h4>
                  <div className="max-w-none whitespace-pre-wrap text-sm leading-relaxed">
                    {selected.description || <span className="text-neutral-400">(Nessun testo)</span>}
                  </div>
                </div>
              </div>
            ) : (
              <p className="text-sm text-neutral-500">Seleziona un'opera dall'elenco.</p>
            )}
          </div>

          {/* editor testo + controlli immagine */}
          <div className="bg-white rounded-2xl shadow p-4 h-[70vh] overflow-auto">
            <h3 className="font-semibold mb-3">Editor</h3>
            {selected ? (
              <div>
                <label className="block text-sm mb-1">Titolo opera</label>
                <input value={selected.title} onChange={(e)=>updateField(selectedIndex,"title",e.target.value)} className="w-full border rounded-xl px-3 py-2 mb-3"/>

                <label className="block text-sm mb-1">Testo (storia, aneddoti, analisi)</label>
                <textarea value={selected.description} onChange={(e)=>updateField(selectedIndex,"description",e.target.value)} className="w-full h-48 border rounded-xl px-3 py-2 mb-3" placeholder="Scrivi qui o usa 'Genera con AI'"/>

                <div className="flex gap-2 mb-4">
                  <button onClick={()=>generateWithAI(selectedIndex)} className="px-3 py-2 rounded-xl border shadow-sm">Genera con AI</button>
                  <button onClick={()=>updateField(selectedIndex,"description","")} className="px-3 py-2 rounded-xl border shadow-sm">Svuota testo</button>
                </div>

                <h4 className="font-semibold mb-2">Testo (override per questa opera)</h4>
                <div className="grid grid-cols-3 gap-2 mb-4">
                  <div className="col-span-2">
                    <label className="block text-xs mb-1">Dimensione (pt)</label>
                    <input
                      type="number"
                      min="8"
                      step="1"
                      value={selected.textSize ?? ""}
                      placeholder={`(usa globale: ${fontSize} pt)`}
                      onChange={(e)=>updateField(selectedIndex,"textSize", e.target.value === "" ? null : parseInt(e.target.value)||fontSize)}
                      className="w-full border rounded-xl px-3 py-2"
                    />
                  </div>
                  <div className="flex items-end">
                    <button
                      className="px-3 py-2 border rounded-xl w-full"
                      onClick={()=>updateField(selectedIndex,"textSize",null)}
                    >
                      Usa globale
                    </button>
                  </div>
                </div>

                <h4 className="font-semibold mb-2">Immagine (questa opera)</h4>
                <div className="grid grid-cols-3 gap-2">
                  <div>
                    <label className="block text-xs mb-1">Scala (%)</label>
                    <input
                      type="range"
                      min="50"
                      max="200"
                      step="1"
                      value={selected.scalePct}
                      onChange={(e)=>updateField(selectedIndex,"scalePct", parseInt(e.target.value))}
                      className="w-full"
                    />
                    <div className="text-xs text-neutral-600 text-center mt-1">{selected.scalePct}%</div>
                  </div>
                  <div>
                    <label className="block text-xs mb-1">Offset X (%)</label>
                    <input
                      type="range"
                      min="-50"
                      max="50"
                      step="1"
                      value={selected.offX}
                      onChange={(e)=>updateField(selectedIndex,"offX", parseInt(e.target.value))}
                      className="w-full"
                    />
                    <div className="text-xs text-neutral-600 text-center mt-1">{selected.offX}%</div>
                  </div>
                  <div>
                    <label className="block text-xs mb-1">Offset Y (%)</label>
                    <input
                      type="range"
                      min="-50"
                      max="50"
                      step="1"
                      value={selected.offY}
                      onChange={(e)=>updateField(selectedIndex,"offY", parseInt(e.target.value))}
                      className="w-full"
                    />
                    <div className="text-xs text-neutral-600 text-center mt-1">{selected.offY}%</div>
                  </div>
                </div>
                <div className="mt-2">
                  <button
                    onClick={()=>updateField(selectedIndex,"scalePct",100) || updateField(selectedIndex,"offX",0) || updateField(selectedIndex,"offY",0)}
                    className="px-3 py-2 border rounded-xl"
                  >
                    Reset immagine
                  </button>
                  <button onClick={()=>setPreviewOpen(true)} className="ml-2 px-3 py-2 border rounded-xl">Anteprima 1:1</button>
                </div>
              </div>
            ) : (
              <p className="text-sm text-neutral-500">Seleziona un'opera per modificarla.</p>
            )}
          </div>
        </section>

        <footer className="text-xs text-neutral-500 mt-6 space-y-1">
          <p>Consigli: immagini JPG ad alta qualità. Senza bleed: margini ≥ 0.25". Con bleed: pagina = trim + 0.125" (W) e +0.25" (H).</p>
        </footer>
      </div>
    </div>
  );
}
