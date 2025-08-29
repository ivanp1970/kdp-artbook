import React, { useEffect, useMemo, useRef, useState } from "react";
import { jsPDF } from "jspdf";
import TextBook from "./TextBook"; // ⬅️ nuova sezione PDF/EPUB

/**
 * KDP ArtBook Builder – App.jsx (completo)
 * - Import immagini (JPG/PNG) con DPI check
 * - Sinistra immagine / Destra testo
 * - KDP Checker (pagine minime, margini, DPI)
 * - Esporta PDF (jsPDF, unità in pollici)
 * - AI (OpenAI) lato client
 * - Mini-router: /#text apre la sezione “Libro di Testo (PDF/EPUB)”
 */

const TRIMS = [
  { key: "6x9", w: 6, h: 9, label: "6 × 9 in (15.24 × 22.86 cm)" },
  { key: "8x10", w: 8, h: 10, label: "8 × 10 in (20.32 × 25.4 cm)" },
  { key: "8.25x11", w: 8.25, h: 11, label: "8.25 × 11 in (21 × 27.9 cm)" },
  { key: "8.5x11", w: 8.5, h: 11, label: "8.5 × 11 in (21.59 × 27.94 cm)" },
];

const INK_OPTIONS = [
  { key: "premium_color", label: "Premium Color" },
  { key: "standard_color", label: "Standard Color" },
  { key: "bw", label: "B/N" },
];

function pxNeeded(widthIn, heightIn, dpi = 300) {
  return { w: Math.round(widthIn * dpi), h: Math.round(heightIn * dpi) };
}
function calcBleedSize(trimW, trimH, bleed) {
  // KDP: con bleed aggiungi 0.125" in larghezza e 0.25" in altezza
  return bleed ? { w: trimW + 0.125, h: trimH + 0.25 } : { w: trimW, h: trimH };
}

