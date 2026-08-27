package com.reydesk.agent

import android.Manifest
import android.app.Activity
import android.content.Context
import android.content.Intent
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.Bundle
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * Attended-session consent gate. Shows who is asking (reason), then:
 *
 *  1. Deny  -> POST consent {granted:false} (server ends the session)
 *  2. Allow -> system MediaProjection dialog; on success POST consent
 *     {granted:true, permissions:[view_screen, control_input]} and hand the
 *     projection result + join token to [CaptureService].
 */
class ConsentActivity : Activity() {

    companion object {
        const val EXTRA_SESSION_ID = "sessionId"
        const val EXTRA_PERMISSIONS = "permissions"
        const val EXTRA_REASON = "reason"

        private const val PROJECTION_REQUEST = 9101

        /** Permissions this endpoint can actually honour on Android. */
        private val SUPPORTED_PERMISSIONS = listOf("view_screen", "control_input")
    }

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)

    private lateinit var sessionId: String
    private var pendingProjectionData: Intent? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        sessionId = intent.getStringExtra(EXTRA_SESSION_ID).orEmpty()
        val permissions = intent.getStringArrayExtra(EXTRA_PERMISSIONS)?.toList() ?: emptyList()
        val reason = intent.getStringExtra(EXTRA_REASON)

        if (sessionId.isBlank()) {
            finish()
            return
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M &&
            checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != android.content.pm.PackageManager.PERMISSION_GRANTED &&
            Build.VERSION.SDK_INT >= 33
        ) {
            requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 1)
        }

        setContentView(buildUi(reason, permissions))
    }

    private fun buildUi(reason: String?, permissions: List<String>): android.view.View {
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(28), dp(48), dp(28), dp(32))
        }
        root.addView(TextView(this).apply {
            text = getString(R.string.consent_title)
            textSize = 22f
        })
        root.addView(TextView(this).apply {
            text = buildString {
                append("Your IT technician wants to view and control this device")
                append(" through ReyDesk.")
                reason?.takeIf { it.isNotBlank() }?.let { append("\n\nReason: ").append(it) }
                append("\n\nThis will be visible on your screen for the whole session.")
                if (!permissions.contains("control_input")) {
                    append("\n\nThe technician asked to view only.")
                }
            }
            textSize = 15f
            setPadding(0, dp(16), 0, dp(24))
        })

        val allow = Button(this).apply { text = getString(R.string.allow); isEnabled = false }
        val deny = Button(this).apply { text = getString(R.string.deny) }

        allow.setOnClickListener { requestProjection() }
        deny.setOnClickListener {
            scope.launch {
                withContext(Dispatchers.IO) {
                    runCatching { ApiClient.forContext(applicationContext).consent(sessionId, granted = false, permissions = emptyList()) }
                }
                finish()
            }
        }

        root.addView(allow, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(52)))
        root.addView(deny, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(52)).apply {
            topMargin = dp(12)
        })
        return root
    }

    private fun requestProjection() {
        // Accessibility gestures are required for the control_input permission.
        if (InputAccessibilityService.available.not()) {
            startActivity(Intent(Settings_ACTION))
            Toast_show("Enable \"ReyDesk remote control\" to allow the technician to control this device.")
            return
        }
        val manager = getSystemService(Context.MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
        @Suppress("DEPRECATION")
        startActivityForResult(manager.createScreenCaptureIntent(), PROJECTION_REQUEST)
    }

    @Deprecated("Deprecated in Java")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode != PROJECTION_REQUEST) return
        if (resultCode != RESULT_OK || data == null) return // user cancelled system dialog

        pendingProjectionData = data
        scope.launch {
            try {
                val result = withContext(Dispatchers.IO) {
                    ApiClient.forContext(applicationContext)
                        .consent(sessionId, granted = true, permissions = SUPPORTED_PERMISSIONS)
                }
                val joinToken = result.joinToken ?: error("Server did not return a join token")
                startForegroundService(
                    Intent(this@ConsentActivity, CaptureService::class.java)
                        .putExtra(CaptureService.EXTRA_SESSION_ID, sessionId)
                        .putExtra(CaptureService.EXTRA_JOIN_TOKEN, joinToken)
                        .putExtra(CaptureService.EXTRA_PROJECTION, data),
                )
                finish()
            } catch (_: Exception) {
                Toast_show("Could not start the session. Try again.")
            }
        }
    }

    override fun onDestroy() {
        scope.cancel()
        super.onDestroy()
    }

    private fun Toast_show(text: String) =
        android.widget.Toast.makeText(this, text, android.widget.Toast.LENGTH_LONG).show()

    private val Settings_ACTION get() = android.provider.Settings.ACTION_ACCESSIBILITY_SETTINGS

    private fun dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()
}
