import http from "node:http";
import express from "express";
import morgan from "morgan";
import { tryParseXexunText } from "./parseGprmc.js";

const PORT = Number(process.env.PORT) || 5002;
const app = express();

app.use(morgan("dev"));

// Cuerpo crudo antes de express.json: si no, el stream ya se consumió
const raw2mb = express.raw({ type: () => true, limit: "2mb" });
function asUtf8String(buf) {
  if (!Buffer.isBuffer(buf)) return typeof buf === "string" ? buf : String(buf ?? "");
  return buf.toString("utf8");
}
function tryParseBuffer(buf) {
  const s = asUtf8String(buf);
  if (!s) return { kind: "empty", value: s };
  const t = s.trim();
  if (t.startsWith("{") || t.startsWith("[")) {
    try {
      return { kind: "json", value: JSON.parse(s) };
    } catch {
      return { kind: "text", value: s };
    }
  }
  return { kind: "text", value: s };
}

/** Escribe en consola cada posición recibida (además de la línea morgan de la petición). */
function logGpsConsole(source, parsed, options = {}) {
  const { textPreview, jsonBody } = options;
  if (parsed && parsed.valid && parsed.latitude != null && parsed.longitude != null) {
    console.log(
      `[GPS] ${source} | lat ${parsed.latitude.toFixed(6)} lon ${parsed.longitude.toFixed(6)} | time ${parsed.time ?? "—"}`,
    );
    if (textPreview) console.log(`[GPS] raw: ${String(textPreview).slice(0, 300)}${String(textPreview).length > 300 ? "…" : ""}`);
    return;
  }
  if (jsonBody) {
    console.log(`[GPS] ${source} (JSON) |`, jsonBody);
    return;
  }
  if (textPreview) {
    console.log(`[GPS] ${source} (sin GPRMC) | len=${String(textPreview).length} |`, String(textPreview).slice(0, 200));
  } else {
    console.log(`[GPS] ${source} | sin posición parseable`, parsed);
  }
}

function makeIngestHandler(source) {
  return (req, res) => {
    const parsedFromBuf = tryParseBuffer(req.body);
    let body = req.body;
    if (parsedFromBuf.kind === "json") {
      body = parsedFromBuf.value;
    } else if (parsedFromBuf.kind === "text") {
      body = parsedFromBuf.value;
    }
    if (body && typeof body === "object" && !Buffer.isBuffer(body)) {
      logGpsConsole(source, null, { jsonBody: body });
      return res.json({ ok: true, method: "POST", source, query: req.query, body, parsed: null });
    }
    const text = asUtf8String(Buffer.isBuffer(req.body) ? req.body : body);
    const parsed = tryParseXexunText(text);
    logGpsConsole(source, parsed, { textPreview: text });
    return res.json({
      ok: true,
      method: "POST",
      source,
      query: req.query,
      parsed,
      rawSample: text.slice(0, 500),
    });
  };
}

app.get("/ingest", (req, res) => {
  return res.json({ ok: true, method: "GET", query: req.query, parsed: null, rawSample: null });
});

/** Misma lógica que /ingest: Xexun “reenviar a mi plataforma” suele usar solo IP:puerto (= POST /) */
app.post("/", raw2mb, makeIngestHandler("root"));
app.post("/ingest", raw2mb, makeIngestHandler("ingest"));

app.post("/xexun", raw2mb, (req, res) => {
  const text = asUtf8String(req.body);
  const parsed = tryParseXexunText(text);
  logGpsConsole("xexun", parsed, { textPreview: text });
  return res.json({
    ok: true,
    result: {
      source: "xexun_text",
      receivedAt: new Date().toISOString(),
      rawLength: text.length,
      parsed,
    },
  });
});

app.use(express.json({ limit: "2mb" }));
app.use(
  express.text({ type: ["text/*", "text/plain", "application/*+text"], limit: "2mb" }),
);
app.use(express.urlencoded({ extended: true, limit: "2mb" }));

// Salud
app.get("/health", (req, res) => {
  res.json({ ok: true, service: "gps-receiver", port: PORT });
});

// Pruebas: JSON { latitude, longitude } o { lat, lng }
app.post("/api/position", (req, res) => {
  const b = req.body || {};
  const lat = b.latitude ?? b.lat;
  const lon = b.longitude ?? b.lng ?? b.lon;
  if (lat == null || lon == null) {
    return res.status(400).json({
      error: "Faltan latitude/longitude (o lat/lng)",
    });
  }
  const row = {
    source: "json",
    receivedAt: new Date().toISOString(),
    latitude: Number(lat),
    longitude: Number(lon),
    extra: {
      ...b,
      latitude: undefined,
      longitude: undefined,
      lat: undefined,
      lng: undefined,
      lon: undefined,
    },
  };
  logGpsConsole("api/position", { valid: true, latitude: row.latitude, longitude: row.longitude, time: "—" });
  return res.json({ ok: true, position: row });
});

app.use((req, res) => {
  res.status(404).json({ error: "Not found" });
});

const server = http.createServer(app);
server.listen(PORT, "0.0.0.0", () => {
  console.log(`GPS receiver escuchando en http://0.0.0.0:${PORT}`);
  console.log("  GET  /health        — estado");
  console.log("  POST /api/position  — JSON { latitude, longitude } o { lat, lng }");
  console.log("  POST /xexun         — cuerpo crudo (GPRMC / Xexun texto)");
  console.log("  POST /              — reenvío típico Xexun (IP:puerto sin ruta)");
  console.log("  GET|POST /ingest    — query + cuerpo (mismo parser)");
  console.log(
    "Nota Xexun PO2: muchos usan protocolo binario TCP (0xFAAF), no HTTP. Apunta IP:puerto TCP o usa Traccar si no hay modo URL/HTTP en el menú del equipo.",
  );
  console.log(
    "Configuración: en el rastreador (SMS o app) fija APN, servidor = IP pública o dominio del VPS, puerto 5002, ruta/servidor según el manual (URL http://IP:5002/xexun si el dispositivo admite reporte por HTTP).",
  );
});
