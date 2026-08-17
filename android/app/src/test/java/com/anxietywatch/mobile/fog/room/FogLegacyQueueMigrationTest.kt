package com.anxietywatch.mobile.fog.room

import android.app.Application
import android.content.Context
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], manifest = Config.NONE, application = Application::class)
class FogLegacyQueueMigrationTest {
    private lateinit var context: Context
    private lateinit var database: FogDatabase

    @Before
    fun setUp() {
        context = ApplicationProvider.getApplicationContext()
        context.getSharedPreferences(FogDatabase.LEGACY_PREFS, Context.MODE_PRIVATE)
            .edit().clear().commit()
        database = Room.inMemoryDatabaseBuilder(context, FogDatabase::class.java)
            .allowMainThreadQueries()
            .build()
    }

    @After
    fun tearDown() {
        database.close()
        context.getSharedPreferences(FogDatabase.LEGACY_PREFS, Context.MODE_PRIVATE)
            .edit().clear().commit()
    }

    @Test
    fun `legacy queue migrates sos and cancel sharing event id without collision`() {
        val preferences = context.getSharedPreferences(FogDatabase.LEGACY_PREFS, Context.MODE_PRIVATE)
        preferences.edit().putString(
            FogDatabase.LEGACY_QUEUE,
            """[
              {"kind":"sos","key":"event-1","envelope":"{\"eventId\":\"event-1\"}","receivedAt":1000},
              {"kind":"sos-cancel","key":"sos-cancel:event-1","envelope":"{\"eventId\":\"event-1\",\"cancelled\":true}","receivedAt":2000}
            ]""".trimIndent(),
        ).commit()

        assertTrue(FogDatabase.migrateLegacyQueue(context, database))

        val dao = database.fogOutboxDao()
        assertEquals(2, dao.countPending(Long.MAX_VALUE))
        assertNotNull(dao.byKey("sos", "event-1"))
        assertNotNull(dao.byKey("sos-cancel", "event-1"))
        assertFalse(preferences.contains(FogDatabase.LEGACY_QUEUE))
    }

    @Test
    fun `malformed legacy queue is retained for recovery`() {
        val preferences = context.getSharedPreferences(FogDatabase.LEGACY_PREFS, Context.MODE_PRIVATE)
        preferences.edit().putString(FogDatabase.LEGACY_QUEUE, "not-json").commit()

        assertFalse(FogDatabase.migrateLegacyQueue(context, database))

        assertTrue(preferences.contains(FogDatabase.LEGACY_QUEUE))
        assertEquals(0, database.fogOutboxDao().countPending(Long.MAX_VALUE))
    }

    @Test
    fun `migration is idempotent when Room already contains the entry`() {
        val dao = database.fogOutboxDao()
        dao.insert(FogOutboxEntry(kind = "telemetry", entityId = "batch-1", payload = "{}"))
        val preferences = context.getSharedPreferences(FogDatabase.LEGACY_PREFS, Context.MODE_PRIVATE)
        preferences.edit().putString(
            FogDatabase.LEGACY_QUEUE,
            """[{"kind":"telemetry","key":"batch-1","envelope":"{}"}]""",
        ).commit()

        assertTrue(FogDatabase.migrateLegacyQueue(context, database))

        assertEquals(1, dao.countPending(Long.MAX_VALUE))
        assertFalse(preferences.contains(FogDatabase.LEGACY_QUEUE))
    }
}
