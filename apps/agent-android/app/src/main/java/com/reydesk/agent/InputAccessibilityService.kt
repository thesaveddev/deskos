package com.reydesk.agent

import android.accessibilityservice.AccessibilityService
import android.graphics.Path
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.accessibility.GestureDescription

/**
 * Injects technician touches as accessibility gestures. Only gestures are
 * performed — no accessibility events are inspected and nothing is recorded.
 *
 * The web console streams the pointer protocol the desktop agent consumes:
 *
 *   {action:"pointerdown"|"pointerup", button:"left"|"right"|..., x, y}  (x/y normalized 0..1)
 *   {action:"pointermove", x, y}
 *   {action:"wheel", deltaY, x, y}
 *
 * Conversion rules:
 *  - press/release pair         -> tap when no movement happened between them,
 *                                  otherwise a continuous drag built from
 *                                  chained [GestureDescription.StrokeDescription.continueStroke] calls
 *  - right button               -> long-press (the Android context-menu idiom)
 *  - wheel delta                -> vertical swipe at the pointer position
 */
class InputAccessibilityService : AccessibilityService() {

    companion object {
        private const val TAG = "ReyDeskInput"

        @Volatile
        var instance: InputAccessibilityService? = null
            private set

        val available: Boolean get() = instance != null
    }

    private val mainHandler by lazy { Handler(Looper.getMainLooper()) }

    // Drag state lives on the main thread only; gesture dispatch also requires it.
    private var dragBase: GestureDescription.StrokeDescription? = null
    private var dragPath: Path? = null
    private var dragMoved = false

    override fun onServiceConnected() {
        super.onServiceConnected()
        instance = this
    }

    override fun onDestroy() {
        if (instance === this) instance = null
        super.onDestroy()
    }

    override fun onInterrupt() = Unit

    override fun onUnbind(intent: android.content.Intent?): Boolean {
        if (instance === this) instance = null
        return super.onUnbind(intent)
    }

    // -- pointer protocol -----------------------------------------------------

    fun onPointerDown(x: Float, y: Float, button: String) {
        runOnMain {
            if (button != "left" && button != "middle") {
                longPress(x, y)
                return@runOnMain
            }
            val path = Path().apply { moveTo(x, y); lineTo(x, y) }
            dragPath = path
            dragMoved = false
            val stroke = GestureDescription.StrokeDescription(path, 0, 40).also {
                dispatchNow(GestureDescription.Builder().addStroke(it).build())
            }
            dragBase = stroke
        }
    }

    fun onPointerMove(x: Float, y: Float, pressed: Boolean) {
        if (!pressed) return
        runOnMain {
            val base = dragBase ?: return@runOnMain
            val path = dragPath ?: return@runOnMain
            path.lineTo(x, y)
            dragMoved = true
            val continued = base.continueStroke(path, 0, 60, true)
            dispatchNow(GestureDescription.Builder().addStroke(continued).build())
            dragBase = continued
        }
    }

    fun onPointerUp(x: Float, y: Float) {
        runOnMain {
            val base = dragBase
            val path = dragPath
            dragBase = null
            dragPath = null
            if (base == null || path == null) return@runOnMain
            if (!dragMoved && !path.isEmpty) {
                tapAt(path)
            } else {
                path.lineTo(x, y)
                val finished = base.continueStroke(path, 0, 90, false)
                dispatchNow(GestureDescription.Builder().addStroke(finished).build())
            }
        }
    }

    fun onTap(x: Float, y: Float) = runOnMain { tapAt(Path().apply { moveTo(x, y); lineTo(x, y) }) }

    fun onWheel(deltaY: Double, x: Float, y: Float) = runOnMain {
        // Wheel "scroll down" (deltaY > 0) => finger swipes upward on touch UIs.
        val distance = (kotlin.math.abs(deltaY).coerceIn(60.0, 600.0) * 2.2f).toFloat()
        val endY = if (deltaY > 0) y - distance else y + distance
        val path = Path().apply {
            moveTo(x, y)
            lineTo(x, endY)
        }
        dispatchNow(
            GestureDescription.Builder()
                .addStroke(GestureDescription.StrokeDescription(path, 0, 200))
                .build(),
        )
    }

    // -- keyboard subset ------------------------------------------------------

    /** Returns true when the key was mapped to a device-level action. */
    fun performGlobalKey(key: String): Boolean {
        val action = when (key) {
            "Escape" -> GLOBAL_ACTION_BACK
            "Home" -> GLOBAL_ACTION_HOME
            "F5" -> GLOBAL_ACTION_RECENTS
            else -> return false
        }
        return performGlobalAction(action)
    }

    // -- internals ------------------------------------------------------------

    private fun tapAt(path: Path) {
        dispatchNow(
            GestureDescription.Builder()
                .addStroke(GestureDescription.StrokeDescription(path, 0, 60))
                .build(),
        )
    }

    private fun longPress(x: Float, y: Float) {
        val path = Path().apply { moveTo(x, y); lineTo(x, y) }
        dispatchNow(
            GestureDescription.Builder()
                .addStroke(GestureDescription.StrokeDescription(path, 0, 700))
                .build(),
        )
    }

    private fun dispatchNow(gesture: GestureDescription) {
        try {
            dispatchGesture(gesture, null, null)
        } catch (error: Exception) {
            Log.w(TAG, "gesture rejected: ${error.message}")
        }
    }

    private inline fun runOnMain(crossinline body: () -> Unit) {
        val service = this
        mainHandler.post {
            if (InputAccessibilityService.instance !== service) return@post
            body()
        }
    }
}
