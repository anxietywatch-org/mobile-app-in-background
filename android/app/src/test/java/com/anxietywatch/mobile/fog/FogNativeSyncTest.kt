package com.anxietywatch.mobile.fog

import android.content.Context
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import com.anxietywatch.mobile.fog.room.FogDatabase
import com.anxietywatch.mobile.fog.room.FogOutboxDao
import com.anxietywatch.mobile.fog.room.FogOutboxEntry
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], manifest = Config.NONE, application = android.app.Application::class)
class FogNativeSyncTest {
    private lateinit var context: Context
    private lateinit var database: FogDatabase
    private lateinit var dao: FogOutboxDao

    private val identity = JSONObject().put("userId", "user-1").put("deviceId", "device-1")
        .put("sessionId", "session-1").put("sequence", 7)

    @Before fun setUp() {
        context = ApplicationProvider.getApplicationContext()
        database = Room.inMemoryDatabaseBuilder(context, FogDatabase::class.java)
            .allowMainThreadQueries()
            .build()
        dao = database.fogOutboxDao()
    }

    @After fun tearDown() {
        database.close()
    }

    @Test fun enrichesKnownTelemetryAndDropsUnknownRecords() {
        val envelope = JSONObject().put("targetEndpoint", "/fog/v1/telemetry").put("batchId", "batch-1")
            .put("startedAt", "2026-08-13T10:00:00Z").put("endedAt", "2026-08-13T10:01:00Z")
            .put("records", org.json.JSONArray()
                .put(record("heart_rate", JSONObject().put("bpm", 72).put("ibiMillis", org.json.JSONArray().put(830)).put("quality", .9)))
                .put(record("motion", JSONObject().put("x", 1).put("y", 2).put("z", 3)))
                .put(record("skin_temperature", JSONObject().put("celsius", 36.4)))
                .put(record("steps", JSONObject().put("count", 10))))
        val request = FogNativeSync.requestFor(entry("telemetry", envelope), identity)
        assertNotNull(request)
        assertEquals("/api/v1/telemetry/batch", request!!.first)
        val samples = request.second.getJSONArray("samples")
        assertEquals(3, samples.length())
        assertEquals(72.0, samples.getJSONObject(0).getDouble("heartRateBpm"), 0.0)
        assertEquals(1, samples.getJSONObject(1).getJSONObject("accelerometer").getInt("x"))
        assertEquals(36.4, samples.getJSONObject(2).getDouble("skinTemperatureCelsius"), 0.0)
    }

    @Test fun poisonEnvelopeIsRejected() {
        assertNull(FogNativeSync.requestFor(FogOutboxEntry(kind = "telemetry", entityId = "x", payload = "{"), identity))
    }

    @Test fun cancellationUsesCloudContract() {
        val envelope = JSONObject().put("targetEndpoint", "/fog/v1/sos/cancel")
            .put("eventId", "event-1").put("cancelled", true).put("cancelledAt", "2026-08-13T10:00:00Z")
        val request = FogNativeSync.requestFor(entry("sos-cancel", envelope), identity)!!
        assertEquals("/api/v1/sos/cancel", request.first)
        assertEquals("user-1", request.second.getString("userId"))
    }

    @Test fun sosAndCancelShareEventIdWithoutCollision() {
        val sos = FogOutboxEntry(kind = "sos", entityId = "event-1", payload = JSONObject()
            .put("targetEndpoint", "/fog/v1/sos").put("eventId", "event-1")
            .put("triggeredAt", "2026-08-13T10:00:00Z").toString())
        val cancel = FogOutboxEntry(kind = "sos-cancel", entityId = "event-1", payload = JSONObject()
            .put("targetEndpoint", "/fog/v1/sos/cancel").put("eventId", "event-1")
            .put("cancelled", true).put("cancelledAt", "2026-08-13T10:01:00Z").toString())
        dao.insert(sos)
        dao.insert(cancel)
        assertEquals(2, dao.countPending(Long.MAX_VALUE))
        assertNotNull(dao.byKey("sos", "event-1"))
        assertNotNull(dao.byKey("sos-cancel", "event-1"))
    }

    @Test fun runCompletesAfterCloudAndWatchAck() {
        val envelope = telemetryEnvelope()
        dao.insert(entry("telemetry", envelope))
        val httpPost = FogNativeSync.HttpPost { _, _, _ -> 202 }
        var ackedRoute = ""
        val outcome = FogNativeSync.run(
            context, "token", identity.toString(),
            httpPost = httpPost,
            ackToWear = FogNativeSync.AckToWear { route -> ackedRoute = route; true },
            dao = dao,
        )
        assertEquals(FogNativeSync.Outcome.COMPLETE, outcome)
        assertTrue(ackedRoute.endsWith("id-1"))
        assertEquals(0, dao.countRemaining())
        assertNull(dao.byKey("telemetry", "id-1"))
    }

    @Test fun duplicate200UsesSameCloudAckPath() {
        dao.insert(entry("telemetry", telemetryEnvelope()))
        val posts = java.util.concurrent.atomic.AtomicInteger()
        val outcome = FogNativeSync.run(
            context, "token", identity.toString(),
            httpPost = FogNativeSync.HttpPost { _, _, _ -> posts.incrementAndGet(); 200 },
            ackToWear = FogNativeSync.AckToWear { true },
            dao = dao,
        )
        assertEquals(FogNativeSync.Outcome.COMPLETE, outcome)
        assertEquals(1, posts.get())
        assertEquals(0, dao.countRemaining())
    }

