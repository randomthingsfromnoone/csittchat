import { parseRecord } from './shared/model.ts';

// Validation runs on the decoded graph, just like the browser's view.
// This is not a pre-decode transport firewall or an authenticated author check.
export async function cleanGraph(db: any, now = Date.now(), verify = (_record: any) => true) {
  const { results } = await db.map({});
  let removed = 0;
  const expiredRooms = new Set<string>();
  for (const { id, value } of results) {
    const record = parseRecord(id, value, now);
    if (record?.kind === 'room' && record.expiresAt <= now) expiredRooms.add(record.id);
  }
  for (const { id } of results) {
    // Read again: a heartbeat or room renewal may have updated the snapshot.
    const { result } = await db.get(id);
    if (!result) continue;
    const record = parseRecord(id, result.value, now);
    if (record?.kind === 'message' && expiredRooms.has(record.roomId)) {
      const roomId = `room:${record.roomId}`;
      const { result: roomNode } = await db.get(roomId);
      const room = roomNode && parseRecord(roomId, roomNode.value, now);
      if (room?.kind === 'room' && room.expiresAt > now) expiredRooms.delete(record.roomId);
    }
    if (!record || !verify(record) || record.expiresAt <= now || (record.kind === 'message' && expiredRooms.has(record.roomId))) {
      await db.remove(id);
      removed++;
    }
  }
  return removed;
}
