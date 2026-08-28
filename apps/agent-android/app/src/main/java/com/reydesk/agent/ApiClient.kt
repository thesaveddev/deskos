package com.reydesk.agent

import android.os.Build
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.util.concurrent.TimeUnit

/** Wire models for the agent-facing subset of the ReyDesk API. */
data class PendingSession(
    val id: String,
    val state: String,
    val type: String,
    val permissions: List<String>,
    val reason: String?,
)

data class ConsentResult(val sessionId: String, val joinToken: String?, val denied: Boolean)
data class IceResult(val urls: List<List<String>>, val username: String?, val credential: String?)
data class EnrolResult(val deviceId: String, val deviceName: String, val token: String, val heartbeatIntervalSec: Int)

/**
 * Thin synchronous OkHttp wrapper over the agent endpoints. Every call runs on
 * a Dispatchers.IO worker (see callers); no UI thread usage anywhere.
 */
class ApiClient(
    private val baseUrl: String,
    private val deviceToken: String?,
    clientBuilder: OkHttpClient.Builder = OkHttpClient.Builder(),
) {
    private val http = clientBuilder
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(20, TimeUnit.SECONDS)
        .build()

    private val json = "application/json; charset=utf-8".toMediaType()

    private fun bearer(): String = deviceToken ?: throw IOException("Device not enrolled")

    private fun post(path: String, body: JSONObject, authorized: Boolean): JSONObject {
        val builder = Request.Builder()
            .url(baseUrl.trimEnd('/') + path)
            .post(body.toString().toRequestBody(json))
        if (authorized) builder.header("Authorization", "Bearer $bearer()")
        http.newCall(builder.build()).execute().use { response ->
            val text = response.body?.string().orEmpty()
            if (!response.isSuccessful) throw IOException("HTTP ${response.code} from $path: ${text.take(200)}")
            return if (text.isBlank()) JSONObject() else JSONObject(text)
        }
    }

    fun get(path: String): JSONObject {
        val request = Request.Builder()
            .url(baseUrl.trimEnd('/') + path)
            .header("Authorization", "Bearer $bearer()")
            .get()
            .build()
        http.newCall(request).execute().use { response ->
            val text = response.body?.string().orEmpty()
            if (!response.isSuccessful) throw IOException("HTTP ${response.code} from $path: ${text.take(200)}")
            return if (text.isBlank()) JSONObject() else JSONObject(text)
        }
    }

    fun enrol(token: String, name: String): EnrolResult {
        val body = JSONObject()
            .put("token", token.trim())
            .put("name", name.ifBlank { Build.MODEL })
            .put("hostname", Build.MODEL)
            .put("os", "Android")
            .put("osVersion", Build.VERSION.RELEASE)
            .put("arch", System.getProperty("os.arch") ?: "aarch64")
            .put("deviceType", "mobile")
            .put("manufacturer", Build.MANUFACTURER)
            .put("model", Build.MODEL)
        val result = post("/api/v1/agent/enrol", body, authorized = false)
        val device = result.getJSONObject("device")
        return EnrolResult(
            deviceId = device.getString("id"),
            deviceName = device.optString("name", name),
            token = result.getString("deviceToken"),
            heartbeatIntervalSec = result.optInt("heartbeatIntervalSec", 30),
        )
    }

    fun heartbeat(batteryPct: Int?, powerSource: String?): Unit {
        val body = JSONObject()
        if (batteryPct != null) body.put("batteryPct", batteryPct)
        if (powerSource != null) body.put("powerSource", powerSource)
        post("/api/v1/agent/heartbeat", body, authorized = true)
    }

    /** Live sessions awaiting this endpoint's action (consent / reconnect). */
    fun pendingSessions(): List<PendingSession> {
        val payload = get("/api/v1/agent/sessions").optJSONArray("sessions") ?: JSONArray()
        return (0 until payload.length()).mapNotNull { index ->
            val row = payload.getJSONObject(index)
            val state = row.getString("state")
            // `reboot_reconnect`-style active rows are desktop concerns; only
            // sessions that can progress need consent handling on mobile.
            if (state !in setOf("requested", "consent_pending")) return@mapNotNull null
            val permissions = mutableListOf<String>()
            val rawPermissions = row.optJSONArray("permissions")
            if (rawPermissions != null) {
                for (i in 0 until rawPermissions.length()) permissions.add(rawPermissions.getString(i))
            }
            PendingSession(
                id = row.getString("id"),
                state = state,
                type = row.optString("type", "attended"),
                permissions = permissions,
                reason = row.optString("reason").takeIf { it.isNotBlank() && it != "null" },
            )
        }
    }

    fun consent(sessionId: String, granted: Boolean, permissions: List<String>): ConsentResult {
        val body = JSONObject().put("granted", granted)
        if (granted && permissions.isNotEmpty()) {
            body.put("permissions", JSONArray(permissions))
        }
        val result = post("/api/v1/agent/sessions/$sessionId/consent", body, authorized = true)
        val session = result.getJSONObject("session")
        val joinToken = result.optString("joinToken").takeIf { it.isNotBlank() && it != "null" }
        return ConsentResult(sessionId = session.getString("id"), joinToken = joinToken, denied = !granted)
    }

    fun iceServers(sessionId: String): List<JSONObject> {
        val servers = get("/api/v1/agent/sessions/$sessionId/ice").optJSONArray("iceServers") ?: JSONArray()
        return (0 until servers.length()).map { servers.getJSONObject(it) }
    }

    fun reportState(sessionId: String, state: String): Unit {
        post("/api/v1/agent/sessions/$sessionId/state", JSONObject().put("state", state), authorized = true)
    }

    /** Returns a fresh join token issued by the reconnect endpoint. */
    fun requestReconnect(sessionId: String): String? {
        val result = post("/api/v1/agent/sessions/$sessionId/reconnect", JSONObject(), authorized = true)
        return result.optString("joinToken").takeIf { it.isNotBlank() && it != "null" }
    }

    fun endSession(sessionId: String): Unit {
        post("/api/v1/agent/sessions/$sessionId/end", JSONObject(), authorized = true)
    }

    companion object {
        fun forContext(context: android.content.Context): ApiClient =
            ApiClient(AgentPrefs.apiBaseUrl(context), AgentPrefs.token(context))
    }
}
