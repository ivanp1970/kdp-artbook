import React, { useEffect, useMemo, useRef, useState } from "react";
import { jsPDF } from "jspdf";

// Trim più comuni
const TRIMS = [
  { key: "6x9", w: 6, h: 9, label: "6 × 9 in" },
  { key: "8x10", w: 8, h: 10, label: "8 × 10 in" },
  { key: "8.25x11", w: 8.25, h: 11, label: "8.25 × 11 in" },
  { key: "8.5x11", w: 8.5, h: 11, label: "8.5 × 11 in" }
];

// Spessore dorso per pagina (KDP):
// Bianco: 0.002252"  • Crema: 0.0025"  • Colore: 0.002347"
const SPINE_PER_PAGE = { white: 0.002252, cream: 0.0025, color: 0.002347 };

// Helpers
function Num({ label, value, onChange, step = 1, min, max }) {
  return (
    <label className="block text-sm mb-1">
      {label}
      <input
        type="number"
        className="w-full border rounded-xl px-3 py-2 mt-1"
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value) || 0)}
        step={step}
        min={min}
        max={max}
      />
    </label>
  );
}

function imgFromDataURL(dataURL) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = dataURL;
  });
}

function imageTypeForDataURL(dataURL) {
  const m = /^data:image\/(png|jpeg|jpg)/i.exec(dataURL || "");
  if (!m) return "JPEG";
  const t = m[1].toLowerCase();
  return t === "png" ? "PNG" : "JPEG";
}

