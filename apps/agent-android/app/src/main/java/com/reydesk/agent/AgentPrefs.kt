package com.reydesk.agent

import android.content.Context
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey

/**
 * Persists the device identity produced by `POST /agent/enrol`. The bearer
 * token is scoped to one tenant + one device on the API side; losing it just
 * means re-enrolling.
 */
object AgentPrefs {
    private const val FILE = "reydesk_agent_secure"

    private fun prefs(context: Context) = EncryptedSharedPreferences.create(
        context,
        FILE,
        MasterKey.Builder(context).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build(),
        EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
        EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
    )

    fun apiBaseUrl(context: Context): String =
        prefs(context).getString("api_base_url", "https://reydesk.com")?.trimEnd('/') ?: "https://reydesk.com"

    fun setApiBaseUrl(context: Context, url: String) {
        prefs(context).edit().putString("api_base_url", url.trimEnd('/')).apply()
    }

    fun deviceId(context: Context): String? = prefs(context).getString("device_id", null)
    fun deviceName(context: Context): String? = prefs(context).getString("device_name", null)

    fun token(context: Context): String? = prefs(context).getString("device_token", null)

    fun saveIdentity(context: Context, apiBase: String, deviceId: String, deviceName: String, token: String) {
        setApiBaseUrl(context, apiBase)
        prefs(context).edit()
            .putString("device_id", deviceId)
            .putString("device_name", deviceName)
            .putString("device_token", token)
            .apply()
    }

    fun clearIdentity(context: Context) {
        prefs(context).edit().clear().apply()
    }

    fun isEnrolled(context: Context): Boolean = !token(context).isNullOrBlank()

    /** Token captured from the reydesk://enrol deep link before the user completes enrollment. */
    fun pendingToken(context: Context): String? = prefs(context).getString("pending_token", null)

    fun setPendingToken(context: Context, token: String) {
        prefs(context).edit().putString("pending_token", token).apply()
    }

    fun clearPendingToken(context: Context) {
        prefs(context).edit().remove("pending_token").apply()
    }
}
