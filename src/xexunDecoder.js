/**
 * Decodificador del protocolo Xexun2 (PO2, FA AF), alineado con Traccar
 * `Xexun2ProtocolDecoder.java`:
 *   FA AF | msgId(2) | seq(2) | IMEI(8 BCD) | length(2) & 0x3ff | crc(2) | payload | FA AF
 *
 * Payload 0x0014: N grupos; cada grupo = cabecera + máscaras + GPS/LBS/WiFi…
 * Coordenadas: float o double en formato NMEA empaquetado (convertCoordinate).
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

/** NMEA-like: grados enteros = trunc(value/100), minutos = resto → decimal ° */
function convertCoordinate(value) {
  const degrees = Math.trunc(value / 100);
  const minutes = value - degrees * 100;
  return degrees + minutes / 60;
}

function bitCheck(mask, bit) {
  return (mask & (1 << bit)) !== 0;
}

/**
 * Lee un bloque de posición (un elemento del array `lengths` del PDF / Traccar).
 * @param {Buffer} buf
 * @param {number} start
 * @param {number} endIndex
 */
function readPositionGroup(buf, start, endIndex) {
  let o = start;
  /** @type {Record<string, unknown>} */
  const out = { valid: false };

  if (o + 10 > endIndex) {
    out.partial = true;
    return out;
  }

  out.packetIndex = buf.readUInt8(o++);
  const unix = buf.readUInt32BE(o);
  o += 4;
  out.timestamp = unix;
  if (unix > 946684800 && unix < 4000000000) {
    out.timestampISO = new Date(unix * 1000).toISOString();
  }

  out.rssi = buf.readUInt8(o++);
  const battWord = buf.readUInt16BE(o);
  o += 2;
  out.charging = (battWord & 0x8000) !== 0;
  out.battery = battWord & 0x7fff;

  const mask = buf.readUInt8(o++);
  out.maskHex = `0x${mask.toString(16).padStart(2, "0")}`;

  if (bitCheck(mask, 0)) {
    if (o + 4 > endIndex) return out;
    out.alarmFlags = buf.readUInt32BE(o);
    o += 4;
  }

  if (bitCheck(mask, 1)) {
    if (o + 1 > endIndex) return out;
    const positionMask = buf.readUInt8(o++);
    out.positionMaskHex = `0x${positionMask.toString(16).padStart(2, "0")}`;

    if (bitCheck(positionMask, 0)) {
      if (o + 1 + 4 + 4 > endIndex) return out;
      out.valid = true;
      out.satellites = buf.readUInt8(o++);
      out.lon = convertCoordinate(buf.readFloatBE(o));
      o += 4;
      out.lat = convertCoordinate(buf.readFloatBE(o));
      o += 4;
    }

    if (bitCheck(positionMask, 1)) {
      if (o + 1 > endIndex) return out;
      const wifiCount = buf.readUInt8(o++);
      out.wifi = [];
      for (let j = 0; j < wifiCount; j++) {
        if (o + 7 > endIndex) break;
        out.wifi.push({
          mac: buf.subarray(o, o + 6).toString("hex"),
          rssi: buf.readInt8(o + 6),
        });
        o += 7;
      }
    }

    if (bitCheck(positionMask, 2)) {
      if (o + 1 > endIndex) return out;
      const cellCount = buf.readUInt8(o++);
      out.cells = [];
      for (let j = 0; j < cellCount; j++) {
        if (o + 13 > endIndex) break;
        out.cells.push({
          mcc: buf.readUInt16BE(o),
          mnc: buf.readUInt16BE(o + 2),
          lac: buf.readInt32BE(o + 4),
          cid: buf.readUInt32BE(o + 8),
          signal: buf.readInt8(o + 12),
        });
        o += 13;
      }
    }

    if (bitCheck(positionMask, 3)) {
      if (o + 1 > endIndex) return out;
      const tofN = buf.readUInt8(o++);
      o += 12 * tofN;
    }

    if (bitCheck(positionMask, 5)) {
      if (o + 4 > endIndex) return out;
      out.speedKmh = buf.readUInt16BE(o) * 0.1;
      o += 2;
      out.courseDeg = buf.readUInt16BE(o) * 0.1;
      o += 2;
    }

    if (bitCheck(positionMask, 6)) {
      if (o + 1 + 8 + 8 > endIndex) return out;
      out.valid = true;
      out.satellites = buf.readUInt8(o++);
      out.lon = convertCoordinate(buf.readDoubleBE(o));
      o += 8;
      out.lat = convertCoordinate(buf.readDoubleBE(o));
      o += 8;
    }

    if (bitCheck(positionMask, 7)) {
      if (o + 2 > endIndex) return out;
      const dataLength = buf.readUInt16BE(o);
      o += 2;
      if (dataLength > 0) {
        if (o + 1 + 2 > endIndex) return out;
        const dataType = buf.readUInt8(o++);
        const innerLen = buf.readUInt16BE(o);
        o += 2;
        const dataEnd = o + innerLen;
        if (dataType === 0x47 /* 'G' */ && dataEnd <= endIndex) {
          if (o + 8 + 8 + 1 + 1 + 1 + 2 + 2 + 4 <= dataEnd) {
            out.lon = convertCoordinate(buf.readDoubleBE(o));
            o += 8;
            out.lat = convertCoordinate(buf.readDoubleBE(o));
            o += 8;
            out.valid = buf.readUInt8(o++) > 0;
            out.satellites = buf.readUInt8(o++);
            buf.readUInt8(o++); // SNR
            out.speedKmh = buf.readUInt16BE(o) * 0.1;
            o += 2;
            out.courseDeg = buf.readUInt16BE(o) * 0.1;
            o += 2;
            out.altitudeM = buf.readFloatBE(o);
            o += 4;
          }
        }
        o = dataEnd;
      }
    }
  }

  if (bitCheck(mask, 3)) {
    if (o + 4 > endIndex) return out;
    out.fingerprint = buf.readUInt32BE(o);
    o += 4;
  }
  if (bitCheck(mask, 4)) {
    if (o + 38 > endIndex) return out;
    o += 20 + 8 + 10;
  }
  if (bitCheck(mask, 5)) {
    if (o + 12 > endIndex) return out;
    o += 12;
  }

  if (o < endIndex) {
    out.tailHex = buf.subarray(o, endIndex).toString("hex");
    o = endIndex;
  }

  return out;
}

