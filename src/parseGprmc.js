/**
 * Convierte coordenada NMEA (ddmm.mmmm, N/S/E/W) a decimal.
 */
function nmeaToDecimal(value, hemi) {
  if (value == null || value === "") return null;
  const n = String(value).replace(",", ".");
  const v = parseFloat(n, 10);
  if (Number.isNaN(v)) return null;
  const abs = Math.floor(v / 100) + (v % 100) / 60;
  if (hemi === "S" || hemi === "W") return -abs;
  return abs;
}

/**
 * Parsea un fragmento de línea GPRMC NMEA.
 * Ejemplo: GPRMC,033421.851,A,2234.0209,N,11403.0733,E,...
 */
export function parseGprmcLine(line) {
  const s = String(line).trim();
  if (!s.includes("GPRMC")) return null;
  const idx = s.indexOf("GPRMC");
  const rest = s.slice(idx);
  const parts = rest.split(",");
  if (parts.length < 7) return null;
  // parts[0] = GPRMC, [1] time, [2] status A=valid, [3-4] lat, [5-6] lon
  if (parts[2] !== "A") {
    return { valid: false, reason: "status_not_A", raw: s };
  }
  const lat = nmeaToDecimal(parts[3], parts[4]);
  const lon = nmeaToDecimal(parts[5], parts[6]);
  return {
    valid: true,
    time: parts[1] || null,
    latitude: lat,
    longitude: lon,
    raw: s,
  };
}

/**
 * Busca y parsea GPRMC dentro de un payload tipo Xexun (CSV con muchos campos).
 */
export function tryParseXexunText(body) {
  const text = typeof body === "string" ? body : String(body ?? "");
  const g = parseGprmcLine(text);
  if (g) return g;
  const m = /GPRMC[^*\r\n]+/i.exec(text);
  if (m) return parseGprmcLine(m[0]);
  return null;
}
