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
  const coords =
    dec.lat != null && dec.lon != null
      ? `lat=${dec.lat.toFixed(6)} lon=${dec.lon.toFixed(6)}`
      : "sin coordenadas válidas en este paquete";
  return (
    `imei=${dec.imei} | msg=${dec.msgIdHex} | seq=${dec.seq} | length=${dec.length} | ${coords}`
  );
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
