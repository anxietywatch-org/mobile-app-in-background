package com.anxietywatch.mobile.fog

import android.content.Context
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.bridge.WritableMap
import com.facebook.react.bridge.Arguments
import com.facebook.react.modules.core.DeviceEventManagerModule
import com.google.android.gms.tasks.Tasks
import com.google.android.gms.wearable.Node
import com.google.android.gms.wearable.Wearable
import org.json.JSONObject

/**
 * API de JavaScript para el nodo fog.
 *
 *  - `peek()`: recoge los sobres pendientes del reloj.
 *  - `complete()`: elimina un sobre de la cola tras entregarlo.
 *  - `ackTelemetry()` / `ackSos()` / `ackSosCancel()`: confirman entrega al reloj
 *    por identificador (`/fog/v1/ack/telemetry/{id}`, ...).
 *  - `announceFogPhone()`: anuncia al reloj el protocolo fog del teléfono.
 *  - `getIdentity()` / `setIdentity()` / `nextSequence()`: identidad fog persistente.
 */
class WearFogModule(private val reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    private val secureStore by lazy { FogSecureStore(reactContext) }

    override fun getName(): String = "WearFog"

    init {
        FogBridge.setEmitListener { envelope ->
            try {
                val params: WritableMap = Arguments.createMap().apply {
                    putString("envelope", envelope)
                }
                reactContext
                    .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                    .emit("FogInbound", params)
            } catch (_: Exception) {
            }
        }
    }

    @ReactMethod
    fun peek(promise: Promise) {
        promise.resolve(FogBridge.peekInbound(reactContext))
    }

    @ReactMethod
    fun complete(key: String, promise: Promise) {
        val deleted = FogBridge.completeInbound(reactContext, key)
        promise.resolve(deleted)
    }

    @ReactMethod
    fun markCloudAcked(key: String, promise: Promise) {
        FogBridge.markCloudAcked(reactContext, key)
        promise.resolve(true)
    }

    @ReactMethod
    fun markWatchAcked(key: String, promise: Promise) {
        FogBridge.markWatchAcked(reactContext, key)
        promise.resolve(true)
    }

    @ReactMethod
    fun markFailed(key: String, promise: Promise) {
        FogBridge.markFailed(reactContext, key)
        promise.resolve(true)
    }

    @ReactMethod
    fun inboundCount(promise: Promise) {
        promise.resolve(FogBridge.inboundCount(reactContext).toDouble())
    }

    @ReactMethod
    fun getIdentity(promise: Promise) {
        promise.resolve(secureStore.getIdentity())
    }

    @ReactMethod
    fun setIdentity(identity: ReadableMap, promise: Promise) {
        secureStore.setIdentity(
            identity.getString("userId"),
            identity.getString("deviceId"),
            identity.getString("sessionId"),
        )
        promise.resolve(true)
    }

    @ReactMethod
    fun nextSequence(promise: Promise) {
        promise.resolve(secureStore.nextSequence().toDouble())
    }

    @ReactMethod
    fun getAuth(promise: Promise) {
        promise.resolve(secureStore.getAuth() ?: "")
    }

    @ReactMethod
    fun setAuth(authJson: String, promise: Promise) {
        secureStore.setAuth(authJson)
        promise.resolve(true)
    }

    @ReactMethod
    fun clearAuth(promise: Promise) {
        secureStore.clearAuth()
        promise.resolve(true)
    }

    @ReactMethod
    fun getToken(promise: Promise) = promise.resolve(secureStore.getToken() ?: "")

    @ReactMethod
    fun setToken(token: String, promise: Promise) {
        secureStore.setToken(token)
        promise.resolve(true)
    }

    @ReactMethod
    fun scheduleSync(delayMs: Double, promise: Promise) {
        FogSyncScheduler.schedule(reactContext, delayMs.toLong())
        promise.resolve(true)
    }

    // Requeridos por NativeEventEmitter para contabilizar suscripciones.
    @ReactMethod
    fun addListener(eventName: String) = Unit

    @ReactMethod
    fun removeListeners(count: Int) = Unit

    @ReactMethod
    fun ackTelemetry(batchId: String, promise: Promise) {
        sendAckToWear(reactContext, WearFogListenerService.ACK_TELEMETRY_PREFIX + batchId, promise)
    }

    @ReactMethod
    fun ackSos(eventId: String, promise: Promise) {
        sendAckToWear(reactContext, WearFogListenerService.ACK_SOS_PREFIX + eventId, promise)
    }

    @ReactMethod
    fun ackSosCancel(eventId: String, promise: Promise) {
        sendAckToWear(reactContext, WearFogListenerService.ACK_SOS_CANCEL_PREFIX + eventId, promise)
    }

    @ReactMethod
    fun announceFogPhone(promise: Promise) {
        val payload = JSONObject()
            .put("schemaVersion", "fog-capabilities-v1")
            .put("targetEndpoint", "/fog/v1/capabilities")
            .put("transport", "WEAR_DATA_LAYER")
            .put("fogProtocol", WearFogListenerService.FOG_PHONE_PROTOCOL)
            .put("deviceModel", android.os.Build.MODEL)
            .toString()
            .toByteArray(Charsets.UTF_8)
        sendMessageToWear(reactContext, "/fog/v1/capabilities", payload)
        promise.resolve(true)
    }

    companion object {
        /**
         * Confirma entrega al reloj esperando el resultado real del envío.
         * Resuelve `true` solo si al menos un nodo recibió el mensaje ACK.
         */
        fun sendAckToWear(context: ReactApplicationContext, route: String, promise: Promise) {
            val messageClient = Wearable.getMessageClient(context)
            val nodeClient = Wearable.getNodeClient(context)
            nodeClient.connectedNodes.addOnCompleteListener { nodesTask ->
                val nodes: List<Node> = nodesTask.result ?: emptyList()
                if (nodes.isEmpty()) {
                    promise.resolve(false)
                    return@addOnCompleteListener
                }
                val sends = nodes.map { node ->
                    messageClient.sendMessage(node.id, route, ByteArray(0))
                }
                Tasks.whenAllComplete(ArrayList(sends)).addOnCompleteListener { task ->
                    val delivered = task.result?.any { it.isSuccessful } == true
                    promise.resolve(delivered)
                }
            }
        }

        fun sendAckToWear(context: Context, route: String): Boolean = runCatching {
            val nodes = Tasks.await(Wearable.getNodeClient(context).connectedNodes)
            nodes.any { node ->
                runCatching { Tasks.await(Wearable.getMessageClient(context).sendMessage(node.id, route, ByteArray(0))) }.isSuccess
            }
        }.getOrDefault(false)

        private fun sendMessageToWear(context: ReactApplicationContext, route: String, payload: ByteArray) {
            val messageClient = Wearable.getMessageClient(context)
            val nodeClient = Wearable.getNodeClient(context)
            nodeClient.connectedNodes.addOnCompleteListener { task ->
                for (node: Node in task.result ?: emptyList()) {
                    messageClient.sendMessage(node.id, route, payload)
                }
            }
        }
    }
}