/**
 * @param {Buffer} payload
 * @returns {{ groups: Record<string, unknown>[]; parseError?: string }}
 */
export function parseXexun2PositionPayload(payload) {
  const result = { groups: [] };
  if (payload.length < 3) return result;

  let o = 0;
  const count = payload.readUInt8(o++);
  if (count === 0 || count > 32) {
    result.parseError = "bad_group_count";
    return result;
  }

  const lengths = [];
  for (let i = 0; i < count; i++) {
    if (o + 2 > payload.length) {
      result.parseError = "truncated_lengths";
      return result;
    }
    lengths.push(payload.readUInt16BE(o));
    o += 2;
  }

  for (let gi = 0; gi < count; gi++) {
    const endIndex = o + lengths[gi];
    if (endIndex > payload.length) {
      result.parseError = "truncated_group";
      result.groups.push({ groupIndex: gi, error: "overflow" });
      break;
    }
    result.groups.push(readPositionGroup(payload, o, endIndex));
    o = endIndex;
  }

  return result;
}

/** Lectura plausible antes de fusionar (evita que un último grupo “basura” pise uno bueno). */
function groupHasPlausibleGps(g) {
  if (g.lat == null || g.lon == null) return false;
  if (!Number.isFinite(g.lat) || !Number.isFinite(g.lon)) return false;
  if (Math.abs(g.lat) < 1e-5 && Math.abs(g.lon) < 1e-5) return false;
  if (g.satellites != null && g.satellites > 32) return false;
  if (g.speedKmh != null && g.speedKmh > 280) return false;
  return true;
}

