export const config = { runtime: "edge" };

const URL = process.env.UPSTASH_REDIS_REST_URL;
const TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

export default async function handler(req) {
  if (req.method !== "GET") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405, headers: { "content-type": "application/json" }
    });
  }
  try {
    const { searchParams } = new URL(req.url);
    const id = searchParams.get("id");
    if (!id) {
      return new Response(JSON.stringify({ error: "Missing id" }), {
        status: 400, headers: { "content-type": "application/json" }
      });
    }
    if (!URL || !TOKEN) {
      return new Response(JSON.stringify({ error: "Missing Upstash env vars" }), {
        status: 500, headers: { "content-type": "application/json" }
      });
    }

    const resp = await fetch(URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(["GET", id])
    });
    const out = await resp.json();
    if (!resp.ok) throw new Error(out?.error || "Upstash GET failed");
    if (out.result == null) {
      return new Response(JSON.stringify({ error: "Bozza non trovata" }), {
        status: 404, headers: { "content-type": "application/json" }
      });
    }

    const payload = JSON.parse(out.result);
    return new Response(JSON.stringify({ ok: true, payload }), {
      status: 200, headers: { "content-type": "application/json" }
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e?.message || "Load failed" }), {
      status: 500, headers: { "content-type": "application/json" }
    });
  }
}
