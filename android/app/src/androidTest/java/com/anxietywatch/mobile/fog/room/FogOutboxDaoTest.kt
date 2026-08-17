package com.anxietywatch.mobile.fog.room

import android.content.Context
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class FogOutboxDaoTest {

    private lateinit var database: FogDatabase
    private lateinit var dao: FogOutboxDao

    @Before
    fun setUp() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        database = Room.inMemoryDatabaseBuilder(context, FogDatabase::class.java).build()
        dao = database.fogOutboxDao()
    }

    @After
    fun tearDown() {
        database.close()
    }

    @Test
    fun entryOnlyDisappearsAfterWatchConfirmation() {
        val now = System.currentTimeMillis()
        dao.insert(entry("telemetry", "batch-1", now))

        dao.completeOnlyIfWatchAcked("telemetry", "batch-1")
        assertNotNull("Cloud-only state must still be pending", dao.byKey("telemetry", "batch-1"))

        dao.markCloudAcked("telemetry", "batch-1", now)
        dao.completeOnlyIfWatchAcked("telemetry", "batch-1")
        assertNotNull("Must still be pending until watch ACK", dao.byKey("telemetry", "batch-1"))

        dao.markWatchAcked("telemetry", "batch-1", now)
        assertEquals(1, dao.completeOnlyIfWatchAcked("telemetry", "batch-1"))
        assertNull(dao.byKey("telemetry", "batch-1"))
    }

    @Test
    fun uniqueKeyIsKindAndEntityId() {
        val now = System.currentTimeMillis()
        dao.insert(entry("sos", "event-1", now))
        dao.insert(entry("sos", "event-1", now))
        dao.insert(entry("sos-cancel", "event-1", now))
        dao.insert(entry("telemetry", "event-1", now))

        assertEquals(3, dao.countPending(now))
        assertEquals(0, dao.byKey("sos", "event-1")!!.attempts)
        assertNotNull(dao.byKey("sos-cancel", "event-1"))
        assertNotNull(dao.byKey("telemetry", "event-1"))
    }

    @Test
    fun failedEntriesAreExcludedUntilNextAttempt() {
        val now = System.currentTimeMillis()
        dao.insert(entry("telemetry", "batch-1", now))

        dao.markFailed("telemetry", "batch-1", now + 60_000)
        val failed = dao.byKey("telemetry", "batch-1")
        assertNotNull(failed)
        assertEquals(FogOutboxEntry.STATE_FAILED, failed!!.state)
        assertEquals(1, failed.attempts)

        assertEquals(0, dao.countPending(now))
        assertEquals(1, dao.countPending(now + 60_001))
    }

    @Test
    fun ackThenCleanupRemovesOldConfirmedRows() {
        val now = System.currentTimeMillis()
        dao.insert(entry("telemetry", "old-batch", now - 8_000_000_000L))
        dao.markCloudAcked("telemetry", "old-batch", now - 8_000_000_000L)
        dao.markWatchAcked("telemetry", "old-batch", now - 8_000_000_000L)

        dao.cleanupAcked(now - 7L * 24 * 60 * 60 * 1000)

        assertNull(dao.byKey("telemetry", "old-batch"))
    }

    private fun entry(kind: String, entityId: String, receivedAt: Long) = FogOutboxEntry(
        kind = kind,
        entityId = entityId,
        payload = "{}",
        receivedAt = receivedAt,
    )
}
