package com.anxietywatch.mobile.fog

import android.content.Context
import com.anxietywatch.mobile.fog.room.FogDatabase
import com.anxietywatch.mobile.fog.room.FogOutboxDao
import com.anxietywatch.mobile.fog.room.FogOutboxEntry
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.time.Instant

object FogNativeSync {
    const val API_BASE = "https://api.mangoon.xyz"
    private const val BASE_BACKOFF_MS = 15_000L
    private const val MAX_BACKOFF_MS = 15 * 60_000L

    enum class Outcome { COMPLETE, PENDING, UNAUTHORIZED }

    fun interface HttpPost { fun post(url: String, body: String, token: String): Int }
    fun interface AckToWear { fun ack(route: String): Boolean }

    fun run(
        context: Context,
        token: String,
        identityJson: String,
        httpPost: HttpPost = HttpPost(::postJson),
        ackToWear: AckToWear = AckToWear { WearFogModule.sendAckToWear(context, it) },
        clockMillis: () -> Long = System::currentTimeMillis,
        dao: FogOutboxDao = FogDatabase.get(context).fogOutboxDao(),
    ): Outcome {
        val identity = runCatching { JSONObject(identityJson) }.getOrNull() ?: return Outcome.PENDING
        if (token.isBlank() || identity.optString("userId").isBlank()) return Outcome.PENDING
        val entries = dao.pending(clockMillis())
        for (entry in entries) {
            if (entry.kind !in setOf("telemetry", "sos", "sos-cancel")) {
                dao.delete(entry.kind, entry.entityId)
                continue
            }
            try {
                if (entry.state != FogOutboxEntry.STATE_CLOUD_ACKED) {
                    val request = requestFor(entry, identity)
                    if (request == null) {
                        fail(dao, entry, clockMillis())
                        continue
                    }
                    when (httpPost.post(API_BASE + request.first, request.second.toString(), token)) {
                        200, 202 -> dao.markCloudAcked(entry.kind, entry.entityId, clockMillis())
                        401, 403 -> return Outcome.UNAUTHORIZED
                        else -> {
                            fail(dao, entry, clockMillis())
                            continue
                        }
                    }
                }
                if (ackToWear.ack(ackRoute(entry))) {
                    dao.markWatchAcked(entry.kind, entry.entityId, clockMillis())
                    dao.completeOnlyIfWatchAcked(entry.kind, entry.entityId)
                } else {
                    fail(dao, entry, clockMillis())
                }
            } catch (_: Exception) {
                fail(dao, entry, clockMillis())
            }
        }
        return if (dao.countRemaining() > 0) Outcome.PENDING else Outcome.COMPLETE
    }

    internal fun requestFor(entry: FogOutboxEntry, identity: JSONObject): Pair<String, JSONObject>? {
        val envelope = runCatching { JSONObject(entry.payload) }.getOrNull() ?: return null
        return when {
            entry.kind == "telemetry" && envelope.optString("targetEndpoint") == "/fog/v1/telemetry" -> {
                val samples = JSONArray()
                val records = envelope.optJSONArray("records") ?: return null
                for (index in 0 until records.length()) {
                    sample(records.optJSONObject(index) ?: continue)?.let { samples.put(it) }
                }
                if (samples.length() == 0) return null
                "/api/v1/telemetry/batch" to JSONObject()
                    .put("batchId", envelope.optString("batchId"))
                    .put("deviceId", identity.optString("deviceId"))
                    .put("userId", identity.optString("userId"))
                    .put("sessionId", identity.optString("sessionId"))
                    .put("startedAt", iso(envelope.opt("startedAt")) ?: return null)
                    .put("endedAt", iso(envelope.opt("endedAt")) ?: return null)
                    .put("sequence", identity.optLong("sequence", 0L))
                    .put("samples", samples)
            }
            entry.kind == "sos" && envelope.optString("targetEndpoint") == "/fog/v1/sos" ->
                "/api/v1/sos/trigger" to JSONObject()
                    .put("eventId", envelope.optString("eventId"))
                    .put("userId", identity.optString("userId"))
                    .put("deviceId", identity.optString("deviceId"))
                    .put("triggeredAt", iso(envelope.opt("triggeredAt")) ?: return null)
                    .put("source", if (envelope.optString("source") == "MOBILE") "MOBILE" else "WATCH")
                    .also { putReason(it, envelope) }
            entry.kind == "sos-cancel" && envelope.optString("targetEndpoint") == "/fog/v1/sos/cancel" && envelope.optBoolean("cancelled") ->
                "/api/v1/sos/cancel" to JSONObject()
                    .put("eventId", envelope.optString("eventId"))
                    .put("userId", identity.optString("userId"))
                    .put("deviceId", identity.optString("deviceId"))
                    .put("cancelledAt", iso(envelope.opt("cancelledAt") ?: envelope.opt("triggeredAt")) ?: return null)
                    .also { putReason(it, envelope) }
            else -> null
        }
    }

