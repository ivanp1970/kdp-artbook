import React, { useEffect, useMemo, useRef, useState } from "react";
import { jsPDF } from "jspdf";

/**
 * KDP ArtBook Builder – Caravaggio (v8)
 *
 * - Anteprima 1:1 (zoom + guide)
 * - Ridimensionamento immagine per opera (scala %, offset X/Y) + piena pagina (bleed)
 * - Override dimensione testo per opera
 * - Salva/Carica bozza su FILE (.kdpbook.json)
 * - Salva/Carica bozza su CLOUD (Vercel KV) via /api/save e /api/load
 * - KDP checker (pagine minime, margini, DPI) • formati grandi + custom
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
  { key: "custom", w: 9.8, h: 13.4, label: "Personalizzato (imposta sotto)" }
];

const INK_OPTIONS = [
  { key: "premium_color", label: "Premium Color" },
  { key: "standard_color", label: "Standard Color" },
  { key: "bw", label: "B/N" }
];

const CSS_PPI = 96; // px/in per anteprima a schermo

function pxNeeded(widthIn, heightIn, dpi = 300) {
  return { w: Math.round(widthIn * dpi), h: Math.round(heightIn * dpi) };
}
function calcBleedSize(trimW, trimH, bleed) {
  if (!bleed) return { w: trimW, h: trimH };
  // KDP: +0.125" W, +0.25" H
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

  // AI (client)
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

  // Cloud
  const [cloudId, setCloudId] = useState("");
  const [cloudBusy, setCloudBusy] = useState(false);

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
              offX: 0,
              offY: 0,
              textSize: null
            });
          };
          img.src = src;
        };
        reader.readAsDataURL(file);
      })
    );
    Promise.all(readers).then((newItems) => {
      const validated = newItems.map((it) => ({
        ...it,
        warnings: validateImage(it)
      }));
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
    if (fullBleedLeft && !bleed)
      warns.push("‘Piena pagina’ ON ma bleed OFF: attiva bleed per stampa a vivo.");
    return warns;
  }
  function revalidateAll() {
    setItems((prev) =>
      prev.map((it) => ({ ...it, warnings: validateImage(it) }))
    );
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
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          messages: [
            { role: "system", content: "Sei un editor d'arte e curatore museale." },
            { role: "user", content: prompt }
          ],
          temperature: 0.7
        })
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

  // ---------- Calcolo immagine ----------
  function computeImageDraw(it, pageW, pageH, m) {
    const scale = Math.max(0.1, (it.scalePct || 100) / 100);
    let drawW, drawH, offsetX, offsetY;

    if (fullBleedLeft) {
      // riempi pagina (crop ai bordi), con offset percentuale
      const imgR = it.width / it.height;
      const pageR = pageW / pageH;
      if (imgR > pageR) {
        drawH = pageH * scale;
        drawW = pageH * imgR * scale;
      } else {
        drawW = pageW * scale;
        drawH = (pageW / imgR) * scale;
      }
      const ox = ((it.offX || 0) / 100) * (drawW - pageW);
      const oy = ((it.offY || 0) / 100) * (drawH - pageH);
      offsetX = (pageW - drawW) / 2 + ox;
      offsetY = (pageH - drawH) / 2 + oy;
    } else {
      // dentro i margini (contain)
      const boxW = pageW - m * 2;
      const boxH = pageH - m * 2;
      const imgR = it.width / it.height;
      const boxR = boxW / boxH;
      if (imgR > boxR) {
        drawW = boxW * scale;
        drawH = (boxW / imgR) * scale;
      } else {
        drawH = boxH * scale;
        drawW = boxH * imgR * scale;
      }
      const freeX = (pageW - drawW) / 2;
      const freeY = (pageH - drawH) / 2;
      const ox = ((it.offX || 0) / 100) * Math.max(0, freeX);
      const oy = ((it.offY || 0) / 100) * Math.max(0, freeY);
      offsetX = freeX + ox;
      offsetY = freeY + oy;
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

      // Pagina destra (testo)
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

      // mantieni pari se non ultima coppia
      const total = doc.getNumberOfPages();
      if (total % 2 !== 0 && i < items.length - 1) doc.addPage();
    }

    const safeTitle = (bookTitle || "Caravaggio ArtBook")
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9 _-]/gi, "_")
      .trim()
      .replace(/\s+/g, "_");
    doc.save(safeTitle + (bleed ? "_BLEED" : "") + ".pdf");
  }

  // ---------- KDP checker ----------
  function kdpCheck() {
    const issues = [];
    const pageCount = (includeTitlePage ? 1 : 0) + items.length * 2;
    if (inkType === "standard_color" && pageCount < 72)
      issues.push(`Pagine minime Standard Color: 72 (attuali ${pageCount}).`);
    if ((inkType === "premium_color" || inkType === "bw") && pageCount < 24)
      issues.push(`Pagine minime: 24 (attuali ${pageCount}).`);
    const outsideMin = bleed ? 0.375 : 0.25;
    if (marginIn < outsideMin)
      issues.push(
        `Margine esterno troppo piccolo: ${marginIn}" (min ${outsideMin}"${
          bleed ? " con bleed" : ""
        }).`
      );
    if (fullBleedLeft && !bleed) issues.push("‘Piena pagina’ ON ma bleed OFF.");
    items.forEach((it, i) => {
      const warns = validateImage(it);
      if (warns.length) issues.push(`Opera #${i + 1} (${it.title}): ${warns.join(" ")}`);
    });
    alert(issues.length ? `Problemi:\n- ` + issues.join("\n- ") : "Nessun problema critico.");
  }

  // ---------- Bozze: FILE ----------
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
        useSerif
      },
      items: items.map((it) => ({
        name: it.name,
        src: it.src,
        width: it.width,
        height: it.height,
        title: it.title,
        description: it.description,
        scalePct: it.scalePct,
        offX: it.offX,
        offY: it.offY,
        textSize: it.textSize
      }))
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
          textSize: it.textSize ?? null
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

  // ---------- Bozze: CLOUD (Vercel KV via /api) ----------
  async function saveDraftToCloud() {
    if (!cloudId) {
      alert("Inserisci un ID per la bozza (es: caravaggio-2025).");
      return;
    }
    const payload = buildDraft();
    try {
      setCloudBusy(true);
      const res = await fetch("/api/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: cloudId, payload })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || "Errore salvataggio cloud");
      alert("Bozza salvata nel cloud ✔");
    } catch (e) {
      alert("Errore cloud: " + (e?.message || ""));
    } finally {
      setCloudBusy(false);
    }
  }
  async function loadDraftFromCloud() {
    if (!cloudId) {
      alert("Inserisci l'ID della bozza da caricare.");
      return;
    }
    try {
      setCloudBusy(true);
      const res = await fetch(`/api/load?id=${encodeURIComponent(cloudId)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Errore caricamento cloud");
      const draft = data?.payload;
      if (!draft?.book || !Array.isArray(draft?.items))
        throw new Error("Bozza non valida sul cloud.");
      // riuso loader file
      const blob = new Blob([JSON.stringify(draft)], { type: "application/json" });
      loadDraftFromFile(new File([blob], "cloud.kdpbook.json", { type: "application/json" }));
      alert("Bozza caricata dal cloud ✔");
    } catch (e) {
      alert("Errore cloud: " + (e?.message || ""));
    } finally {
      setCloudBusy(false);
    }
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

    const { drawW, drawH, offsetX, offsetY } = computeImageDraw(
      selected,
      pageWIn,
      pageHIn,
      marginIn
    );
    const drawWpx = Math.round(drawW * CSS_PPI * previewZoom);
    const drawHpx = Math.round(drawH * CSS_PPI * previewZoom);
    const offXpx = Math.round(offsetX * CSS_PPI * previewZoom);
    const offYpx = Math.round(offsetY * CSS_PPI * previewZoom);

    return (
      <div className="fixed inset-0 z-50 flex flex-col" style={{ background: "rgba(0,0,0,0.7)" }}>
        <div className="p-3 flex items-center gap-3" style={{ background: "#fff" }}>
          <strong>Anteprima 1:1</strong>
          <label className="text-sm">Zoom: {Math.round(previewZoom * 100)}%</label>
          <input
            type="range"
            min={0.5}
            max={2}
            step={0.05}
            value={previewZoom}
            onChange={(e) => setPreviewZoom(parseFloat(e.target.value))}
          />
          <button className="px-2 py-1" onClick={() => setPreviewZoom(1)}>100%</button>
          <label className="ml-4 text-sm" style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
            <input
              type="checkbox"
              checked={showGuides}
              onChange={(e) => setShowGuides(e.target.checked)}
            />
            Guide margini
          </label>
          <button className="ml-auto px-3 py-1" onClick={() => setPreviewOpen(false)}>
            Chiudi
          </button>
        </div>

        <div className="flex-1 overflow-auto p-6">
          <div className="mx-auto" style={{ display: "flex", gap: 24, width: pageWpx * 2 + 80 }}>
            {/* Sinistra: immagine */}
            <div
              className="relative"
              style={{
                background: "#fff",
                width: pageWpx,
                height: pageHpx,
                borderRadius: 8,
                boxShadow: "0 2px 10px rgba(0,0,0,0.12)",
                overflow: "hidden"
              }}
            >
              {showGuides && (
                <div
                  className="absolute inset-0 pointer-events-none"
                  style={{
                    border: "1px solid rgba(16,185,129,0.5)",
                    boxShadow: `inset ${mPx}px 0 0 0 rgba(16,185,129,0.15),
                                inset -${mPx}px 0 0 0 rgba(16,185,129,0.15),
                                inset 0 ${mPx}px 0 0 rgba(16,185,129,0.15),
                                inset 0 -${mPx}px 0 0 rgba(16,185,129,0.15)`
                  }}
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
                }}
              />
            </div>

            {/* Destra: testo */}
            <div
              className="relative"
              style={{
                background: "#fff",
                width: pageWpx,
                height: pageHpx,
                borderRadius: 8,
                boxShadow: "0 2px 10px rgba(0,0,0,0.12)",
                overflow: "hidden"
              }}
            >
              {showGuides && (
                <div
                  className="absolute inset-0 pointer-events-none"
                  style={{
                    border: "1px solid rgba(16,185,129,0.5)",
                    boxShadow: `inset ${mPx}px 0 0 0 rgba(16,185,129,0.15),
                                inset -${mPx}px 0 0 0 rgba(16,185,129,0.15),
                                inset 0 ${mPx}px 0 0 rgba(16,185,129,0.15),
                                inset 0 -${mPx}px 0 0 rgba(16,185,129,0.15)`
                  }}
                />
              )}
              <div
                className="absolute overflow-auto"
                style={{
                  left: mPx,
                  top: mPx + Math.round(0.35 * CSS_PPI * previewZoom),
                  right: mPx,
                  bottom: mPx
                }}
              >
                <div
                  style={{
                    fontWeight: 700,
                    fontFamily: useSerif ? "Times, serif" : "Helvetica, Arial, sans-serif",
                    fontSize: titlePx,
                    marginBottom: 8
                  }}
                >
                  {selected.title || selected.name}
                </div>
                <div
                  style={{
                    fontFamily: useSerif ? "Times, serif" : "Helvetica, Arial, sans-serif",
                    fontSize: fontPx,
                    lineHeight: lineHeight
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
    <div className={`min-h-screen ${fontClass}`} style={{ background: "#fafafa" }}>
      <SpreadPreviewModal />
      <div className="max-w-7xl mx-auto p-6">
        <header className="mb-6" style={{ display: "flex", gap: 16, alignItems: "center", justifyContent: "space-between" }}>
          <div>
            <h1 className="text-2xl" style={{ fontWeight: 800 }}>KDP ArtBook Builder – Caravaggio</h1>
            <p className="text-sm" style={{ color: "#555" }}>
              Sinistra immagine • Destra testo • PDF pronto KDP
            </p>
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button onClick={() => setPreviewOpen(true)} className="px-3 py-2" style={{ border: "1px solid #ddd", borderRadius: 16, boxShadow: "0 1px 4px rgba(0,0,0,0.06)" }}>
              Anteprima 1:1
            </button>
            <button onClick={kdpCheck} className="px-3 py-2" style={{ border: "1px solid #ddd", borderRadius: 16, boxShadow: "0 1px 4px rgba(0,0,0,0.06)" }}>
              KDP Checker
            </button>
            <button onClick={saveDraftToFile} className="px-3 py-2" style={{ border: "1px solid #ddd", borderRadius: 16, boxShadow: "0 1px 4px rgba(0,0,0,0.06)" }}>
              Salva bozza (file)
            </button>
            <button onClick={() => draftFileInputRef.current?.click()} className="px-3 py-2" style={{ border: "1px solid #ddd", borderRadius: 16, boxShadow: "0 1px 4px rgba(0,0,0,0.06)" }}>
              Carica bozza
            </button>
            <input
              ref={draftFileInputRef}
              type="file"
              accept=".json,.kdpbook.json,application/json"
              className="hidden"
              onChange={(e) => e.target.files?.[0] && loadDraftFromFile(e.target.files[0])}
              style={{ display: "none" }}
            />
            <button onClick={exportToPdf} className="px-4 py-2" style={{ borderRadius: 16, background: "#000", color: "#fff", boxShadow: "0 1px 4px rgba(0,0,0,0.18)" }}>
              Esporta PDF
            </button>
          </div>
        </header>

        {/* Cloud bar */}
        <div className="bg-white rounded-2xl shadow p-4 mb-6" style={{ boxShadow: "0 1px 6px rgba(0,0,0,0.06)", borderRadius: 16 }}>
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "end" }}>
            <div style={{ flex: 1, minWidth: 260 }}>
              <label className="block text-sm mb-1">ID bozza su cloud (es. caravaggio-2025)</label>
              <input
                value={cloudId}
                onChange={(e) => setCloudId(e.target.value)}
                className="w-full"
                placeholder="Scegli un ID unico"
                style={{ border: "1px solid #ddd", borderRadius: 12, padding: "8px 12px", width: "100%" }}
              />
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button
                disabled={cloudBusy || !cloudId}
                onClick={saveDraftToCloud}
                className="px-3 py-2"
                style={{ border: "1px solid #ddd", borderRadius: 12, opacity: cloudBusy || !cloudId ? 0.6 : 1 }}
              >
                Salva su cloud
              </button>
              <button
                disabled={cloudBusy || !cloudId}
                onClick={loadDraftFromCloud}
                className="px-3 py-2"
                style={{ border: "1px solid #ddd", borderRadius: 12, opacity: cloudBusy || !cloudId ? 0.6 : 1 }}
              >
                Carica dal cloud
              </button>
            </div>
          </div>
        </div>

        {/* Impostazioni */}
        <section className="grid" style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0,1fr))", gap: 16, marginBottom: 24 }}>
          {/* Dettagli libro */}
          <div className="bg-white rounded-2xl shadow p-4" style={{ borderRadius: 16, boxShadow: "0 1px 6px rgba(0,0,0,0.06)" }}>
            <h2 className="font-semibold mb-3">Dettagli libro</h2>
            <label className="block text-sm mb-1">Titolo</label>
            <input value={bookTitle} onChange={(e) => setBookTitle(e.target.value)} className="w-full" style={{ border: "1px solid #ddd", borderRadius: 12, padding: "8px 12px", width: "100%", marginBottom: 12 }} />
            <label className="block text-sm mb-1">Autore/Editore</label>
            <input value={author} onChange={(e) => setAuthor(e.target.value)} className="w-full" style={{ border: "1px solid #ddd", borderRadius: 12, padding: "8px 12px", width: "100%", marginBottom: 12 }} />
            <label className="block text-sm mb-1">Tipo inchiostro</label>
            <select value={inkType} onChange={(e) => setInkType(e.target.value)} className="w-full" style={{ border: "1px solid #ddd", borderRadius: 12, padding: "8px 12px", width: "100%" }}>
              {INK_OPTIONS.map((o) => (
                <option key={o.key} value={o.key}>
                  {o.label}
                </option>
              ))}
            </select>
            <label className="inline-flex items-center gap-2 text-sm" style={{ marginTop: 8 }}>
              <input type="checkbox" checked={includeTitlePage} onChange={(e) => setIncludeTitlePage(e.target.checked)} />
              Includi pagina del titolo
            </label>
          </div>

          {/* Formato */}
          <div className="bg-white rounded-2xl shadow p-4" style={{ borderRadius: 16, boxShadow: "0 1px 6px rgba(0,0,0,0.06)" }}>
            <h2 className="font-semibold mb-3">Formato</h2>
            <label className="block text-sm mb-1">Trim size</label>
            <select value={trimKey} onChange={(e) => setTrimKey(e.target.value)} className="w-full" style={{ border: "1px solid #ddd", borderRadius: 12, padding: "8px 12px", width: "100%", marginBottom: 12 }}>
              {TRIMS.map((t) => (
                <option key={t.key} value={t.key}>
                  {t.label}
                </option>
              ))}
            </select>
            {trimKey === "custom" && (
              <div className="grid" style={{ display: "grid", gridTemplateColumns: "repeat(2,1fr)", gap: 8, marginBottom: 12 }}>
                <div>
                  <label className="block text-xs mb-1">Larghezza (in)</label>
                  <input type="number" step="0.01" min="4" value={customW} onChange={(e) => setCustomW(parseFloat(e.target.value) || customW)} className="w-full" style={{ border: "1px solid #ddd", borderRadius: 12, padding: "8px 12px", width: "100%" }} />
                </div>
                <div>
                  <label className="block text-xs mb-1">Altezza (in)</label>
                  <input type="number" step="0.01" min="6" value={customH} onChange={(e) => setCustomH(parseFloat(e.target.value) || customH)} className="w-full" style={{ border: "1px solid #ddd", borderRadius: 12, padding: "8px 12px", width: "100%" }} />
                </div>
                <p className="col-span-2" style={{ fontSize: 11, color: "#666" }}>
                  Formati grandi stile coffee-table (su KDP comuni: 8.25×11", 8.5×11").
                </p>
              </div>
            )}
            <label className="inline-flex items-center gap-2 text-sm" style={{ marginBottom: 6 }}>
              <input type="checkbox" checked={bleed} onChange={(e) => setBleed(e.target.checked)} /> Con bleed (+0.125" W, +0.25" H)
            </label>
            <label className="inline-flex items-center gap-2 text-sm" style={{ marginBottom: 12, display: "block" }}>
              <input type="checkbox" checked={fullBleedLeft} onChange={(e) => setFullBleedLeft(e.target.checked)} /> Immagine sinistra a piena pagina
            </label>
            <label className="block text-sm mb-1">Margini (in)</label>
            <input type="number" step="0.1" min="0" value={marginIn} onChange={(e) => setMarginIn(parseFloat(e.target.value) || 0)} className="w-full" style={{ border: "1px solid #ddd", borderRadius: 12, padding: "8px 12px", width: "100%" }} />
            <p style={{ fontSize: 12, color: "#666", marginTop: 6 }}>Minimi KDP: 0.25" (no bleed) • 0.375" (con bleed).</p>
          </div>

          {/* Testo (globale) */}
          <div className="bg-white rounded-2xl shadow p-4" style={{ borderRadius: 16, boxShadow: "0 1px 6px rgba(0,0,0,0.06)" }}>
            <h2 className="font-semibold mb-3">Testo (globale)</h2>
            <label className="block text-sm mb-1">Dimensione font (pt)</label>
            <input type="number" step="1" min="8" value={fontSize} onChange={(e) => setFontSize(parseInt(e.target.value) || 11)} className="w-full" style={{ border: "1px solid #ddd", borderRadius: 12, padding: "8px 12px", width: "100%", marginBottom: 12 }} />
            <label className="block text-sm mb-1">Interlinea</label>
            <input type="number" step="0.05" min="1" value={lineHeight} onChange={(e) => setLineHeight(parseFloat(e.target.value) || 1.35)} className="w-full" style={{ border: "1px solid #ddd", borderRadius: 12, padding: "8px 12px", width: "100%", marginBottom: 12 }} />
            <label className="inline-flex items-center gap-2 text-sm">
              <input type="checkbox" checked={useSerif} onChange={(e) => setUseSerif(e.target.checked)} /> Usa font con grazie (serif)
            </label>
          </div>

          {/* Impostazioni AI */}
          <div className="bg-white rounded-2xl shadow p-4" style={{ borderRadius: 16, boxShadow: "0 1px 6px rgba(0,0,0,0.06)" }}>
            <h2 className="font-semibold mb-3">Impostazioni AI</h2>
            <label className="block text-sm mb-1">OpenAI API Key</label>
            <input type="password" placeholder="sk-..." value={apiKey} onChange={(e) => setApiKey(e.target.value)} className="w-full" style={{ border: "1px solid #ddd", borderRadius: 12, padding: "8px 12px", width: "100%", marginBottom: 8 }} />
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={saveKey} className="px-3 py-2" style={{ border: "1px solid #ddd", borderRadius: 12 }}>
                Salva chiave
              </button>
              <button onClick={() => setPreviewOpen(true)} className="px-3 py-2" style={{ border: "1px solid #ddd", borderRadius: 12 }}>
                Anteprima 1:1
              </button>
            </div>
            <p style={{ fontSize: 12, color: "#666", marginTop: 8 }}>
              La chiave resta sul dispositivo. Per sicurezza totale usa un endpoint /api.
            </p>
          </div>
        </section>

        {/* Area lavoro */}
        <section className="grid" style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0,1fr))", gap: 24 }}>
          {/* Elenco */}
          <div className="bg-white rounded-2xl shadow p-4" style={{ height: "70vh", overflow: "auto", borderRadius: 16, boxShadow: "0 1px 6px rgba(0,0,0,0.06)" }}>
            <div className="flex items-center justify-between mb-3" style={{ display: "flex" }}>
              <h3 className="font-semibold">Opere ({items.length})</h3>
              <div style={{ fontSize: 12, color: "#666" }}>Target: 300 DPI</div>
            </div>
            <div
              className="border-2 border-dashed rounded-2xl p-4 text-center cursor-pointer hover:bg-neutral-50 mb-3"
              onClick={() => fileInputRef.current?.click()}
              style={{ border: "2px dashed #ddd", borderRadius: 16 }}
            >
              <p className="text-sm">Trascina qui le immagini o clicca per selezionare</p>
              <p style={{ fontSize: 12, color: "#666", marginTop: 4 }}>JPG/PNG ad alta risoluzione consigliati</p>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                multiple
                className="hidden"
                onChange={(e) => onFilesSelected(e.target.files)}
                style={{ display: "none" }}
              />
            </div>
            {items.length === 0 && (
              <p style={{ fontSize: 14, color: "#666" }}>Nessuna immagine. Importane alcune per iniziare.</p>
            )}
            <ul style={{ display: "grid", gap: 8 }}>
              {items.map((it, idx) => (
                <li
                  key={it.id}
                  className={`border p-2`}
                  style={{
                    display: "flex",
                    gap: 8,
                    alignItems: "center",
                    border: "1px solid #e5e5e5",
                    borderRadius: 12,
                    boxShadow: idx === selectedIndex ? "0 0 0 2px #000" : "none",
                    cursor: "pointer"
                  }}
                >
                  <img
                    src={it.src}
                    alt={it.name}
                    width={48}
                    height={48}
                    style={{ width: 48, height: 48, objectFit: "cover", borderRadius: 8 }}
                    onClick={() => setSelectedIndex(idx)}
                  />
                  <div className="flex-1 min-w-0" onClick={() => setSelectedIndex(idx)} style={{ flex: 1, minWidth: 0 }}>
                    <p style={{ fontSize: 14, fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                      {it.title || it.name}
                    </p>
                    <p style={{ fontSize: 11, color: "#666", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                      {it.width}×{it.height}px
                    </p>
                    {it.warnings?.length ? (
                      <p style={{ fontSize: 11, color: "#9a6200" }}>⚠︎ {it.warnings[0]}</p>
                    ) : (
                      <p style={{ fontSize: 11, color: "#0b8f55" }}>✓ idonea (stima 300 DPI)</p>
                    )}
                  </div>
                  <div style={{ display: "flex", gap: 6 }}>
                    <button title="Su" onClick={() => moveItem(idx, -1)} className="px-2 py-1" style={{ border: "1px solid #ddd", borderRadius: 8 }}>
                      ↑
                    </button>
                    <button title="Giù" onClick={() => moveItem(idx, 1)} className="px-2 py-1" style={{ border: "1px solid #ddd", borderRadius: 8 }}>
                      ↓
                    </button>
                    <button title="Rimuovi" onClick={() => removeItem(idx)} className="px-2 py-1" style={{ border: "1px solid #ddd", borderRadius: 8 }}>
                      ✕
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </div>

          {/* Anteprima ridotta */}
          <div className="bg-white rounded-2xl shadow p-4" style={{ height: "70vh", overflow: "auto", borderRadius: 16, boxShadow: "0 1px 6px rgba(0,0,0,0.06)" }}>
            <h3 className="font-semibold mb-3">Anteprima doppia pagina (ridotta)</h3>
            {selected ? (
              <div className="grid" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
                {/* sinistra */}
                <div className="aspect-[2/3] border rounded-xl overflow-hidden" style={{ position: "relative", paddingTop: "150%", background: "#f3f3f3", borderRadius: 12, border: "1px solid #eee" }}>
                  {(() => {
                    const { w: pageWIn, h: pageHIn } = trimWithBleed;
                    const { drawW, drawH, offsetX, offsetY } = computeImageDraw(selected, pageWIn, pageHIn, marginIn);
                    const pw = 300, ph = 450; // 2/3 sample
                    const sx = pw / pageWIn, sy = ph / pageHIn;
                    return (
                      <img
                        src={selected.src}
                        alt={selected.name}
                        style={{
                          position: "absolute",
                          left: offsetX * sx,
                          top: offsetY * sy,
                          width: drawW * sx,
                          height: drawH * sy
                        }}
                      />
                    );
                  })()}
                </div>
                {/* destra */}
                <div className="aspect-[2/3] border rounded-xl p-3 overflow-auto" style={{ border: "1px solid #eee", borderRadius: 12 }}>
                  <h4 className="font-semibold mb-2" style={{ wordBreak: "break-word" }}>
                    {selected.title || selected.name}
                  </h4>
                  <div style={{ whiteSpace: "pre-wrap", fontSize: 14, lineHeight: 1.5 }}>
                    {selected.description || <span style={{ color: "#999" }}>(Nessun testo)</span>}
                  </div>
                </div>
              </div>
            ) : (
              <p style={{ fontSize: 14, color: "#666" }}>Seleziona un'opera dall'elenco.</p>
            )}
          </div>

          {/* Editor */}
          <div className="bg-white rounded-2xl shadow p-4" style={{ height: "70vh", overflow: "auto", borderRadius: 16, boxShadow: "0 1px 6px rgba(0,0,0,0.06)" }}>
            <h3 className="font-semibold mb-3">Editor</h3>
            {selected ? (
              <div>
                <label className="block text-sm mb-1">Titolo opera</label>
                <input
                  value={selected.title}
                  onChange={(e) => updateField(selectedIndex, "title", e.target.value)}
                  className="w-full"
                  style={{ border: "1px solid #ddd", borderRadius: 12, padding: "8px 12px", width: "100%", marginBottom: 12 }}
                />

                <label className="block text-sm mb-1">Testo (storia, aneddoti, analisi)</label>
                <textarea
                  value={selected.description}
                  onChange={(e) => updateField(selectedIndex, "description", e.target.value)}
                  className="w-full"
                  style={{ height: 160, border: "1px solid #ddd", borderRadius: 12, padding: "8px 12px", width: "100%", marginBottom: 12 }}
                  placeholder="Scrivi qui o usa 'Genera con AI'"
                />

                <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
                  <button onClick={() => generateWithAI(selectedIndex)} className="px-3 py-2" style={{ border: "1px solid #ddd", borderRadius: 12 }}>
                    Genera con AI
                  </button>
                  <button onClick={() => updateField(selectedIndex, "description", "")} className="px-3 py-2" style={{ border: "1px solid #ddd", borderRadius: 12 }}>
                    Svuota testo
                  </button>
                  <button onClick={() => setPreviewOpen(true)} className="px-3 py-2" style={{ border: "1px solid #ddd", borderRadius: 12 }}>
                    Anteprima 1:1
                  </button>
                </div>

                <h4 className="font-semibold mb-2">Testo (override per questa opera)</h4>
                <div className="grid" style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: 8, marginBottom: 16 }}>
                  <div>
                    <label className="block text-xs mb-1">Dimensione (pt)</label>
                    <input
                      type="number"
                      min="8"
                      step="1"
                      value={selected.textSize ?? ""}
                      placeholder="(usa globale)"
                      onChange={(e) =>
                        updateField(
                          selectedIndex,
                          "textSize",
                          e.target.value === "" ? null : parseInt(e.target.value) || fontSize
                        )
                      }
                      className="w-full"
                      style={{ border: "1px solid #ddd", borderRadius: 12, padding: "8px 12px", width: "100%" }}
                    />
                  </div>
                  <div style={{ display: "flex", alignItems: "end" }}>
                    <button className="px-3 py-2" onClick={() => updateField(selectedIndex, "textSize", null)} style={{ border: "1px solid #ddd", borderRadius: 12, width: "100%" }}>
                      Usa globale
                    </button>
                  </div>
                </div>

                <h4 className="font-semibold mb-2">Immagine (questa opera)</h4>
                <div className="grid" style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
                  <div>
                    <label className="block text-xs mb-1">Scala (%)</label>
                    <input
                      type="range"
                      min="50"
                      max="200"
                      step="1"
                      value={selected.scalePct}
                      onChange={(e) => updateField(selectedIndex, "scalePct", parseInt(e.target.value))}
                      className="w-full"
                    />
                    <div style={{ fontSize: 12, color: "#555", textAlign: "center", marginTop: 4 }}>{selected.scalePct}%</div>
                  </div>
                  <div>
                    <label className="block text-xs mb-1">Offset X (%)</label>
                    <input
                      type="range"
                      min="-50"
                      max="50"
                      step="1"
                      value={selected.offX}
                      onChange={(e) => updateField(selectedIndex, "offX", parseInt(e.target.value))}
                      className="w-full"
                    />
                    <div style={{ fontSize: 12, color: "#555", textAlign: "center", marginTop: 4 }}>{selected.offX}%</div>
                  </div>
                  <div>
                    <label className="block text-xs mb-1">Offset Y (%)</label>
                    <input
                      type="range"
                      min="-50"
                      max="50"
                      step="1"
                      value={selected.offY}
                      onChange={(e) => updateField(selectedIndex, "offY", parseInt(e.target.value))}
                      className="w-full"
                    />
                    <div style={{ fontSize: 12, color: "#555", textAlign: "center", marginTop: 4 }}>{selected.offY}%</div>
                  </div>
                </div>
                <div style={{ marginTop: 8 }}>
                  <button
                    onClick={() => {
                      updateField(selectedIndex, "scalePct", 100);
                      updateField(selectedIndex, "offX", 0);
                      updateField(selectedIndex, "offY", 0);
                    }}
                    className="px-3 py-2"
                    style={{ border: "1px solid #ddd", borderRadius: 12 }}
                  >
                    Reset immagine
                  </button>
                </div>
              </div>
            ) : (
              <p style={{ fontSize: 14, color: "#666" }}>Seleziona un'opera per modificarla.</p>
            )}
          </div>
        </section>

        <footer style={{ fontSize: 12, color: "#666", marginTop: 24 }}>
          Consigli: immagini JPG ad alta qualità. Senza bleed: margini ≥ 0.25". Con bleed: pagina = trim + 0.125" (W) e +0.25" (H).
        </footer>
      </div>
    </div>
  );
}
