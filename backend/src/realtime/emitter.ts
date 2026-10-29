import type { Server } from 'socket.io';

/**
 * Thin indirection so services can push realtime events without importing the HTTP server.
 * When no Socket.IO server is attached (scripts, unit tests) emits are silently skipped —
 * persistence is always the source of truth, never the socket.
 */
let io: Server | null = null;

export function setIo(server: Server | null) {
  io = server;
}

export function getIo() {
  return io;
}

export function emitToRoom(room: string, event: string, payload: unknown) {
  io?.to(room).emit(event, payload);
}

export const rooms = {
  user: (id: string) => `user:${id}`,
  conversation: (id: string) => `conv:${id}`,
  staff: 'staff',
};
