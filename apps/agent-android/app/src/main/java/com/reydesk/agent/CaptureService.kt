package com.reydesk.agent

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import org.json.JSONObject

/**
 * The live session service. Runs as a mediaProjection foreground service for
 * the duration of a remote session:
 *
 *   1. publishes the screen via [WebRtcCore] (ScreenCapturerAndroid)
 *   2. answers the technician's SDP offer through the relay ([RelayClient])
 *   3. routes `input` data-channel messages into the accessibility gesture
 *      bridge / IME bridge, and replies to console `control` requests
 *   4. keeps the device heartbeat + session state reporting going
 */
class CaptureService : Service() {

    companion object {
        const val EXTRA_SESSION_ID = "sessionId"
        const val EXTRA_JOIN_TOKEN = "joinToken"
        const val EXTRA_PERMISSIONS = "permissions"
        const val EXTRA_PROJECTION = "projection"

        private const val CHANNEL_ID = "reydesk_support"
        private const val NOTIFICATION_ID = 42
    }

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    private lateinit var api: ApiClient
    private lateinit var relay: RelayClient
    private var core: WebRtcCore? = null

    private var sessionId: String = ""
    private var joinToken: String = ""

    /** Console coordinates are normalized (0..1); multiply by these pixels. */
    private var screenW = 1080
    private var screenH = 2400

    private var pointerPressed = false

