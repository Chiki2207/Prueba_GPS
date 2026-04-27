import net from "node:net";
import { decodePacket, splitPackets } from "./xexunDecoder.js";

/**
 * Rastreadores Xexun (PO2, etc.): muchos hablan por TCP con tramas 0xFA 0xAF, no por HTTP.
 * Documentación: el servidor a veces debe responder 1 byte (p. ej. 0x00) al recibir;
 * se puede desactivar con XEXUN_TCP_ACK=0.
 */
function chunkHex(buf, max = 128) {
  const s = buf.toString("hex");
  return s.length > max * 2 ? `${s.slice(0, max * 2)}…` : s;
}

function describePacket(dec) {
  const parts = [
    `imei=${dec.imei}`,
    `msg=${dec.msgIdHex}`,
    `seq=${dec.seq}`,
    `len=${dec.lengthPayload ?? dec.length}`,
  ];
  if (dec.parseError) parts.push(`parse=${dec.parseError}`);
  if (dec.timestampISO) parts.push(`ts=${dec.timestampISO}`);
  if (dec.rssi != null) parts.push(`rssi=${dec.rssi}`);
  if (dec.battery != null) {
    const b = dec.battery > 100 ? `${dec.battery}(raw)` : `${dec.battery}%`;
    parts.push(`bat=${b}${dec.charging ? " cargando" : ""}`);
  }
  if (dec.satellites != null) parts.push(`sats=${dec.satellites}`);
  if (dec.speedKmh != null) parts.push(`vel=${dec.speedKmh.toFixed(1)}km/h`);
  if (dec.courseDeg != null) parts.push(`rumbo=${dec.courseDeg.toFixed(1)}°`);
  if (dec.altitudeM != null) parts.push(`alt=${dec.altitudeM.toFixed(0)}m`);
  if (dec.lat != null && dec.lon != null) {
    parts.push(`lat=${dec.lat.toFixed(6)} lon=${dec.lon.toFixed(6)}`);
    if (dec.valid === false) parts.push("fix=no");
  } else if (dec.cells?.length) {
    const c = dec.cells[0];
    parts.push(
      `LBS MCC=${c.mcc} MNC=${c.mnc} LAC=${c.lac} CID=${c.cid} (sin lat/lon en trama; torre GSM)`,
    );
  } else if (dec.wifi?.length) {
    parts.push(`WiFi APs=${dec.wifi.length} (sin lat/lon en trama)`);
  } else if ((dec.lengthPayload ?? dec.length) === 12) {
    parts.push("heartbeat (sin posición)");
  } else {
    parts.push("sin coordenadas en trama (revisar máscara / tipo de dato)");
  }
  return parts.join(" | ");
}

export function startXexunTcpServer(port, options = {}) {
  const { sendAck = true } = options;
  if (!port || port < 1) return null;

  const server = net.createServer((socket) => {
    const id = `${socket.remoteAddress ?? "?"}:${socket.remotePort ?? "?"}`;
    let totalBytes = 0;
    console.log(`[TCP-Xexun] conexión ${id}`);

    socket.on("data", (chunk) => {
      totalBytes += chunk.length;
      const len = chunk.length;
      const head = len >= 2 && chunk[0] === 0xfa && chunk[1] === 0xaf;
      console.log(
        `[TCP-Xexun] ${id} | len=${len}${head ? " | cabecera FA AF" : ""} | hex=${chunkHex(chunk)}`,
      );

      try {
        const packets = splitPackets(chunk);
        for (const p of packets) {
          const dec = decodePacket(p);
          if (!dec) continue;
          console.log(`[GPS] ${id} | ${describePacket(dec)}`);
        }
      } catch (e) {
        console.error(`[TCP-Xexun] error decodificando ${id}:`, e.message);
      }

      if (sendAck) {
        try {
          socket.write(Buffer.from([0x00]));
        } catch {
          // ignorar
        }
      }
    });

    socket.on("error", (e) => {
      console.error(`[TCP-Xexun] error socket ${id}:`, e.message);
    });
    socket.on("close", () => {
      if (totalBytes === 0) {
        console.log(
          `[TCP-Xexun] cierre ${id} | sin datos (0 bytes) — suele ser sondeo de red o cliente que no mandó carga; no es todavía una trama del GPS`,
        );
      } else {
        console.log(`[TCP-Xexun] cierre ${id} | total recibido ${totalBytes} bytes`);
      }
    });
  });

  server.listen(port, "0.0.0.0", () => {
    console.log(`[TCP-Xexun] escuchando TCP 0.0.0.0:${port} (binario, no HTTP)`);
  });
  server.on("error", (e) => {
    console.error("[TCP-Xexun] error del servidor:", e.message);
  });

  return server;
}
