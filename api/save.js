export const config = { runtime: "edge" };

// Usa le ENV di Upstash (Marketplace o account Upstash)
const URL = process.env.UPSTASH_REDIS_REST_URL;
const TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

export default async function handler(req) {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405, headers: { "content-type": "application/json" }
    });
  }
  try {
    const { id, payload } = await req.json();
    if (!id || !payload) {
      return new Response(JSON.stringify({ error: "Missing id or payload" }), {
        status: 400, headers: { "content-type": "application/json" }
      });
    }
    if (!URL || !TOKEN) {
      return new Response(JSON.stringify({ error: "Missing Upstash env vars" }), {
        status: 500, headers: { "content-type": "application/json" }
      });
    }

    // Comando Redis via REST (POST body) per evitare limiti di URL length
    const value = JSON.stringify(payload);
    const resp = await fetch(URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(["SET", id, value])
    });
    const out = await resp.json();
    if (!resp.ok) throw new Error(out?.error || "Upstash SET failed");

    return new Response(JSON.stringify({ ok: true }), {
      status: 200, headers: { "content-type": "application/json" }
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e?.message || "Save failed" }), {
      status: 500, headers: { "content-type": "application/json" }
    });
  }
}
