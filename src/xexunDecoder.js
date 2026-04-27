/**
 * Decodificador "best-effort" del protocolo Xexun nuevo (PO2):
 *   FA AF | msgId(2) | seq(2) | IMEI(8 BCD) | length(2) | crc(2) | payload(length) | FA AF
 *
 * El protocolo binario completo (0x14 position) define muchos sub-paquetes.
 * Aquí se extraen los campos comunes (IMEI, msgId, seq, length) y, cuando el
 * payload tiene tamaño suficiente, se intenta sacar lat/lon como dos doubles
 * big-endian en offsets habituales (degrees * 100). Si la lectura no encaja
 * con el rango terrestre, se devuelve sin coordenadas.
 */

function bcdImeiToString(bytes) {
  let s = "";
  for (const b of bytes) {
    const hi = (b >> 4) & 0xf;
    const lo = b & 0xf;
    if (hi <= 9) s += String(hi);
    if (lo <= 9) s += String(lo);
  }
  return s;
}

function isPlausibleLatLon(lat, lon) {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lon) &&
    lat >= -90 &&
    lat <= 90 &&
    lon >= -180 &&
    lon <= 180 &&
    !(lat === 0 && lon === 0)
  );
}

function tryDecodeCoords(payload) {
  const tries = [];
  // 1) doubles big-endian a offsets 18 (lon) y 26 (lat) – degrees*100
  if (payload.length >= 34) {
    const lonRaw = payload.readDoubleBE(18);
    const latRaw = payload.readDoubleBE(26);
    tries.push({ off: "18/26 BE /100", lat: latRaw / 100, lon: lonRaw / 100 });
    tries.push({ off: "18/26 BE", lat: latRaw, lon: lonRaw });
  }
  // 2) Variante invertida (lat primero)
  if (payload.length >= 34) {
    const latRaw = payload.readDoubleBE(18);
    const lonRaw = payload.readDoubleBE(26);
    tries.push({ off: "18/26 BE swap /100", lat: latRaw / 100, lon: lonRaw / 100 });
  }
  for (const t of tries) {
    if (isPlausibleLatLon(t.lat, t.lon)) return t;
  }
  return null;
}

export function decodePacket(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 20) return null;
  if (buf[0] !== 0xfa || buf[1] !== 0xaf) return null;
  if (buf[buf.length - 2] !== 0xfa || buf[buf.length - 1] !== 0xaf) return null;

  const msgId = buf.readUInt16BE(2);
  const seq = buf.readUInt16BE(4);
  const imei = bcdImeiToString(buf.subarray(6, 14));
  const length = buf.readUInt16BE(14);
  const crc = buf.readUInt16BE(16);
  const payload = buf.subarray(18, 18 + length);

  const out = {
    msgId,
    msgIdHex: `0x${msgId.toString(16).padStart(4, "0")}`,
    seq,
    imei,
    length,
    crc,
    payloadLength: payload.length,
    payloadHex: payload.toString("hex"),
  };

  if (msgId === 0x14 && payload.length >= 34) {
    const c = tryDecodeCoords(payload);
    if (c) {
      out.lat = c.lat;
      out.lon = c.lon;
      out.coordsSource = c.off;
    }
  }

  return out;
}

/**
 * Divide un buffer con varias tramas concatenadas (el GPS suele mandar
 * múltiples FA AF...FA AF seguidas en una misma escritura TCP).
 */
export function splitPackets(buf) {
  const packets = [];
  if (!Buffer.isBuffer(buf)) return packets;
  let i = 0;
  while (i + 20 <= buf.length) {
    if (buf[i] !== 0xfa || buf[i + 1] !== 0xaf) {
      i++;
      continue;
    }
    if (i + 16 > buf.length) break;
    const length = buf.readUInt16BE(i + 14);
    const totalLen = 18 + length + 2;
    if (i + totalLen > buf.length) break;
    if (
      buf[i + totalLen - 2] !== 0xfa ||
      buf[i + totalLen - 1] !== 0xaf
    ) {
      i++;
      continue;
    }
    packets.push(buf.subarray(i, i + totalLen));
    i += totalLen;
  }
  return packets;
}