export default function App() {
  // --- mini-router per la sezione testo ---
  const [hash, setHash] = useState(typeof window !== "undefined" ? window.location.hash : "");
  useEffect(() => {
    const onH = () => setHash(window.location.hash);
    window.addEventListener("hashchange", onH);
    return () => window.removeEventListener("hashchange", onH);
  }, []);
  if (hash === "#text") return <TextBook />; // ⬅️ apre la sezione PDF/EPUB

  const fileInputRef = useRef(null);

  // immagini/opere
  const [items, setItems] = useState([]); // { id, name, src, width, height, title, description, warnings[] }
  const [selectedIndex, setSelectedIndex] = useState(0);

  // libro
  const [bookTitle, setBookTitle] = useState("Caravaggio – Opere");
  const [author, setAuthor] = useState("");
  const [includeTitlePage, setIncludeTitlePage] = useState(true);
  const [inkType, setInkType] = useState("premium_color");

  // impaginazione
  const [trimKey, setTrimKey] = useState("8.25x11");
  const trim = useMemo(() => TRIMS.find((t) => t.key === trimKey) || TRIMS[0], [trimKey]);
  const [bleed, setBleed] = useState(false);
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
    alert("Chiave salvata nel tuo browser.");
  }

  const fontClass = useSerif ? "font-serif" : "font-sans";

  // --- import immagini ---
  function onFilesSelected(files) {
    const arr = Array.from(files || []);
    if (!arr.length) return;

    const readers = arr.map(
      (file, idx) =>
        new Promise((resolve) => {
          const reader = new FileReader();
          reader.onload = (e) => {
            const src = e.target.result;
            const img = new Image();
            img.onload = () =>
              resolve({
                id: `${Date.now()}_${idx}`,
                name: file.name,
                src,
                width: img.width,
                height: img.height,
                title: file.name.replace(/\.[^/.]+$/, ""),
                description: "",
                warnings: [],
              });
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

  // --- validazione DPI ---
  function validateImage(it) {
    const { w: pageW, h: pageH } = calcBleedSize(trim.w, trim.h, bleed);
    const m = marginIn;
    const boxW = pageW - m * 2;
    const boxH = pageH - m * 2;
    const needs = pxNeeded(boxW, boxH, 300);
    const warns = [];
    if (it.width < needs.w || it.height < needs.h) {
      warns.push(`Risoluzione bassa: min ${needs.w}×${needs.h}px per 300DPI; attuale ${it.width}×${it.height}px.`);
    }
    return warns;
  }
  function revalidateAll() {
    setItems((prev) => prev.map((it) => ({ ...it, warnings: validateImage(it) })));
  }
  useEffect(() => {
    revalidateAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trimKey, bleed, marginIn]);

  // --- CRUD elenco ---
  function removeItem(index) {
    setItems((prev) => {
      const copy = [...prev];
      copy.splice(index, 1);
      setSelectedIndex((s) => Math.max(0, Math.min(s, copy.length - 1)));
      return copy;
    });
  }
  function moveItem(index, dir) {
    setItems((prev) => {
      const copy = [...prev];
      const to = index + dir;
      if (to < 0 || to >= copy.length) return prev;
      const [m] = copy.splice(index, 1);
      copy.splice(to, 0, m);
      setSelectedIndex(to);
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

  // --- AI ---
  async function generateWithAI(index) {
    const it = items[index];
    if (!it) return;
    if (!apiKey) {
      alert("Inserisci la tua OpenAI API Key nelle impostazioni.");
      return;
    }
    const prompt = `Scrivi una scheda per il libro su Caravaggio per l'opera "${it.title}". Struttura: Storia, Aneddoti, Analisi (chiaroscuro, composizione, contesto), Bibliografia essenziale. Tono autorevole ma accessibile. Italiano.`;
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
      alert("Errore AI: " + (e?.message || ""));
    }
  }

  // --- PDF ---
  async function exportToPdf() {
    if (!items.length) {
      alert("Carica almeno una immagine.");
      return;
    }

    const { w: pageW, h: pageH } = calcBleedSize(trim.w, trim.h, bleed);
    const doc = new jsPDF({ unit: "in", format: [pageW, pageH], orientation: "portrait" });
    const m = marginIn;

    // Pagina del titolo
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

      // sinistra: immagine dentro ai margini
      const boxW = pageW - m * 2;
      const boxH = pageH - m * 2;
      const imgR = it.width / it.height;
      const boxR = boxW / boxH;
      let drawW, drawH;
      if (imgR > boxR) {
        drawW = boxW;
        drawH = boxW / imgR;
      } else {
        drawH = boxH;
        drawW = boxH * imgR;
      }
      const offsetX = (pageW - drawW) / 2;
      const offsetY = (pageH - drawH) / 2;

      try {
        doc.addImage(it.src, "JPEG", offsetX, offsetY, drawW, drawH, undefined, "FAST");
      } catch {
        try {
          doc.addImage(it.src, "PNG", offsetX, offsetY, drawW, drawH, undefined, "FAST");
        } catch {}
      }

      // destra: testo
      doc.addPage();
      doc.setFont(useSerif ? "Times" : "Helvetica", "bold");
      doc.setFontSize(fontSize + 3);
      doc.text(it.title || "", m, m);

      doc.setFont(useSerif ? "Times" : "Helvetica", "normal");
      doc.setFontSize(fontSize);

      // ✅ riga corretta (tutta su UNA riga!)
      const text = (it.description || "").replace(/\r\n|\r/g, "\n");

      const maxWidth = pageW - m * 2;
      const lines = doc.splitTextToSize(text, maxWidth);
      const leading = (fontSize / 72) * lineHeight; // in
      let y = m + 0.35;
      for (const ln of lines) {
        if (y > pageH - m) {
          doc.addPage();
          y = m;
        }
        doc.text(ln, m, y);
        y += leading;
      }

      // mantieni coppie (se non ultimo)
      const totalPages = doc.getNumberOfPages();
      if (totalPages % 2 !== 0 && i < items.length - 1) doc.addPage();
    }

    const safeName = (bookTitle || "Caravaggio_ArtBook")
      .normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9 _-]/gi, "_").trim().replace(/\s+/g, "_");

    doc.save(`${safeName}${bleed ? "_BLEED" : ""}.pdf`);
  }

  // --- KDP checker ---
  function kdpCheck() {
    const issues = [];
    const pageCount = (includeTitlePage ? 1 : 0) + items.length * 2;

    if (inkType === "standard_color" && pageCount < 72)
      issues.push(`Pagine minime Standard Color: 72 (stima ${pageCount}).`);
    if ((inkType === "premium_color" || inkType === "bw") && pageCount < 24)
      issues.push(`Pagine minime: 24 (stima ${pageCount}).`);

    const outsideMin = bleed ? 0.375 : 0.25;
    if (marginIn < outsideMin)
      issues.push(`Margine esterno troppo piccolo: ${marginIn}" (min ${outsideMin}"${bleed ? " con bleed" : ""}).`);

    items.forEach((it, i) => {
      const warns = validateImage(it);
      if (warns.length) issues.push(`Opera #${i + 1} (${it.title}): ${warns.join(" ")}`);
    });

    alert(issues.length ? `Problemi:\n- ${issues.join("\n- ")}` : "Nessun problema critico.");
  }

  const selected = items[selectedIndex];

  return (
    <div className={`min-h-screen ${fontClass} bg-neutral-50`}>
      <div className="max-w-7xl mx-auto p-6">
        <header className="mb-6 flex items-center justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold">KDP ArtBook Builder – Caravaggio</h1>
            <p className="text-sm text-neutral-600">Doppia pagina: sinistra immagine, destra testo • PDF pronto KDP</p>
          </div>
          <div className="flex gap-2">
            <a href="#text" className="px-3 py-2 rounded-2xl border shadow-sm">Libro di Testo (PDF/EPUB)</a>
            <button onClick={kdpCheck} className="px-3 py-2 rounded-2xl border shadow-sm">KDP Checker</button>
            <button onClick={exportToPdf} className="px-4 py-2 rounded-2xl shadow bg-black text-white hover:opacity-90">Esporta PDF</button>
          </div>
        </header>

        {/* Impostazioni */}
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
            <label className="inline-flex items-center gap-2 text-sm mb-3">
              <input type="checkbox" checked={bleed} onChange={(e)=>setBleed(e.target.checked)} />
              Con bleed (+0.125" W, +0.25" H)
            </label>
            <label className="block text-sm mb-1">Margini (in)</label>
            <input type="number" step="0.1" min="0" value={marginIn} onChange={(e)=>setMarginIn(parseFloat(e.target.value)||0)} className="w-full border rounded-xl px-3 py-2 mb-3"/>
            <p className="text-xs text-neutral-500">Minimo KDP: 0.25" (no bleed) • 0.375" (con bleed).</p>
          </div>

          <div className="bg-white rounded-2xl shadow p-4">
            <h2 className="font-semibold mb-3">Testo</h2>
            <label className="block text-sm mb-1">Dimensione font (pt)</label>
            <input type="number" step="1" min="8" value={fontSize} onChange={(e)=>setFontSize(parseInt(e.target.value)||11)} className="w-full border rounded-xl px-3 py-2 mb-3"/>
            <label className="block text-sm mb-1">Interlinea</label>
            <input type="number" step="0.05" min="1" value={lineHeight} onChange={(e)=>setLineHeight(parseFloat(e.target.value)||1.35)} className="w-full border rounded-xl px-3 py-2 mb-3"/>
            <label className="inline-flex items-center gap-2 text-sm">
              <input type="checkbox" checked={useSerif} onChange={(e)=>setUseSerif(e.target.checked)} />
              Usa font con grazie (serif)
            </label>
          </div>

          <div className="bg-white rounded-2xl shadow p-4">
            <h2 className="font-semibold mb-3">Impostazioni AI</h2>
            <label className="block text-sm mb-1">OpenAI API Key</label>
            <input type="password" placeholder="sk-..." value={apiKey} onChange={(e)=>setApiKey(e.target.value)} className="w-full border rounded-xl px-3 py-2 mb-2"/>
            <div className="flex gap-2">
              <button onClick={saveKey} className="px-3 py-2 rounded-xl border shadow-sm">Salva chiave</button>
            </div>
            <p className="text-xs text-neutral-500 mt-2">La chiave resta solo su questo dispositivo.</p>
          </div>
        </section>

        {/* 3 colonne: elenco / anteprima / editor */}
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
            {items.length === 0 && <p className="text-sm text-neutral-500">Nessuna immagine.</p>}
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

          {/* anteprima */}
          <div className="bg-white rounded-2xl shadow p-4 h-[70vh] overflow-auto">
            <h3 className="font-semibold mb-3">Anteprima doppia pagina</h3>
            {selected ? (
              <div className="grid grid-cols-2 gap-4">
                <div className="aspect-[2/3] border rounded-xl flex items-center justify-center overflow-hidden bg-neutral-100">
                  <img src={selected.src} alt={selected.name} className="object-contain max-h-full max-w-full" />
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

          {/* editor */}
          <div className="bg-white rounded-2xl shadow p-4 h-[70vh] overflow-auto">
            <h3 className="font-semibold mb-3">Editor testo</h3>
            {selected ? (
              <div>
                <label className="block text-sm mb-1">Titolo opera</label>
                <input value={selected.title} onChange={(e)=>updateField(selectedIndex,"title",e.target.value)} className="w-full border rounded-xl px-3 py-2 mb-3"/>

                <label className="block text-sm mb-1">Testo (storia, aneddoti, analisi)</label>
                <textarea value={selected.description} onChange={(e)=>updateField(selectedIndex,"description",e.target.value)} className="w-full h-64 border rounded-xl px-3 py-2 mb-3" placeholder="Scrivi qui o usa 'Genera con AI'" />

                <div className="flex gap-2">
                  <button onClick={()=>generateWithAI(selectedIndex)} className="px-3 py-2 rounded-xl border shadow-sm">Genera con AI</button>
                  <button onClick={()=>updateField(selectedIndex,"description","")} className="px-3 py-2 rounded-xl border shadow-sm">Svuota</button>
                </div>
              </div>
            ) : (
              <p className="text-sm text-neutral-500">Seleziona un'opera per modificarne i contenuti.</p>
            )}
          </div>
        </section>

        <footer className="text-xs text-neutral-500 mt-6 space-y-1">
          <p>Consigli: immagini JPG/PNG ad alta qualità. Senza bleed: margini ≥ 0.25". Con bleed: pagina = trim + 0.125" (W) e +0.25" (H).</p>
        </footer>
      </div>
    </div>
  );
}
