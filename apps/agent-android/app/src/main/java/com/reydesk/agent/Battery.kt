package com.reydesk.agent

import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.BatteryManager

/**
 * Lightweight battery telemetry for the heartbeat. Uses the sticky battery
 * intent so no permission is required, and reports the charging state so the
 * console can show "· charging" next to the level.
 */
object Battery {
    fun levelPct(context: Context): Int? = try {
        val manager = context.getSystemService(Context.BATTERY_SERVICE) as? BatteryManager
        manager?.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY)?.takeIf { it in 0..100 }
    } catch (_: Throwable) {
        null
    }

    fun powerSource(context: Context): String? = try {
        val intent = context.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
        val plugged = intent?.getIntExtra(BatteryManager.EXTRA_PLUGGED, -1) ?: -1
        when {
            plugged == BatteryManager.BATTERY_PLUGGED_AC -> "charging"
            plugged == BatteryManager.BATTERY_PLUGGED_USB -> "charging"
            plugged == BatteryManager.BATTERY_PLUGGED_WIRELESS -> "charging"
            else -> "battery"
        }
    } catch (_: Throwable) {
        null
    }
}