package com.anxietywatch.mobile.fog

import android.content.Context
import android.content.SharedPreferences
import androidx.test.core.app.ApplicationProvider
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], manifest = Config.NONE, application = android.app.Application::class)
class FogSecureStoreTest {
    private lateinit var context: Context
    private lateinit var prefs: SharedPreferences

    @Before fun setUp() {
        context = ApplicationProvider.getApplicationContext()
        prefs = context.getSharedPreferences("fog_secure_v1", 0)
        prefs.edit().clear().commit()
        context.getSharedPreferences("fog_identity", 0).edit().clear().commit()
    }

    private fun store(): FogSecureStore = FogSecureStore(context, prefs)

    @Test fun absentValuesReturnNull() {
        val store = store()
        assertNull(store.getToken())
        assertNull(store.getAuth())
        assertEquals("", JSONObject(store.getIdentity()).getString("userId"))
    }

    @Test fun tokenRoundTripAndClear() {
        val store = store()
        store.setToken("jwt")
        assertEquals("jwt", store.getToken())
        store.clearAuth()
        assertNull(store.getToken())
    }

    @Test fun authRoundTripSyncsToken() {
        val store = store()
        store.setAuth("""{"token":"auth-token"}""")
        assertEquals("auth-token", store.getToken())
        assertEquals("""{"token":"auth-token"}""", store.getAuth())
    }

    @Test fun identityRoundTripAndSequence() {
        val store = store()
        store.setIdentity("user", "device", "session")
        assertEquals(1L, store.nextSequence())
        val value = JSONObject(store.getIdentity())
        assertEquals("user", value.getString("userId"))
        assertEquals("device", value.getString("deviceId"))
        assertEquals("session", value.getString("sessionId"))
        assertEquals(1L, value.getLong("sequence"))
        assertEquals(2L, store.nextSequence())
    }

    @Test fun clearAuthDropsTokenOnly() {
        val store = store()
        store.setToken("jwt")
        store.setIdentity("user", "device", "session")
        store.clearAuth()
        assertNull(store.getToken())
        assertEquals("user", JSONObject(store.getIdentity()).getString("userId"))
    }

    @Test fun migratesLegacyIdentity() {
        context.getSharedPreferences("fog_identity", 0).edit()
            .putString("userId", "legacy-user")
            .putString("deviceId", "legacy-device")
            .putString("sessionId", "legacy-session")
            .putLong("sequence", 4L)
            .commit()

        val value = JSONObject(store().getIdentity())
        assertEquals("legacy-user", value.getString("userId"))
        assertEquals("legacy-device", value.getString("deviceId"))
        assertEquals("legacy-session", value.getString("sessionId"))
        assertEquals(4L, value.getLong("sequence"))
        assertTrue(context.getSharedPreferences("fog_identity", 0).all.isEmpty())
    }
}
