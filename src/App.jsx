import React, { useEffect, useMemo, useRef, useState } from "react";
import { jsPDF } from "jspdf";

/**
 * KDP ArtBook Builder – Caravaggio (v2)
 *
 * Novità:
 * - 🔌 Integrazione AI lato‑client (OpenAI) con chiave salvata in localStorage
 * - 🧱 Formati pagina selezionabili: 6×9, 8×10, 8.5×11 (+ bleed on/off)
 * - 🖼️ Controllo DPI immagini (target 300 DPI) con indicatori/warning
 * - ✅ "KDP Checker" per verifiche base (pagine minime, margini, bleed, DPI)
 * - 📄 PDF jsPDF in pollici; gestione coppie sinistra/descrizione destra
 *
 * Nota sicurezza: per semplicità la chiave OpenAI è inserita da te nell'app e salvata localmente.
 * Usala solo su dispositivi tuoi. Per protezione totale, passa a una funzione server /api (Vercel).
 */

// --- Utility ---
const inToPt = (inch) => inch * 72;

const TRIMS = [
  { key: "6x9", w: 6, h: 9, label: "6 × 9 in (15.24 × 22.86 cm)" },
  { key: "8x10", w: 8, h: 10, label: "8 × 10 in (20.32 × 25.4 cm)" },
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
  if (!bleed) return { w: trimW, h: trimH };
  // KDP: +0.125" in larghezza, +0.25" in altezza (0.125" per lato alto/basso)
  return { w: trimW + 0.125, h: trimH + 0.25 };
}