    @Test fun watchAckFailureKeepsRowPending() {
        dao.insert(entry("telemetry", telemetryEnvelope()))
        val outcome = FogNativeSync.run(
            context, "token", identity.toString(),
            httpPost = FogNativeSync.HttpPost { _, _, _ -> 202 },
            ackToWear = FogNativeSync.AckToWear { false },
            dao = dao,
        )
        assertEquals(FogNativeSync.Outcome.PENDING, outcome)
        assertNotNull(dao.byKey("telemetry", "id-1"))
    }

    @Test fun networkErrorMarksFailedAndContinues() {
        dao.insert(entry("telemetry", telemetryEnvelope()))
        dao.insert(FogOutboxEntry(kind = "sos", entityId = "evt-1", payload = JSONObject()
            .put("targetEndpoint", "/fog/v1/sos").put("eventId", "evt-1")
            .put("triggeredAt", "2026-08-13T10:00:00Z").toString()))
        val now = 1_000_000L
        val httpPost = FogNativeSync.HttpPost { _, _, _ -> throw java.io.IOException("offline") }
        val outcome = FogNativeSync.run(
            context, "token", identity.toString(),
            httpPost = httpPost,
            ackToWear = FogNativeSync.AckToWear { true },
            clockMillis = { now },
            dao = dao,
        )
        assertEquals(FogNativeSync.Outcome.PENDING, outcome)
        val telemetry = dao.byKey("telemetry", "id-1")!!
        assertEquals(FogOutboxEntry.STATE_FAILED, telemetry.state)
        assertEquals(1, telemetry.attempts)
        assertTrue(telemetry.nextAttemptAt > now)
        val sos = dao.byKey("sos", "evt-1")!!
        assertEquals(FogOutboxEntry.STATE_FAILED, sos.state)
        assertEquals(1, sos.attempts)
    }

    @Test fun unauthorizedReturnsAndClearsNothing() {
        dao.insert(entry("telemetry", telemetryEnvelope()))
        val outcome = FogNativeSync.run(
            context, "token", identity.toString(),
            httpPost = FogNativeSync.HttpPost { _, _, _ -> 401 },
            ackToWear = FogNativeSync.AckToWear { true },
            dao = dao,
        )
        assertEquals(FogNativeSync.Outcome.UNAUTHORIZED, outcome)
        val row = dao.byKey("telemetry", "id-1")!!
        assertEquals(FogOutboxEntry.STATE_PENDING, row.state)
        assertEquals(0, row.attempts)
    }

    @Test fun cloudAckedRowRetriesOnlyWatchAck() {
        dao.insert(FogOutboxEntry(
            kind = "telemetry", entityId = "id-1", payload = telemetryEnvelope().toString(),
            state = FogOutboxEntry.STATE_CLOUD_ACKED,
        ))
        val posts = java.util.concurrent.atomic.AtomicInteger()
        val outcome = FogNativeSync.run(
            context, "token", identity.toString(),
            httpPost = FogNativeSync.HttpPost { _, _, _ -> posts.incrementAndGet(); 202 },
            ackToWear = FogNativeSync.AckToWear { true },
            dao = dao,
        )
        assertEquals(FogNativeSync.Outcome.COMPLETE, outcome)
        assertEquals(0, posts.get())
        assertEquals(0, dao.countRemaining())
    }

    @Test fun nonDeliverableKindsAreDiscarded() {
        dao.insert(FogOutboxEntry(kind = "capabilities", entityId = "capabilities", payload = "{}"))
        dao.insert(FogOutboxEntry(kind = "suspected", entityId = "evt-1", payload = "{}"))
        val posts = java.util.concurrent.atomic.AtomicInteger()
        val outcome = FogNativeSync.run(
            context, "token", identity.toString(),
            httpPost = FogNativeSync.HttpPost { _, _, _ -> posts.incrementAndGet(); 202 },
            ackToWear = FogNativeSync.AckToWear { true },
            dao = dao,
        )
        assertEquals(FogNativeSync.Outcome.COMPLETE, outcome)
        assertEquals(0, posts.get())
        assertEquals(0, dao.countRemaining())
    }

    @Test fun poisonEnvelopeFailsWithoutAck() {
        dao.insert(FogOutboxEntry(kind = "telemetry", entityId = "poison", payload = "{"))
        val ackCalls = java.util.concurrent.atomic.AtomicInteger()
        val outcome = FogNativeSync.run(
            context, "token", identity.toString(),
            httpPost = FogNativeSync.HttpPost { _, _, _ -> 202 },
            ackToWear = FogNativeSync.AckToWear { ackCalls.incrementAndGet(); true },
            dao = dao,
        )
        assertEquals(FogNativeSync.Outcome.PENDING, outcome)
        assertEquals(0, ackCalls.get())
        val row = dao.byKey("telemetry", "poison")!!
        assertEquals(FogOutboxEntry.STATE_FAILED, row.state)
    }

    private fun telemetryEnvelope() = JSONObject().put("targetEndpoint", "/fog/v1/telemetry").put("batchId", "batch-1")
        .put("startedAt", "2026-08-13T10:00:00Z").put("endedAt", "2026-08-13T10:01:00Z")
        .put("records", org.json.JSONArray().put(record("heart_rate", JSONObject().put("bpm", 72))))

    private fun record(type: String, payload: JSONObject) = JSONObject()
        .put("type", type).put("capturedAt", "2026-08-13T10:00:00Z").put("payload", payload)
    private fun entry(kind: String, envelope: JSONObject) =
        FogOutboxEntry(kind = kind, entityId = "id-1", payload = envelope.toString())
}
