package com.reydesk.agent

import android.inputmethodservice.InputMethodService
import android.view.View
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputConnection

/**
 * Keyboard bridge for remote control. When the endpoint user switches to this
 * keyboard during an active session, printable keys arriving on the input
 * data channel are committed verbatim through the focused input connection.
 *
 * The on-screen view is intentionally empty: nothing is typed locally.
 */
class ReyDeskImeService : InputMethodService() {

    companion object {
        @Volatile
        private var current: ReyDeskImeService? = null

        /** Commit text received from the technician. True when delivered. */
        fun commitRemoteText(text: String): Boolean {
            val service = current ?: return false
            val connection = service.currentInputConnection ?: return false
            connection.commitText(text, 1)
            return true
        }

        fun sendEnter(): Boolean {
            val service = current ?: return false
            val connection = service.currentInputConnection ?: return false
            connection.performEditorAction(EditorInfo.IME_ACTION_DONE)
            return true
        }

        fun backspace(count: Int): Boolean {
            val service = current ?: return false
            val connection = service.currentInputConnection ?: return false
            val before = connection.getTextBeforeCursor(count.coerceIn(1, 64), 0)?.length ?: 0
            if (before == 0) return false
            connection.deleteSurroundingText(before, 0)
            return true
        }
    }

    override fun onCreateInputView(): View =
        View(this).apply { minimumHeight = 1 }

    override fun onStartInput(attribute: EditorInfo?, restarting: Boolean) {
        super.onStartInput(attribute, restarting)
        current = this
    }

    override fun onFinishInput() {
        if (current === this) current = null
        super.onFinishInput()
    }
}
