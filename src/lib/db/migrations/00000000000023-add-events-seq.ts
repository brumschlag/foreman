/**
 * Add monotonic `seq` cursor column to the events table.
 *
 * UUIDs are not ordered, so they cannot be used as SSE Last-Event-ID cursors.
 * A bigserial column provides a guaranteed-monotonic integer that the SSE
 * endpoint uses for reconnect replay (WHERE seq > $lastSeq).
 */
import type { MigrationBuilder } from "node-pg-migrate";

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.addColumn("events", {
    seq: {
      type: "bigserial",
      notNull: true,
    },
  });

  pgm.createIndex("events", "seq", { unique: true, ifNotExists: true });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropIndex("events", "seq", { ifExists: true });
  pgm.dropColumn("events", "seq");
}
