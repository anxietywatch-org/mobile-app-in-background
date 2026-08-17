package com.anxietywatch.mobile.fog

import android.content.Context
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

class FogBackgroundWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result = withContext(Dispatchers.IO) {
        val store = FogSecureStore(applicationContext)
        val token = store.getToken()
        val identity = store.getIdentity()
        if (token.isNullOrBlank() || org.json.JSONObject(identity).optString("userId").isBlank()) return@withContext Result.success()
        when (FogNativeSync.run(applicationContext, token, identity)) {
            FogNativeSync.Outcome.UNAUTHORIZED -> { store.clearAuth(); Result.success() }
            FogNativeSync.Outcome.PENDING -> { FogSyncScheduler.schedule(applicationContext, 15 * 60_000L); Result.success() }
            FogNativeSync.Outcome.COMPLETE -> Result.success()
        }
    }
}