    private fun sample(record: JSONObject): JSONObject? {
        val timestamp = iso(record.opt("capturedAt")) ?: return null
        val payload = record.optJSONObject("payload") ?: JSONObject()
        val quality = signalQuality(payload.opt("signalQuality").takeUnless { it == null || it == JSONObject.NULL } ?: payload.opt("quality"))
        val common = JSONObject().put("timestamp", timestamp).put("heartRateBpm", JSONObject.NULL)
            .put("ibiMs", JSONArray()).put("accelerometer", JSONObject.NULL)
            .put("skinTemperatureCelsius", JSONObject.NULL).put("ambientTemperatureCelsius", JSONObject.NULL)
            .put("quality", JSONObject().put("heartRate", "unknown").put("ibi", "unknown").put("wearingState", "unknown"))
        when (record.optString("type")) {
            "heart_rate" -> {
                if (payload.opt("bpm") is Number) common.put("heartRateBpm", payload.optDouble("bpm"))
                val ibi = payload.optJSONArray("ibiMillis") ?: JSONArray()
                val clean = JSONArray()
                for (i in 0 until minOf(ibi.length(), 16)) if (ibi.opt(i) is Number) clean.put(ibi.optDouble(i))
                common.put("ibiMs", clean)
                common.put("quality", JSONObject().put("heartRate", quality).put("ibi", quality).put("wearingState", "unknown"))
            }
            "motion" -> {
                val x = payload.opt("x"); val y = payload.opt("y"); val z = payload.opt("z")
                if (x is Number && y is Number && z is Number) common.put("accelerometer", JSONObject().put("x", x).put("y", y).put("z", z))
            }
            "skin_temperature" -> if (payload.opt("celsius") is Number) common.put("skinTemperatureCelsius", payload.optDouble("celsius"))
            else -> return null
        }
        return common
    }

    private fun signalQuality(value: Any?): String = when (value) {
        is Number -> when { value.toDouble() >= .8 -> "good"; value.toDouble() >= .5 -> "fair"; else -> "poor" }
        is String -> value.takeIf { it in setOf("good", "fair", "poor", "unknown") } ?: "unknown"
        else -> "unknown"
    }

    private fun iso(value: Any?): String? = runCatching {
        when (value) {
            is Number -> Instant.ofEpochMilli(value.toLong()).toString()
            is String -> Instant.parse(value).toString()
            else -> null
        }
    }.getOrNull()

    private fun putReason(target: JSONObject, source: JSONObject) {
        source.optString("reason").takeIf(String::isNotBlank)?.let { target.put("reason", it) }
    }

    private fun ackRoute(entry: FogOutboxEntry) = when (entry.kind) {
        "telemetry" -> WearFogListenerService.ACK_TELEMETRY_PREFIX
        "sos" -> WearFogListenerService.ACK_SOS_PREFIX
        else -> WearFogListenerService.ACK_SOS_CANCEL_PREFIX
    } + entry.entityId

    private fun fail(dao: FogOutboxDao, entry: FogOutboxEntry, now: Long) {
        val attempts = dao.byKey(entry.kind, entry.entityId)?.attempts ?: entry.attempts
        val backoff = minOf(BASE_BACKOFF_MS * (1L shl attempts.coerceAtMost(5)), MAX_BACKOFF_MS)
        dao.markFailed(entry.kind, entry.entityId, now + backoff)
    }

    private fun postJson(url: String, body: String, token: String): Int {
        val connection = URL(url).openConnection() as HttpURLConnection
        return try {
            connection.requestMethod = "POST"
            connection.connectTimeout = 10_000
            connection.readTimeout = 15_000
            connection.doOutput = true
            connection.setRequestProperty("Content-Type", "application/json")
            connection.setRequestProperty("Authorization", "Bearer $token")
            connection.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
            connection.responseCode
        } finally { connection.disconnect() }
    }
}
