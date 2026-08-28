package com.reydesk.agent

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.provider.Settings
import android.view.Gravity
import android.view.View
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView
import android.widget.Toast
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * Enrollment + "waiting for sessions" screen.
 *
 * While visible the app heartbeats the API and polls `GET /agent/sessions`;
 * an incoming attended session opens [ConsentActivity]. A persistent poll
 * while the app is closed is future work (needs FCM or a work policy).
 */
class MainActivity : Activity() {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)

    private lateinit var container: LinearLayout
    private var consentShowingForSession: String? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        container = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(24), dp(32), dp(24), dp(24))
        }
        setContentView(container)

        // reydesk://enrol?token=XXXX from the console QR code.
        (intent?.data as? Uri)?.let { uri ->
            if (uri.host == "enrol") {
                uri.getQueryParameter("token")?.let { AgentPrefs.setPendingToken(this, it) }
            }
        }
        renderEnrolled(AgentPrefs.isEnrolled(this))
    }

    private fun renderEnrolled(enrolled: Boolean) {
        container.removeAllViews()
        title = getString(R.string.app_name)
        if (enrolled) {
            renderStatusScreen()
        } else {
            renderEnrollmentForm()
        }
    }

    // -- enrollment -----------------------------------------------------------

    private fun renderEnrollmentForm() {
        val heading = TextView(this).apply {
            text = "Connect this device"
            textSize = 22f
        }
        val subheading = TextView(this).apply {
            text = "Paste the enrollment code from Settings → Devices in your ReyDesk console."
            textSize = 14f
            setPadding(0, dp(6), 0, dp(20))
        }
        val serverInput = EditText(this).apply {
            hint = "Server URL"
            setText(AgentPrefs.apiBaseUrl(this@MainActivity))
            inputType = android.text.InputType.TYPE_CLASS_TEXT or android.text.InputType.TYPE_TEXT_VARIATION_URI
            setSingleLine(true)
        }
        val tokenInput = EditText(this).apply {
            hint = "Enrollment code"
            setText(AgentPrefs.pendingToken(this@MainActivity))
            setSingleLine(true)
        }
        val nameInput = EditText(this).apply {
            hint = "Device name (optional)"
            setText(android.os.Build.MODEL)
            setSingleLine(true)
        }
        val enrollButton = Button(this).apply { text = "Enroll" }
        val progress = ProgressBar(this).apply { visibility = View.GONE }

        enrollButton.setOnClickListener {
            val server = serverInput.text.toString().trim().ifBlank { "https://reydesk.com" }
            val token = tokenInput.text.toString().trim()
            if (token.length < 6) {
                tokenInput.error = "Enter the code shown in the console"
                return@setOnClickListener
            }
            enrollButton.isEnabled = false
            progress.visibility = View.VISIBLE
            scope.launch {
                try {
                    val result = withContext(Dispatchers.IO) {
                        ApiClient(server, null).enrol(token, nameInput.text.toString())
                    }
                    AgentPrefs.saveIdentity(applicationContext, server, result.deviceId, result.deviceName, result.token)
                    Toast.makeText(this@MainActivity, "Enrolled as ${result.deviceName}", Toast.LENGTH_LONG).show()
                    renderEnrolled(true)
                } catch (error: Exception) {
                    tokenInput.error = error.message?.take(120) ?: "Enrollment failed"
                    enrollButton.isEnabled = true
                    progress.visibility = View.GONE
                }
            }
        }

        container.addView(heading)
        container.addView(subheading)
        container.addView(serverInput)
        container.addView(tokenInput, dp(-1), dp(52))
        container.addView(nameInput, dp(-1), dp(52))
        container.addView(enrollButton, dp(-1), dp(52))
        container.addView(progress, LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT)
    }

    // -- enrolled status ------------------------------------------------------

    @Volatile
    private var stopped = true

    override fun onResume() {
        super.onResume()
        stopped = false
        scope.launch { sessionLoop() }
    }

    override fun onPause() {
        super.onPause()
        stopped = true
    }

    private fun renderStatusScreen() {
        val header = TextView(this).apply {
            text = "Connected to ${AgentPrefs.apiBaseUrl(this@MainActivity).removePrefix("https://")}"
            textSize = 16f
        }
        val deviceIdView = TextView(this).apply {
            text = "Device ID: ${AgentPrefs.deviceId(this@MainActivity)?.take(8)}…\nThis app must stay running to receive support sessions."
            textSize = 13f
            setPadding(0, dp(10), 0, dp(4))
        }

        val accessibilityButton = Button(this).apply {
            text = if (InputAccessibilityService.available) "Remote-control gestures enabled ✓" else "Enable remote-control gestures"
            isEnabled = !InputAccessibilityService.available
            setOnClickListener {
                startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))
            }
        }

        val imeHint = TextView(this).apply {
            text = "Tip: during a controlled session, switch your keyboard to \"ReyDesk keyboard\" so the technician can type."
            textSize = 12f
            setPadding(0, dp(8), 0, dp(16))
        }

        val disconnectButton = Button(this).apply {
            text = "Forget this device"
            setBackgroundColor(0x33EF4444.toInt())
            setOnClickListener {
                AgentPrefs.clearIdentity(this@MainActivity)
                renderEnrolled(false)
            }
        }

        container.addView(header)
        container.addView(deviceIdView)
        container.addView(accessibilityButton, dp(-1), dp(50))
        container.addView(imeHint)
        container.addView(disconnectButton, dp(-1), dp(46))
        container.gravity = Gravity.CENTER_VERTICAL
    }

    private suspend fun sessionLoop() {
        val api = ApiClient.forContext(this)
        while (!stopped && AgentPrefs.isEnrolled(this)) {
            scope.launch(Dispatchers.IO) {
                runCatching { api.heartbeat(Battery.levelPct(this@MainActivity), Battery.powerSource(this@MainActivity)) }
            }
            val pending = runCatching {
                withContext(Dispatchers.IO) { api.pendingSessions() }
            }.getOrDefault(emptyList())

            val actionable = pending.firstOrNull { it.state in setOf("requested", "consent_pending") }
            if (actionable != null && consentShowingForSession != actionable.id) {
                consentShowingForSession = actionable.id
                startActivity(
                    Intent(this, ConsentActivity::class.java)
                        .putExtra(ConsentActivity.EXTRA_SESSION_ID, actionable.id)
                        .putExtra(ConsentActivity.EXTRA_PERMISSIONS, actionable.permissions.toTypedArray())
                        .putExtra(ConsentActivity.EXTRA_REASON, actionable.reason),
                )
            }
            delay(8_000)
        }
    }

    override fun onDestroy() {
        scope.cancel()
        super.onDestroy()
    }

    private fun dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        // Keep the user inside the agent shell; nothing to navigate back to.
    }
}