    // Kept across reconnects so the capture pipeline can be rebuilt without a
    // second consent prompt — the projection grant stays valid for the session.
    @Volatile
    private var projectionIntent: Intent? = null
    private var lastIceServers: List<JSONObject> = emptyList()

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == "${packageName}.STOP") {
            endAndStop()
            return START_NOT_STICKY
        }
        val sessionIdExtra = intent?.getStringExtra(EXTRA_SESSION_ID).orEmpty()
        if (sessionIdExtra.isBlank()) {
            stopSelf()
            return START_NOT_STICKY
        }
        sessionId = sessionIdExtra
        joinToken = intent.getStringExtra(EXTRA_JOIN_TOKEN).orEmpty()
        val projectionData = intent.getParcelableExtra<Intent>(EXTRA_PROJECTION)
        projectionIntent = projectionData

        if (projectionData == null || joinToken.isBlank()) {
            stopSelf()
            return START_NOT_STICKY
        }

        api = ApiClient.forContext(this)
        relay = RelayClient(relayUrl(AgentPrefs.apiBaseUrl(this)))
        ensureNotificationChannel()
        startForeground(NOTIFICATION_ID, buildNotification("Connecting…"))

        scope.launch {
            if (!rebuildCore()) {
                delay(1500)
                stopSelf()
            }
        }
        relay.connect(sessionId, joinToken, relayListener())
        scope.launch { heartbeatLoop() }

        return START_NOT_STICKY
    }

    /**
     * Create (or recreate after a dead peer) the WebRTC + capture pipeline.
     * Uses the stored projection grant and cached ICE servers; returns false
     * only when there is nothing usable to publish.
     */
    private suspend fun rebuildCore(): Boolean {
        val projection = projectionIntent ?: run {
            updateNotification("Missing screen-capture permission")
            return false
        }
        try {
            if (lastIceServers.isEmpty()) {
                lastIceServers = runCatching { api.iceServers(sessionId) }.getOrDefault(emptyList())
            }
            val w = WebRtcCore(applicationContext, relay, coreListener)
                .also { it.rememberIceServers(lastIceServers) }
            core = w
            w.dataListener = ::onDataMessage
            w.createPeer(lastIceServers, projection)
            screenW = w.displaySize().first
            screenH = w.displaySize().second
            return true
        } catch (error: Exception) {
            updateNotification("Capture failed: ${error.message?.take(80)}")
            return false
        }
    }

    private fun relayListener(): RelayClient.Listener = object : RelayClient.Listener {
        override fun onJoined() {
            updateNotification("Session active — technician connected")
            scope.launch { runCatching { api.reportState(sessionId, "active") } }
        }

        override fun onOffer(sdp: String) {
            scope.launch(Dispatchers.Default) {
                if (core == null && !rebuildCore()) return@launch
                core?.handleOffer(sdp)
            }
        }

        override fun onIceCandidate(candidate: JSONObject) {
            core?.addRemoteCandidate(candidate)
        }

        override fun onSessionEnd() {
            endAndStop()
        }

        override fun onOther(type: String, message: JSONObject) {
            when (type) {
                "chat" -> Unit // chat appears in the console; agent-side inbox is future work
            }
        }

        override fun onDisconnected(expectedClose: Boolean) {
            if (!expectedClose) {
                scope.launch { reconnectOrStop(reconnectAttempt++) }
            } else {
                scope.launch {
                    runCatching { api.reportState(sessionId, "reconnecting") }
                }
            }
        }
    }

    @Volatile
    private var reconnectAttempt = 0

    /** A fresh join token comes with the dedicated reconnect endpoint. */
    private suspend fun reconnectOrStop(attempt: Int) {
        if (attempt >= 3) {
            endAndStop()
            return
        }
        runCatching {
            joinToken = api.requestReconnect(sessionId).orEmpty()
            core?.close()
            core = null
            updateNotification("Reconnecting (attempt ${attempt + 1}/3)…")
            if (!rebuildCore()) {
                endAndStop()
                return
            }
            relay.connect(sessionId, joinToken, relayListener())
        }.onFailure {
            delay(3000L * (attempt + 1))
            reconnectOrStop(attempt + 1)
        }
    }

    // -- data channels --------------------------------------------------------

    private fun onDataMessage(label: String, payload: ByteArray) {
        val text = String(payload, Charsets.UTF_8)
        when (label) {
            "input" -> handleInput(text)
            "control" -> handleControl(text)
        }
    }

    private fun handleInput(raw: String) {
        val message = try {
            JSONObject(raw)
        } catch (_: Exception) {
            return
        }
        if (message.optString("type") != "input") return
        val action = message.optString("action")

        val x = message.optDouble("x", -1.0)
        val y = message.optDouble("y", -1.0)
        val hasPoint = x in 0.0..1.0 && y in 0.0..1.0
        val px = x * screenW
        val py = y * screenH

        val input = InputAccessibilityService.instance
        when (action) {
            "pointerdown" -> {
                pointerPressed = true
                input?.onPointerDown(px.toFloat(), py.toFloat(), message.optString("button", "left"))
            }
            "pointermove" -> input?.onPointerMove(px.toFloat(), py.toFloat(), pointerPressed)
            "pointerup" -> {
                pointerPressed = false
                input?.onPointerUp(px.toFloat(), py.toFloat())
            }
            "wheel" -> input?.onWheel(message.optDouble("deltaY", 0.0), px.toFloat(), py.toFloat())

            "keydown" -> handleKeyDown(input, message.optString("key"))
            "keyup" -> Unit
        }
    }

    /**
     * Keyboard mapping for phones/tablets:
     *  - device-level keys map to global actions,
     *  - Backspace/Enter go to the IME bridge when the user switched keyboards,
     *  - printable characters are committed by the IME bridge.
     */
    private fun handleKeyDown(input: InputAccessibilityService?, key: String) {
        if (input?.performGlobalKey(key) == true) return
        when (key) {
            "Backspace" -> ReyDeskImeService.backspace(1)
            "Enter" -> ReyDeskImeService.sendEnter()
            else -> {
                if (key.length == 1) ReyDeskImeService.commitRemoteText(key)
            }
        }
    }

    private fun handleControl(raw: String) {
        val message = try {
            JSONObject(raw)
        } catch (_: Exception) {
            return
        }
        when (message.optString("action")) {
            "monitor_list" -> sendMonitorCatalogue()
            "monitor_select", "monitor_all" -> {
                // Android exposes exactly one display; keep selection idempotent.
                sendMonitorCatalogue()
            }
            "clipboard_get" -> core?.sendData(
                "control",
                """{"type":"clipboard_error","reason":"Clipboard access is not supported on Android"}""",
            )
        }
    }

    /** Console display catalogue; matches the desktop agent's shape. */
    private fun sendMonitorCatalogue() {
        val catalogue = JSONObject()
            .put("type", "monitor")
            .put("action", "list")
            .put(
                "monitors",
                org.json.JSONArray()
                    .put(
                        JSONObject()
                            .put("id", 0)
                            .put("label", "Screen 1")
                            .put("x", 0)
                            .put("y", 0)
                            .put("width", screenW)
                            .put("height", screenH)
                            .put("isPrimary", true),
                    ),
            )
            .put("selectedMonitorId", 0)
        core?.sendData("control", catalogue.toString())
    }

    // -- background reporting -------------------------------------------------

    private suspend fun heartbeatLoop() {
        while (true) {
            runCatching { api.heartbeat(Battery.levelPct(this), Battery.powerSource(this)) }
            delay(30_000)
        }
    }

    private fun endAndStop() {
        scope.launch {
            runCatching { api.endSession(sessionId) }
            relay.close()
            stopSelf()
        }
    }

    // -- Android plumbing -----------------------------------------------------

    private val coreListener = object : WebRtcCore.Listener {
        override fun onConnected() {
            updateNotification("Session active — technician connected")
        }

        override fun onFailed() {
            updateNotification("Connection lost — waiting for retry…")
        }

        override fun onDataChannelOpened(label: String) {
            if (label == "control") sendMonitorCatalogue()
        }
    }

    private val mainHandler = android.os.Handler(android.os.Looper.getMainLooper())

    override fun onDestroy() {
        scope.launch {
            runCatching { api.reportState(sessionId, "ended") }
        }
        relay.close()
        core?.close()
        scope.cancel()
        super.onDestroy()
    }

    private fun relayUrl(apiBase: String): String =
        apiBase.replaceFirst("https://", "wss://").replaceFirst("http://", "ws://").trimEnd('/') + "/ws"

    // -- notification ---------------------------------------------------------

    private fun ensureNotificationChannel() {
        val manager = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
        val channel = NotificationChannel(
            CHANNEL_ID,
            getString(R.string.notif_channel_support),
            NotificationManager.IMPORTANCE_LOW,
        )
        channel.description = getString(R.string.notif_channel_desc)
        manager.createNotificationChannel(channel)
    }

    private fun buildNotification(text: String): Notification {
        val openIntent = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE,
        )
        val stopIntent = PendingIntent.getService(
            this, 1,
            Intent(this, CaptureService::class.java).setAction("${packageName}.STOP"),
            PendingIntent.FLAG_IMMUTABLE,
        )
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle(getString(R.string.notif_session_title))
            .setContentText(text)
            .setSmallIcon(R.drawable.ic_launcher_foreground)
            .setOngoing(true)
            .setContentIntent(openIntent)
            .addAction(0, getString(R.string.stop_session), stopIntent)
            .build()
    }

    private fun updateNotification(text: String) {
        mainHandler.post {
            getSystemService(NOTIFICATION_SERVICE) as NotificationManager
            val manager = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
            manager.notify(NOTIFICATION_ID, buildNotification(text))
        }
    }

    @Deprecated("Deprecated in Java")
    override fun onStart(intent: Intent?, startId: Int) {
        super.onStart(intent, startId)
    }
}
