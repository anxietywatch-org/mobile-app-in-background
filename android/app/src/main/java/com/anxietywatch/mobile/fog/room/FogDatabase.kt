package com.anxietywatch.mobile.fog.room

import android.content.Context
import androidx.room.Database
import androidx.room.Room
import androidx.room.RoomDatabase
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import org.json.JSONArray

@Database(entities = [FogOutboxEntry::class], version = 1, exportSchema = false)
abstract class FogDatabase : RoomDatabase() {
    abstract fun fogOutboxDao(): FogOutboxDao

    companion object {
        private const val DB_NAME = "fog_outbox.db"

        @Volatile
        private var instance: FogDatabase? = null

        fun get(context: Context): FogDatabase =
            instance ?: synchronized(this) {
                instance ?: Room.databaseBuilder(
                    context.applicationContext,
                    FogDatabase::class.java,
                    DB_NAME,
                ).build().also { database ->
                    // Instalaciones anteriores guardaban la cola como un arreglo
                    // JSON en SharedPreferences. La importación se intenta antes
                    // de exponer Room y solo elimina el origen tras una transacción
                    // correcta; repetirla es seguro por UNIQUE(kind, entity_id).
                    runCatching {
                        runBlocking {
                            withContext(Dispatchers.IO) {
                                migrateLegacyQueue(context.applicationContext, database)
                            }
                        }
                    }
                    instance = database
                }
            }

        internal fun migrateLegacyQueue(context: Context, database: FogDatabase): Boolean {
            val preferences = context.getSharedPreferences(LEGACY_PREFS, Context.MODE_PRIVATE)
            if (!preferences.contains(LEGACY_QUEUE)) return true

            val raw = preferences.getString(LEGACY_QUEUE, null) ?: return false
            val array = runCatching { JSONArray(raw) }.getOrNull() ?: return false
            val entries = mutableListOf<FogOutboxEntry>()
            for (index in 0 until array.length()) {
                val item = array.optJSONObject(index) ?: return false
                val kind = item.optString("kind").trim()
                val legacyKey = item.optString("entityId")
                    .ifBlank { item.optString("key") }
                    .trim()
                val entityId = legacyKey.removePrefix("$kind:")
                val payload = item.optString("envelope")
                    .ifBlank { item.optString("payload") }
                if (kind.isBlank() || entityId.isBlank() || payload.isBlank()) return false

                entries += FogOutboxEntry(
                    kind = kind,
                    entityId = entityId,
                    payload = payload,
                    receivedAt = item.optLong("receivedAt", System.currentTimeMillis()),
                )
            }

            database.runInTransaction {
                val dao = database.fogOutboxDao()
                entries.forEach(dao::insert)
            }
            return preferences.edit().remove(LEGACY_QUEUE).commit()
        }

        internal const val LEGACY_PREFS = "fog_inbound"
        internal const val LEGACY_QUEUE = "inbound_queue"
    }
}
