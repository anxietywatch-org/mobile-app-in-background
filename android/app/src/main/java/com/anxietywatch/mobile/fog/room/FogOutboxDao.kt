package com.anxietywatch.mobile.fog.room

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query

@Dao
interface FogOutboxDao {

    @Insert(onConflict = OnConflictStrategy.IGNORE)
    fun insert(entry: FogOutboxEntry): Long

    @Query(
        "SELECT COUNT(*) FROM fog_outbox WHERE state != :ackedState AND next_attempt_at <= :now",
    )
    fun countPending(now: Long, ackedState: String = FogOutboxEntry.STATE_WATCH_ACKED): Int

    @Query("SELECT COUNT(*) FROM fog_outbox WHERE state != :ackedState")
    fun countRemaining(ackedState: String = FogOutboxEntry.STATE_WATCH_ACKED): Int

    @Query(
        "SELECT * FROM fog_outbox WHERE state != :ackedState AND next_attempt_at <= :now " +
            "ORDER BY received_at ASC",
    )
    fun pending(now: Long, ackedState: String = FogOutboxEntry.STATE_WATCH_ACKED): List<FogOutboxEntry>

    @Query("SELECT * FROM fog_outbox WHERE kind = :kind AND entity_id = :entityId LIMIT 1")
    fun byKey(kind: String, entityId: String): FogOutboxEntry?

    @Query("DELETE FROM fog_outbox WHERE kind = :kind AND entity_id = :entityId")
    fun delete(kind: String, entityId: String): Int

    @Query(
        "UPDATE fog_outbox SET state = :ackedState, cloud_acked_at = :now " +
            "WHERE kind = :kind AND entity_id = :entityId",
    )
    fun markCloudAcked(kind: String, entityId: String, now: Long, ackedState: String = FogOutboxEntry.STATE_CLOUD_ACKED): Int

    @Query(
        "UPDATE fog_outbox SET state = :ackedState, watch_acked_at = :now " +
            "WHERE kind = :kind AND entity_id = :entityId",
    )
    fun markWatchAcked(kind: String, entityId: String, now: Long, ackedState: String = FogOutboxEntry.STATE_WATCH_ACKED): Int

    @Query(
        "UPDATE fog_outbox SET state = :failedState, attempts = attempts + 1, next_attempt_at = :nextAttemptAt " +
            "WHERE kind = :kind AND entity_id = :entityId",
    )
    fun markFailed(
        kind: String,
        entityId: String,
        nextAttemptAt: Long,
        failedState: String = FogOutboxEntry.STATE_FAILED,
    ): Int

    /**
     * Solo se elimina una entrada cuando ya fue confirmada por el reloj
     * (watch_acked_at presente). Si aún no hay ACK del reloj, el borrado se
     * ignora: la entrada queda para reintentar la confirmación.
     */
    @Query(
        "DELETE FROM fog_outbox WHERE kind = :kind AND entity_id = :entityId " +
            "AND state = :ackedState",
    )
    fun completeOnlyIfWatchAcked(
        kind: String,
        entityId: String,
        ackedState: String = FogOutboxEntry.STATE_WATCH_ACKED,
    ): Int

    @Query("DELETE FROM fog_outbox WHERE state = :ackedState AND watch_acked_at < :cutoff")
    fun cleanupAcked(cutoff: Long, ackedState: String = FogOutboxEntry.STATE_WATCH_ACKED): Int

    @Query("DELETE FROM fog_outbox WHERE state = :failedState AND received_at < :cutoff")
    fun cleanupFailed(cutoff: Long, failedState: String = FogOutboxEntry.STATE_FAILED): Int
}