function mergeGroupsForLog(groups) {
  /** @type {Record<string, unknown>} */
  const m = {};
  /** @type {{ mcc: number; mnc: number; lac: number; cid: number; signal: number }[]} */
  const cellsCombined = [];
  /** @type {{ mac: string; rssi: number }[]} */
  const wifiCombined = [];
  const seenCell = new Set();

  for (const g of groups) {
    if (g.cells?.length) {
      for (const c of g.cells) {
        const k = `${c.mcc}:${c.mnc}:${c.lac}:${c.cid}`;
        if (seenCell.has(k)) continue;
        seenCell.add(k);
        cellsCombined.push(c);
      }
    }
    if (g.wifi?.length) wifiCombined.push(...g.wifi);

    if (m.timestampISO == null && g.timestampISO) m.timestampISO = g.timestampISO;
    if (m.battery == null && g.battery != null) m.battery = g.battery;
    if (m.charging == null && g.charging != null) m.charging = g.charging;
    if (m.rssi == null && g.rssi != null) m.rssi = g.rssi;
  }

  if (cellsCombined.length) m.cells = cellsCombined;
  if (wifiCombined.length) m.wifi = wifiCombined;

  let lat;
  let lon;
  let valid = false;
  for (let gi = groups.length - 1; gi >= 0; gi--) {
    const g = groups[gi];
    if (groupHasPlausibleGps(g)) {
      lat = g.lat;
      lon = g.lon;
      valid = !!g.valid;
      if (g.speedKmh != null) m.speedKmh = g.speedKmh;
      if (g.courseDeg != null) m.courseDeg = g.courseDeg;
      if (g.altitudeM != null) m.altitudeM = g.altitudeM;
      if (g.satellites != null) m.satellites = g.satellites;
      break;
    }
  }

  if (lat != null) {
    m.lat = lat;
    m.lon = lon;
    m.valid = valid;
  }
  return m;
}

/**
 * Descarta lat/lon (y campos derivados) cuando son típicos de “sin fix” o
 * lectura desalineada (p. ej. satélites > 32, 0° con velocidad alta).
 */
function sanitizeMergedGps(m) {
  if (m.lat == null || m.lon == null) return;
  const nearZero =
    Math.abs(m.lat) < 1e-5 && Math.abs(m.lon) < 1e-5;
  const badSats = m.satellites != null && m.satellites > 32;
  const insaneSpeed = m.speedKmh != null && m.speedKmh > 280;
  const incoherent =
    nearZero && m.speedKmh != null && m.speedKmh > 35;

  if (nearZero || badSats || insaneSpeed || incoherent) {
    delete m.lat;
    delete m.lon;
    delete m.valid;
    delete m.speedKmh;
    delete m.courseDeg;
    delete m.altitudeM;
    delete m.satellites;
    if (nearZero) m.gpsRejected = "coords_nulas_sin_fix";
    else if (badSats) m.gpsRejected = "satelites_imposible_parser";
    else if (insaneSpeed) m.gpsRejected = "velocidad_imposible";
    else m.gpsRejected = "coords_vel_incoherentes";
  }
}

/** Útil para el servidor TCP: ¿tiene lat/lon creíbles después del saneo? */
export function hasTrustworthyGps(dec) {
  return (
    dec?.lat != null &&
    dec?.lon != null &&
    Number.isFinite(dec.lat) &&
    Number.isFinite(dec.lon) &&
    !dec.gpsRejected &&
    (Math.abs(dec.lat) > 1e-5 || Math.abs(dec.lon) > 1e-5)
  );
}

function tryDecodePosition(payload) {
  const parsed = parseXexun2PositionPayload(payload);
  const merged = mergeGroupsForLog(parsed.groups);
  sanitizeMergedGps(merged);
  return {
    ...merged,
    positionGroups: parsed.groups.length,
    parseError: parsed.parseError,
  };
}

export function decodePacket(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 20) return null;
  if (buf[0] !== 0xfa || buf[1] !== 0xaf) return null;
  if (buf[buf.length - 2] !== 0xfa || buf[buf.length - 1] !== 0xaf) return null;

  const msgId = buf.readUInt16BE(2);
  const seq = buf.readUInt16BE(4);
  const imei = bcdImeiToString(buf.subarray(6, 14));
  const rawLength = buf.readUInt16BE(14);
  const length = rawLength & 0x03ff;
  const crc = buf.readUInt16BE(16);
  const payload = buf.subarray(18, 18 + length);

  const out = {
    msgId,
    msgIdHex: `0x${msgId.toString(16).padStart(4, "0")}`,
    seq,
    imei,
    length: rawLength,
    lengthPayload: length,
    crc,
    payloadLength: payload.length,
    payloadHex: payload.toString("hex"),
  };

  if (msgId === 0x14) {
    Object.assign(out, tryDecodePosition(payload));
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
    const rawLen = buf.readUInt16BE(i + 14);
    const length = rawLen & 0x03ff;
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
