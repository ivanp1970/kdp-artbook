export const config = { runtime: "edge" };
import { kv } from "@vercel/kv";

export default async function handler(req) {
  if (req.method !== "GET") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { "content-type": "application/json" }
    });
  }
  try {
    const { searchParams } = new URL(req.url);
    const id = searchParams.get("id");
    if (!id) {
      return new Response(JSON.stringify({ error: "Missing id" }), {
        status: 400,
        headers: { "content-type": "application/json" }
      });
    }
    const payload = await kv.get(id);
    if (!payload) {
      return new Response(JSON.stringify({ error: "Bozza non trovata" }), {
        status: 404,
        headers: { "content-type": "application/json" }
      });
    }
    return new Response(JSON.stringify({ ok: true, payload }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e?.message || "Load failed" }), {
      status: 500,
      headers: { "content-type": "application/json" }
    });
  }
}
