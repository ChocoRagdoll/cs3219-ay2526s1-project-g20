// src/ws/websocketServer.ts
import { Server as HttpServer } from "http";
import { WebSocketServer, WebSocket } from "ws";
import { RoomRegistry } from "../rooms/roomRegistry";
import { makeContext } from "./connectionContext";
import { ClientMessage, ServerMessage, safeParse } from "./messageTypes";
import { extractTokenFromReq, verifyToken, AuthConfig, UserClaims } from "../auth/jwt";
import { YjsManager, b64ToUint8 } from "../crdt/yjsManager";

interface WSInitOptions {
  path: string;
  logger?: any;
  auth: AuthConfig;
}

const HEARTBEAT_MS = Number(process.env.HEARTBEAT_INTERVAL_MS ?? 30_000);
const HEARTBEAT_MULTIPLIER = Number(process.env.HEARTBEAT_TIMEOUT_MULTIPLIER ?? 10);

export async function initWebsocketServer(
  httpServer: HttpServer,
  options: WSInitOptions
) {
  const wss = new WebSocketServer({ server: httpServer, path: options.path });
  const rooms = new RoomRegistry();
  const y = new YjsManager({ logger: options.logger });
  const log = options.logger ?? console;

  setInterval(() => {
    wss.clients.forEach((ws: WebSocket & { __ctx?: any }) => {
      const ctx = ws.__ctx;
      if (!ctx) return;
      const now = Date.now();
      if (now - ctx.lastSeen > HEARTBEAT_MS * HEARTBEAT_MULTIPLIER) {
        try { ws.close(4000, "heartbeat-timeout"); } catch {}
      } else {
        try { ws.send(JSON.stringify({ type: "PONG" } as ServerMessage)); } catch {}
      }
    });

    // also sweep idle Yjs rooms
    y.sweepIdle();
  }, HEARTBEAT_MS).unref();

  wss.on("connection", (ws, req) => {
    // ---- authenticate ----
    const token = extractTokenFromReq(req);
    if (!token) return void ws.close(4401, "unauthorized");

    let claims: UserClaims;
    try { claims = verifyToken(token, options.auth); }
    catch (err: any) { log.warn({ err: err?.message }, "JWT verification failed"); return void ws.close(4401, "invalid-token"); }

    const ctx = makeContext(ws);
    (ws as any).__ctx = ctx;
    ctx.userId = claims.userId;
    (ctx as any).claims = claims;
    log.info({ ip: req.socket.remoteAddress, userId: ctx.userId }, "WS connected (auth)");

    ws.on("message", (buf) => {
      ctx.lastSeen = Date.now();
      const raw = buf.toString();
      const msg = safeParse<ClientMessage>(raw);
      if (!msg || typeof (msg as any).type !== "string") {
        return send(ws, { type: "ERROR", code: "BAD_JSON", message: "Invalid message" });
      }

      switch (msg.type) {
        case "PING":
          return send(ws, { type: "PONG" });

        case "JOIN_ROOM": {
          const roomId = (msg as any).roomId;
          if (!roomId) return send(ws, { type: "ERROR", code: "ROOM_ID_REQUIRED", message: "roomId is required" });

          // optional enforcement
          if (options.auth.requireRoomClaim && claims.roomId && claims.roomId !== roomId) {
            return send(ws, { type: "ERROR", code: "FORBIDDEN_ROOM", message: "Not allowed to join this room" });
          }

          // leave previous
          if (ctx.roomId) {
            rooms.leave(ctx.roomId, ws);
            y.leave(ctx.roomId, ws);
          }
          ctx.roomId = roomId;

          // join registries
          const participants = rooms.join(roomId, ws);
          y.join(roomId, ws, ctx.userId);

          send(ws, { type: "JOINED", roomId, participants });
          return;
        }

        case "LEAVE_ROOM": {
          if (!ctx.roomId) return;
          const prev = ctx.roomId;
          rooms.leave(prev, ws);
          y.leave(prev, ws);
          ctx.roomId = undefined;
          send(ws, { type: "LEFT", roomId: prev });
          return;
        }

        case "YJS_UPDATE": {
          if (!ctx.roomId) return;
          const payloadB64 = (msg as any).payloadB64;
          if (!payloadB64) return;
          y.applyUpdate(ctx.roomId, b64ToUint8(payloadB64), { userId: ctx.userId });
          return;
        }

        case "AWARENESS_SET": {
          if (!ctx.roomId) return;
          const payloadB64 = (msg as any).payloadB64;
          if (!payloadB64) return;
          y.applyAwareness(ctx.roomId, b64ToUint8(payloadB64), { userId: ctx.userId });
          return;
        }

        default:
          return send(ws, { type: "ERROR", code: "UNKNOWN_TYPE", message: `Unknown type ${(msg as any).type}` });
      }
    });

    ws.on("close", () => {
      if ((ws as any).__ctx?.roomId) {
        const rid = (ws as any).__ctx.roomId;
        rooms.leave(rid, ws);
        y.leave(rid, ws);
      } else {
        rooms.leaveAll(ws);
        y.leaveAll(ws);
      }
      log.info({ userId: ctx.userId }, "WS disconnected");
    });

    ws.on("error", (err) => {
      log.error({ err, userId: ctx.userId }, "WS error");
    });
  });

  log.info({ path: options.path }, "WebSocket server ready (auth + Yjs)");
  return wss;
}

function send(ws: WebSocket, msg: ServerMessage) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}