export default function KdpArtBookBuilder() {
  const fileInputRef = useRef(null);
  const [items, setItems] = useState([]); // { id, name, src, width, height, title, description, warnings:[] }
  const [selectedIndex, setSelectedIndex] = useState(0);

  // Libro
  const [bookTitle, setBookTitle] = useState("Caravaggio – Opere");
  const [author, setAuthor] = useState("");
  const [includeTitlePage, setIncludeTitlePage] = useState(true);
  const [inkType, setInkType] = useState("premium_color");

  // Impaginazione
  const [trimKey, setTrimKey] = useState("6x9");
  const trim = useMemo(() => TRIMS.find((t) => t.key === trimKey) || TRIMS[0], [trimKey]);
  const [bleed, setBleed] = useState(false);
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
    alert("Chiave salvata solo su questo browser.");
  }

  // Stile base
  const fontClass = useSerif ? "font-serif" : "font-sans";

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
            });
          };
          img.src = src;
        };
        reader.readAsDataURL(file);
      })
    );

    Promise.all(readers).then((newItems) => {
      // subito valida DPI per ogni immagine
      const validated = newItems.map((it) => ({ ...it, warnings: validateImage(it) }));
      setItems((prev) => {
        const merged = [...prev, ...validated];
        if (prev.length === 0) setSelectedIndex(0);
        return merged;
      });
    });
  }

  function validateImage(it) {
    const { w: pageW, h: pageH } = calcBleedSize(trim.w, trim.h, bleed);
    const m = marginIn;
    // L'immagine è posta nella pagina sinistra, dentro ai margini
    const boxW = pageW - m * 2;
    const boxH = pageH - m * 2;
    const needs = pxNeeded(boxW, boxH, 300);
    const warns = [];
    if (it.width < needs.w || it.height < needs.h) {
      warns.push(
        `Risoluzione bassa per stampa 300DPI a pagina intera: minimo ${needs.w}×${needs.h}px, hai ${it.width}×${it.height}px.`
      );
    }
    return warns;
  }

  function revalidateAll() {
    setItems((prev) => prev.map((it) => ({ ...it, warnings: validateImage(it) })));
  }

  function removeItem(index) {
    setItems((prev) => {
      const copy = [...prev];
      copy.splice(index, 1);
      let nextSelected = selectedIndex;
      if (index === selectedIndex) nextSelected = Math.max(0, selectedIndex - 1);
      setSelectedIndex(nextSelected);
      return copy;
    });
  }

  function moveItem(index, dir) {
    setItems((prev) => {
      const copy = [...prev];
      const newIndex = index + dir;
      if (newIndex < 0 || newIndex >= copy.length) return prev;
      const [moved] = copy.splice(index, 1);
      copy.splice(newIndex, 0, moved);
      setSelectedIndex(newIndex);
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

  async function generateWithAI(index) {
    const it = items[index];
    if (!it) return;
    if (!apiKey) {
      alert("Inserisci la tua OPENAI API KEY in Impostazioni.");
      return;
    }
    const prompt = `Scrivi una scheda per il libro su Caravaggio per l'opera "${it.title}". Struttura in: Storia, Aneddoti, Analisi (chiaroscuro, composizione, contesto), Fonti/bibliografia essenziale. Tono autorevole ma accessibile. Lingua: italiano.`;
    try {
      const res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
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
      alert("Errore durante la generazione del testo: " + (e?.message || ""));
    }
  }

  async function exportToPdf() {
    if (!items.length) {
      alert("Carica almeno una immagine.");
      return;
    }

    const { w: pageW, h: pageH } = calcBleedSize(trim.w, trim.h, bleed);
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
      // Pagina sinistra (immagine dentro margini)
      const boxW = pageW - m * 2;
      const boxH = pageH - m * 2;
      const imgRatio = it.width / it.height;
      const boxRatio = boxW / boxH;
      let drawW, drawH;
      if (imgRatio > boxRatio) {
        drawW = boxW;
        drawH = boxW / imgRatio;
      } else {
        drawH = boxH;
        drawW = boxH * imgRatio;
      }
      const offsetX = (pageW - drawW) / 2;
      const offsetY = (pageH - drawH) / 2;

      try {
        doc.addImage(it.src, "JPEG", offsetX, offsetY, drawW, drawH, undefined, "FAST");
      } catch (e) {
        try {
          doc.addImage(it.src, "PNG", offsetX, offsetY, drawW, drawH, undefined, "FAST");
        } catch (e2) {
          console.warn("Immagine non aggiunta", e2);
        }
      }

      // Pagina destra (testo)
      doc.addPage();
      doc.setFont(useSerif ? "Times" : "Helvetica", "bold");
      doc.setFontSize(fontSize + 3);
      doc.text(it.title || "", m, m);

      doc.setFont(useSerif ? "Times" : "Helvetica", "normal");
      doc.setFontSize(fontSize);

      const text = (it.description || "").replace(/
|
/g, "
");
      const maxWidth = pageW - m * 2;
      const lines = doc.splitTextToSize(text, maxWidth);
      const leading = (fontSize / 72) * lineHeight; // in
      let cursorY = m + 0.35;
      lines.forEach((ln) => {
        if (cursorY > pageH - m) {
          doc.addPage();
          cursorY = m;
        }
        doc.text(ln, m, cursorY);
        cursorY += leading;
      });

      const totalPages = doc.getNumberOfPages();
      if (totalPages % 2 !== 0 && i < items.length - 1) {
        doc.addPage();
      }
    }

    const fname = (bookTitle || "Caravaggio_ArtBook").replace(/[^a-z0-9_\- ]/gi, "_") + (bleed ? "_BLEED" : "") + `.pdf`;
    doc.save(fname);
  }

  function kdpCheck() {
    const issues = [];

    // Pagine minime
    // Per Standard Color: min 72; per Premium Color/BW: min 24 (KDP)
    const pageCountEstimate = (includeTitlePage ? 1 : 0) + items.length * 2; // stima minima
    if (inkType === "standard_color" && pageCountEstimate < 72) {
      issues.push(`Pagine minime per Standard Color: 72. Attuali (stima): ${pageCountEstimate}.`);
    }
    if ((inkType === "premium_color" || inkType === "bw") && pageCountEstimate < 24) {
      issues.push(`Pagine minime per ${inkType === "bw" ? "B/N" : "Premium Color"}: 24. Attuali (stima): ${pageCountEstimate}.`);
    }

    // Margini minimi
    const outsideMin = bleed ? 0.375 : 0.25;
    if (marginIn < outsideMin) {
      issues.push(`Margine esterno troppo piccolo: ${marginIn}\". Minimo: ${outsideMin}\" (${bleed ? "con" : "senza"} bleed).`);
    }

    // DPI immagini
    items.forEach((it, i) => {
      const warns = validateImage(it);
      if (warns.length) issues.push(`Opera #${i + 1} (${it.title}): ${warns.join(" ")}`);
    });

    alert(issues.length ? `Problemi trovati:
- ` + issues.join("
- ") : "Nessun problema critico trovato secondo i controlli base.");
  }

  useEffect(() => {
    // se cambiano parametri di impaginazione, rivalida
    revalidateAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trimKey, bleed, marginIn]);

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
            <button onClick={kdpCheck} className="px-3 py-2 rounded-2xl border shadow-sm">KDP Checker</button>
            <button onClick={exportToPdf} className="px-4 py-2 rounded-2xl shadow bg-black text-white hover:opacity-90">Esporta PDF</button>
          </div>
        </header>

        {/* Impostazioni libro */}
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
              Con bleed (+0.125\" W, +0.25\" H)
            </label>
            <label className="block text-sm mb-1">Margini (in)</label>
            <input type="number" step="0.1" min="0" value={marginIn} onChange={(e)=>setMarginIn(parseFloat(e.target.value)||0)} className="w-full border rounded-xl px-3 py-2 mb-3"/>
            <p className="text-xs text-neutral-500">Minimo KDP: 0.25" (senza bleed) / 0.375" (con bleed).</p>
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
            <p className="text-xs text-neutral-500 mt-2">La chiave viene salvata nel tuo browser. Per massima sicurezza usa una funzione server /api.</p>
          </div>
        </section>

        {/* Import immagini + colonne */}
        <section className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {/* Colonna elenco opere */}
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
            {items.length === 0 && (
              <p className="text-sm text-neutral-500">Nessuna immagine. Importane alcune per iniziare.</p>
            )}
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

          {/* Colonna anteprima spread */}
          <div className="bg-white rounded-2xl shadow p-4 h-[70vh] overflow-auto">
            <h3 className="font-semibold mb-3">Anteprima doppia pagina</h3>
            {selected ? (
              <div className="grid grid-cols-2 gap-4">
                <div className="aspect-[2/3] border rounded-xl flex items-center justify-center overflow-hidden bg-neutral-100">
                  <img src={selected.src} alt={selected.name} className="object-contain max-h-full max-w-full" />
                </div>
                <div className="aspect-[2/3] border rounded-xl p-3 overflow-auto">
                  <h4 className="font-semibold mb-2 break-words">{selected.title || selected.name}</h4>
                  <div className="prose prose-neutral max-w-none whitespace-pre-wrap text-sm leading-relaxed">{selected.description || <span className="text-neutral-400">(Nessun testo)</span>}</div>
                </div>
              </div>
            ) : (
              <p className="text-sm text-neutral-500">Seleziona un'opera dall'elenco.</p>
            )}
          </div>

          {/* Colonna editor testo */}
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
          <p>Consigli: usa immagini JPG ad alta qualità. Per KDP senza bleed, mantieni margini ≥ 0.25" (consigliato 0.5"). Con bleed, pagina = trim + 0.125" (W) e +0.25" (H).</p>
        </footer>
      </div>
    </div>
  );
}
