export const config = { runtime: "edge" };

// Funziona con Vercel KV (KV_REST_API_*) o Upstash (UPSTASH_REDIS_REST_*)
const URL =
  process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const TOKEN =
  process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;

export default async function handler(req) {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405, headers: { "content-type": "application/json" }
    });
  }
  try {
    const { id, payload } = await req.json();
    if (!id || !payload)
      return new Response(JSON.stringify({ error: "Missing id or payload" }), {
        status: 400, headers: { "content-type": "application/json" }
      });

    if (!URL || !TOKEN)
      return new Response(JSON.stringify({ error: "Missing KV/Upstash env vars" }), {
        status: 500, headers: { "content-type": "application/json" }
      });

    const resp = await fetch(URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      // comando Redis in formato REST
      body: JSON.stringify(["SET", id, JSON.stringify(payload)])
    });
    const out = await resp.json();
    if (!resp.ok) throw new Error(out?.error || "KV/Upstash SET failed");

    return new Response(JSON.stringify({ ok: true }), {
      status: 200, headers: { "content-type": "application/json" }
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e?.message || "Save failed" }), {
      status: 500, headers: { "content-type": "application/json" }
    });
  }
}