export default function CoverDesigner() {
  const [trimKey, setTrimKey] = useState("8.25x11");
  const trim = useMemo(() => TRIMS.find((t) => t.key === trimKey) || TRIMS[0], [trimKey]);

  const [pageCount, setPageCount] = useState(120);
  const [paper, setPaper] = useState("color"); // white | cream | color
  const [bleed, setBleed] = useState(true);
  const [showGrid, setShowGrid] = useState(true);
  const [includeGuides, setIncludeGuides] = useState(false);

  // immagini
  const [front, setFront] = useState(null); // {src,img,w,h,scale,x,y}
  const [back, setBack] = useState(null);

  // Carica PRIMA/QUARTA salvate da TextBook.jsx
  useEffect(() => {
    (async () => {
      try {
        const b = localStorage.getItem("kdp_cover_back");
        const f = localStorage.getItem("kdp_cover_front");
        if (b) {
          const img = await imgFromDataURL(b);
          setBack({ src: b, img, w: img.width, h: img.height, scale: 1, x: 0, y: 0 });
          localStorage.removeItem("kdp_cover_back");
        }
        if (f) {
          const img = await imgFromDataURL(f);
          setFront({ src: f, img, w: img.width, h: img.height, scale: 1, x: 0, y: 0 });
          localStorage.removeItem("kdp_cover_front");
        }
      } catch (e) {
        console.warn("Errore caricando immagini dal localStorage:", e);
      }
    })();
  }, []);

  const spine = useMemo(() => (pageCount > 0 ? pageCount * SPINE_PER_PAGE[paper] : 0), [pageCount, paper]);
  const fullW = (trim.w * 2) + spine + (bleed ? 0.25 : 0); // +0.125" sx +0.125" dx
  const fullH = trim.h + (bleed ? 0.25 : 0);               // +0.125" top +0.125" bottom

  const dpi = 300;
  const pxW = Math.round(fullW * dpi);
  const pxH = Math.round(fullH * dpi);

  const canvasRef = useRef(null);

  function loadSide(file, side) {
    const fr = new FileReader();
    fr.onload = async (e) => {
      const src = e.target.result;
      const img = await imgFromDataURL(src);
      const obj = { src, img, w: img.width, h: img.height, scale: 1, x: 0, y: 0 };
      side === "front" ? setFront(obj) : setBack(obj);
    };
    fr.readAsDataURL(file);
  }

  function fitSide(side) {
    const obj = side === "front" ? front : back;
    if (!obj) return;
    const bleedPad = bleed ? 0.125 : 0;
    const areaW = trim.w + bleedPad; // area singola (retro o fronte) in larghezza
    const areaH = trim.h + (bleed ? 0.25 : 0);
    const targetWpx = areaW * dpi, targetHpx = areaH * dpi;
    const rImg = obj.w / obj.h, rBox = targetWpx / targetHpx;
    const scale = rImg > rBox ? targetHpx / obj.h : targetWpx / obj.w;
    const next = { ...obj, scale, x: 0, y: 0 };
    side === "front" ? setFront(next) : setBack(next);
  }

  useEffect(() => {
    const cnv = canvasRef.current;
    if (!cnv) return;
    const ctx = cnv.getContext("2d");
    const previewW = 1100; // larghezza preview UI
    const scale = previewW / (fullW * dpi);
    const W = Math.round(fullW * dpi * scale), H = Math.round(fullH * dpi * scale);
    cnv.width = W; cnv.height = H;

    // sfondo
    ctx.fillStyle = "#fafafa"; ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = "#e5e7eb"; ctx.lineWidth = 1; ctx.strokeRect(0, 0, W, H);

    const bleedPad = bleed ? 0.125 : 0;
    const leftBleed = bleed ? 0.125 : 0;
    const topBleed = bleed ? 0.125 : 0;

    // aree in px preview
    const backW = (trim.w + bleedPad) * dpi * scale;
    const spineW = spine * dpi * scale;
    const frontW = (trim.w + bleedPad) * dpi * scale;
    const trimHpx = trim.h * dpi * scale;

    const backX = leftBleed * dpi * scale;
    const trimY = topBleed * dpi * scale;
    const frontTrimX = backX + backW + spineW;

    // griglia 1/4"
    if (showGrid) {
      ctx.strokeStyle = "#d1d5db"; ctx.lineWidth = 0.5;
      const step = 0.25 * dpi * scale;
      for (let x = 0; x <= W; x += step) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }
      for (let y = 0; y <= H; y += step) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }
    }

    // spine area
    ctx.fillStyle = "#f1f5f9";
    ctx.fillRect(backX + backW, 0, spineW, H);

    // trim boxes
    ctx.strokeStyle = "#9ca3af"; ctx.lineWidth = 1.2;
    ctx.strokeRect(backX, trimY, backW - (bleed ? 0.125 * dpi * scale : 0), trimHpx);
    ctx.strokeRect(frontTrimX, trimY, frontW - (bleed ? 0.125 * dpi * scale : 0), trimHpx);

    // draw retro
    if (back) {
      ctx.save();
      const bx = backX + back.x * scale, by = trimY + back.y * scale;
      ctx.drawImage(back.img, bx, by, back.w * back.scale * scale, back.h * back.scale * scale);
      ctx.restore();
    }
    // draw fronte
    if (front) {
      ctx.save();
      const fx = frontTrimX + front.x * scale, fy = trimY + front.y * scale;
      ctx.drawImage(front.img, fx, fy, front.w * front.scale * scale, front.h * front.scale * scale);
      ctx.restore();
    }

    // guide di sicurezza
    const safe = 0.25 * dpi * scale;
    ctx.setLineDash([6, 4]); ctx.strokeStyle = "#ef4444"; ctx.lineWidth = 1;
    ctx.strokeRect(backX + safe, trimY + safe, (backW - (bleed ? 0.125 * dpi * scale : 0)) - safe * 2, trimHpx - safe * 2);
    ctx.strokeRect(frontTrimX + safe, trimY + safe, (frontW - (bleed ? 0.125 * dpi * scale : 0)) - safe * 2, trimHpx - safe * 2);
    // spine safe 1/16" per lato
    const spineSafe = 0.0625 * dpi * scale;
    ctx.strokeRect(backX + backW + spineSafe, trimY + safe, spineW - spineSafe * 2, trimHpx - safe * 2);
    ctx.setLineDash([]);
  }, [front, back, trimKey, pageCount, paper, bleed, showGrid, spine, fullW, fullH]);

  function exportPdf() {
    const doc = new jsPDF({ unit: "in", format: [fullW, fullH] });
    const mTop = bleed ? 0.125 : 0;
    const mLeft = bleed ? 0.125 : 0;

    // Coordinate base delle aree in pollici
    const backOriginX = mLeft + 0;
    const backOriginY = mTop + 0;
    const frontOriginX = mLeft + (trim.w + (bleed ? 0.125 : 0)) + spine;
    const frontOriginY = mTop + 0;

    // Disegna RETRO rispettando scala/offset
    if (back) {
      const type = imageTypeForDataURL(back.src);
      const wIn = (back.w * back.scale) / dpi;
      const hIn = (back.h * back.scale) / dpi;
      const xIn = backOriginX + (back.x / dpi);
      const yIn = backOriginY + (back.y / dpi);
      doc.addImage(back.src, type, xIn, yIn, wIn, hIn);
    }

    // Disegna FRONTE rispettando scala/offset
    if (front) {
      const type = imageTypeForDataURL(front.src);
      const wIn = (front.w * front.scale) / dpi;
      const hIn = (front.h * front.scale) / dpi;
      const xIn = frontOriginX + (front.x / dpi);
      const yIn = frontOriginY + (front.y / dpi);
      doc.addImage(front.src, type, xIn, yIn, wIn, hIn);
    }

    if (includeGuides) {
      doc.setDrawColor(150); doc.setLineWidth(0.01);
      doc.rect(0, 0, fullW, fullH); // bordo esterno

      const spineX = mLeft + (trim.w + (bleed ? 0.125 : 0));
      doc.setDrawColor(180);
      doc.rect(spineX, 0, spine, fullH); // area dorso

      // safe boxes 0.25"
      doc.setDrawColor(255, 0, 0);
      const safe = 0.25;
      // retro
      doc.rect(mLeft + safe, mTop + safe, (trim.w + (bleed ? 0.125 : 0)) - safe * 2, trim.h - safe * 2);
      // fronte
      doc.rect(spineX + spine + safe, mTop + safe, (trim.w + (bleed ? 0.125 : 0)) - safe * 2, trim.h - safe * 2);
      // spine safe 1/16"
      const spineSafe = 0.0625;
      doc.rect(spineX + spineSafe, mTop + safe, spine - spineSafe * 2, trim.h - safe * 2);
    }

    const name = `COVER_${trim.w}x${trim.h}_${pageCount}p_${paper}${bleed ? "_BLEED" : ""}.pdf`;
    doc.save(name);
  }

  return (
    <div className="p-4 space-y-4">
      <header className="flex flex-wrap items-end gap-3">
        <div>
          <h2 className="text-xl font-bold">Designer Copertina – KDP</h2>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <button className="px-4 py-2 rounded-2xl shadow bg-black text-white" onClick={exportPdf}>Esporta PDF</button>
        </div>
      </header>

      <section className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* impostazioni */}
        <div className="bg-white rounded-2xl shadow p-4">
          <h3 className="font-semibold mb-2">Impostazioni</h3>
          <label className="block text-sm mb-1">Trim</label>
          <select value={trimKey} onChange={(e)=>setTrimKey(e.target.value)} className="w-full border rounded-xl px-3 py-2 mb-2">
            {TRIMS.map(t => <option key={t.key} value={t.key}>{t.label}</option>)}
          </select>
          <Num label="Pagine" value={pageCount} onChange={setPageCount} step={2} min={24} />
          <label className="block text-sm mb-1">Carta</label>
          <select value={paper} onChange={(e)=>setPaper(e.target.value)} className="w-full border rounded-xl px-3 py-2 mb-2">
            <option value="white">White (B/N)</option>
            <option value="cream">Cream (B/N)</option>
            <option value="color">Color</option>
          </select>
          <label className="inline-flex items-center gap-2 text-sm mb-2"><input type="checkbox" checked={bleed} onChange={e=>setBleed(e.target.checked)} /> Bleed 0.125″ per lato</label>
          <label className="inline-flex items-center gap-2 text-sm mb-2"><input type="checkbox" checked={showGrid} onChange={e=>setShowGrid(e.target.checked)} /> Mostra griglia (¼″)</label>
          <label className="inline-flex items-center gap-2 text-sm mb-2"><input type="checkbox" checked={includeGuides} onChange={e=>setIncludeGuides(e.target.checked)} /> Includi guide nel PDF</label>

          <div className="text-xs text-neutral-600 mt-3 space-y-1">
            <p><b>Larghezza totale:</b> {fullW.toFixed(3)}″ ({pxW} px @300DPI)</p>
            <p><b>Altezza totale:</b> {fullH.toFixed(3)}″ ({pxH} px @300DPI)</p>
            <p><b>Dorso:</b> {spine.toFixed(3)}″</p>
          </div>
        </div>

        {/* retro */}
        <div className="bg-white rounded-2xl shadow p-4">
          <h3 className="font-semibold mb-2">Retro (quarta di copertina)</h3>
          <input type="file" accept="image/*" onChange={(e)=>e.target.files && loadSide(e.target.files[0], "back")} />
          {back && (
            <div className="grid grid-cols-3 gap-2 mt-2">
              <Num label="Scala" value={back.scale} onChange={(v)=>setBack({...back, scale: v})} step={0.01} min={0.05} max={10} />
              <Num label="X (px)" value={back.x} onChange={(v)=>setBack({...back, x: v})} step={1} />
              <Num label="Y (px)" value={back.y} onChange={(v)=>setBack({...back, y: v})} step={1} />
              <button className="col-span-3 px-3 py-2 border rounded-xl" onClick={()=>fitSide("back")}>Adatta all'area</button>
            </div>
          )}
        </div>

        {/* fronte */}
        <div className="bg-white rounded-2xl shadow p-4">
          <h3 className="font-semibold mb-2">Fronte (prima di copertina)</h3>
          <input type="file" accept="image/*" onChange={(e)=>e.target.files && loadSide(e.target.files[0], "front")} />
          {front && (
            <div className="grid grid-cols-3 gap-2 mt-2">
              <Num label="Scala" value={front.scale} onChange={(v)=>setFront({...front, scale: v})} step={0.01} min={0.05} max={10} />
              <Num label="X (px)" value={front.x} onChange={(v)=>setFront({...front, x: v})} step={1} />
              <Num label="Y (px)" value={front.y} onChange={(v)=>setFront({...front, y: v})} step={1} />
              <button className="col-span-3 px-3 py-2 border rounded-xl" onClick={()=>fitSide("front")}>Adatta all'area</button>
            </div>
          )}
        </div>
      </section>

      <section className="bg-white rounded-2xl shadow p-4">
        <h3 className="font-semibold mb-2">Anteprima (griglia non stampata)</h3>
        <canvas ref={canvasRef} className="w-full h-auto border rounded-xl" />
      </section>

      <p className="text-xs text-neutral-500">
        Suggerimenti: mantieni testi a ≥0.25″ dal bordo; sul dorso lascia ≥0.0625″ per lato; riserva spazio barcode ~2″×1.2″ sul retro (in basso a destra).
      </p>
    </div>
  );
}
