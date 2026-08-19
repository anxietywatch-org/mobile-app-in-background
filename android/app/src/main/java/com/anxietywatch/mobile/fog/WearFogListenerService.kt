package com.anxietywatch.mobile.fog

import android.content.Context
import com.google.android.gms.tasks.Tasks
import com.google.android.gms.wearable.DataEvent
import com.google.android.gms.wearable.DataEventBuffer
import com.google.android.gms.wearable.DataItem
import com.google.android.gms.wearable.DataMapItem
import com.google.android.gms.wearable.MessageEvent
import com.google.android.gms.wearable.Wearable
import com.google.android.gms.wearable.WearableListenerService
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch

/**
 * Punto de entrada del reloj hacia el nodo fog del teléfono.
 *
 * Recibe los sobres que el reloj envía por Wear Data Layer rutas `/fog/v1/` por
 * identificador:
 *  - DataItems en `/fog/v1/telemetry/{batchId}` (telemetría en lote)
 *  - mensajes en `/fog/v1/sos/{eventId}`, `/fog/v1/sos/cancel/{eventId}`
 *  - mensajes en `/fog/v1/events/suspected/{eventId}` y `/fog/v1/capabilities`
 *
 * Cada sobre se entrega a JavaScript para enriquecerlo y enviarlo al API (nodo fog,
 * protocolo `fog_phone_v1`). El reloj reintenta mientras no reciba el ACK por
 * identificador (`/fog/v1/ack/...`), así que entregar un sobre más de una vez es
 * seguro (idempotencia).
 *
 * Seguridad: solo se encolan sobres cuyo nodo origen (`sourceNodeId` en mensajes,
 * `uri.host` en DataItems) esté en la lista de nodos conectados del Wear Data Layer.
 * Los id de nodo los asigna Google Play Services y ninguna app de terceros puede
 * fabricarlos, así que esto bloquea inyección de sobres falsos desde fuera del par
 * reloj↔teléfono. Los identificadores de lote/evento deben ser UUIDs (contrato del
 * API de producción).
 */
class WearFogListenerService : WearableListenerService() {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    override fun onDataChanged(dataEvents: DataEventBuffer) {
        for (event in dataEvents) {
            if (event.type != DataEvent.TYPE_CHANGED) continue
            val item: DataItem = event.dataItem
            val path = item.uri.path ?: continue
            val batchId = path.destructure(BATCH_PREFIX)?.takeIf { it.isUuid() } ?: continue
            val payloadBytes = DataMapItem.fromDataItem(item).dataMap.getByteArray(PAYLOAD_KEY)
                ?: (item.data.takeIf { it != null && it.isNotEmpty() })
                ?: continue
            scope.launch {
                if (!isTrustedSource(item.uri.host)) return@launch
                FogBridge.enqueueInbound(
                    this@WearFogListenerService,
                    TELEMETRY_KIND,
                    batchId,
                    String(payloadBytes, Charsets.UTF_8),
                )
                FogSyncScheduler.schedule(this@WearFogListenerService)
            }
        }
    }

    override fun onMessageReceived(messageEvent: MessageEvent) {
        val path = messageEvent.path ?: return
        val raw = String(messageEvent.data, Charsets.UTF_8)
        scope.launch {
            if (!isTrustedSource(messageEvent.sourceNodeId)) return@launch
            when {
                path.startsWith(SOS_CANCEL_PREFIX) -> {
                    val eventId = path.destructure(SOS_CANCEL_PREFIX)?.takeIf { it.isUuid() }
                        ?: return@launch
                    FogBridge.enqueueInbound(this@WearFogListenerService, SOS_CANCEL_KIND, eventId, raw)
                    FogSyncScheduler.schedule(this@WearFogListenerService)
                }
                path.startsWith(SOS_PREFIX) -> {
                    val eventId = path.destructure(SOS_PREFIX)?.takeIf { it.isUuid() }
                        ?: return@launch
                    FogBridge.enqueueInbound(this@WearFogListenerService, SOS_KIND, eventId, raw)
                    FogSyncScheduler.schedule(this@WearFogListenerService)
                }
                path.startsWith(SUSPECTED_PREFIX) -> {
                    val eventId = path.destructure(SUSPECTED_PREFIX)?.takeIf { it.isUuid() }
                        ?: return@launch
                    FogBridge.enqueueInbound(this@WearFogListenerService, SUSPECTED_KIND, eventId, raw)
                    FogSyncScheduler.schedule(this@WearFogListenerService)
                }
                path == CAPABILITIES_ENDPOINT -> {
                    FogBridge.enqueueInbound(this@WearFogListenerService, CAPABILITIES_KIND, CapabilitiesKey, raw)
                    FogSyncScheduler.schedule(this@WearFogListenerService)
                }
            }
        }
    }

    /**
     * Verifica que el sobre provenga de un nodo Wear conectado. Se ejecuta en
     * [Dispatchers.IO] (Tasks.await bloquea y los callbacks del listener corren
     * en el hilo principal).
     */
    private suspend fun isTrustedSource(sourceNodeId: String?): Boolean {
        if (sourceNodeId.isNullOrBlank()) return false
        return runCatching {
            Tasks.await(Wearable.getNodeClient(this).connectedNodes)
                .any { it.id == sourceNodeId }
        }.getOrDefault(false)
    }

    /**
     * Extrae el identificador que sigue al prefijo, o null si la ruta no
     * matchea el prefijo o el identificador queda vacío. Así, DataItems de
     * otras rutas (p. ej. el anuncio de capabilities del reloj en
     * `/fog/v1/capabilities`) no se encolan como telemetría.
     */
    private fun String.destructure(prefix: String): String? {
        if (!startsWith(prefix)) return null
        val id = substring(prefix.length).removePrefix("/")
        return id.takeIf { it.isNotEmpty() }
    }

    private fun String.isUuid(): Boolean = UUID_PATTERN.matches(this)

    companion object {
        const val FOG_PHONE_PROTOCOL = "fog_phone_v1"
        const val BATCH_PREFIX = "/fog/v1/telemetry/"
        const val SOS_PREFIX = "/fog/v1/sos/"
        const val SOS_CANCEL_PREFIX = "/fog/v1/sos/cancel/"
        const val SUSPECTED_PREFIX = "/fog/v1/events/suspected/"
        const val CAPABILITIES_ENDPOINT = "/fog/v1/capabilities"
        const val ACK_TELEMETRY_PREFIX = "/fog/v1/ack/telemetry/"
        const val ACK_SOS_PREFIX = "/fog/v1/ack/sos/"
        const val ACK_SOS_CANCEL_PREFIX = "/fog/v1/ack/sos-cancel/"
        const val CapabilitiesKey = "capabilities"

        const val TELEMETRY_KIND = "telemetry"
        const val SOS_KIND = "sos"
        const val SOS_CANCEL_KIND = "sos-cancel"
        const val SUSPECTED_KIND = "suspected"
        const val CAPABILITIES_KIND = "capabilities"
        const val PAYLOAD_KEY = "payload"

        private val UUID_PATTERN =
            Regex("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")

        fun isListenerRunning(context: Context): Boolean =
            FogBridge.isAppHosted(context)
    }
}