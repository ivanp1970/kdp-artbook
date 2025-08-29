export const config = { runtime: "edge" };
import { kv } from "@vercel/kv";

export default async function handler(req) {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { "content-type": "application/json" }
    });
  }
  try {
    const { id, payload } = await req.json();
    if (!id || !payload) {
      return new Response(JSON.stringify({ error: "Missing id or payload" }), {
        status: 400,
        headers: { "content-type": "application/json" }
      });
    }
    await kv.set(id, payload);
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e?.message || "Save failed" }), {
      status: 500,
      headers: { "content-type": "application/json" }
    });
  }
}
