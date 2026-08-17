package com.anxietywatch.mobile.fog.room

import androidx.room.ColumnInfo
import androidx.room.Entity
import androidx.room.Index
import androidx.room.PrimaryKey

/**
 * Cola de salida persistente del nodo fog.
 *
 * UNIQUE(kind, entity_id): un mismo `entityId` puede existir una sola vez por
 * kind (p. ej. el evento SOS y su cancelación comparten eventId pero son kinds
 * distintos). Esto elimina la colisión que existía al deduplicar solo por key.
 */
@Entity(
    tableName = "fog_outbox",
    indices = [Index(value = ["kind", "entity_id"], unique = true)],
)
data class FogOutboxEntry(
    @PrimaryKey(autoGenerate = true) val id: Long = 0,
    val kind: String,
    @ColumnInfo(name = "entity_id") val entityId: String,
    val payload: String,
    val state: String = STATE_PENDING,
    val attempts: Int = 0,
    @ColumnInfo(name = "next_attempt_at") val nextAttemptAt: Long = 0L,
    @ColumnInfo(name = "cloud_acked_at") val cloudAckedAt: Long? = null,
    @ColumnInfo(name = "watch_acked_at") val watchAckedAt: Long? = null,
    @ColumnInfo(name = "received_at") val receivedAt: Long = System.currentTimeMillis(),
) {
    val key: String get() = "$kind:$entityId"

    companion object {
        const val STATE_PENDING = "PENDING"
        const val STATE_CLOUD_ACKED = "CLOUD_ACKED"
        const val STATE_WATCH_ACKED = "WATCH_ACKED"
        const val STATE_FAILED = "FAILED"
    }
}
