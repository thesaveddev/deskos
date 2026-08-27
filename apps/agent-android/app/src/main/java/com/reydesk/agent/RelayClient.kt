package com.reydesk.agent

import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/**
 * Relay signaling client. Mirrors `run_relay_connection` in the desktop agent:
 *
 *  1. open WSS and send `{type:"join", sessionId, joinToken}`
 *  2. wait for `{"type":"joined"}` (reports session active afterwards)
 *  3. technician browser sends `{type:"sdp", description:{type:"offer", sdp}}`
 *     -> listener forwards it to the WebRTC layer which sends back an answer
 *  4. ICE candidates flow as `{type:"ice", candidate:{...}}` in both directions
 *  5. non-signaling messages (`chat`, `control`, …) reach [Listener.onMessage]
 */
class RelayClient(private val relayUrl: String) {

    interface Listener {
        fun onJoined() {}
        fun onPeerJoined() {}
        fun onOffer(sdp: String)
        fun onIceCandidate(candidate: JSONObject)
        fun onSessionEnd()
        fun onOther(type: String, message: JSONObject) {}
        fun onDisconnected(expectedClose: Boolean)
    }

    private val http = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.MILLISECONDS) // websocket never time out on read
        .pingInterval(25, TimeUnit.SECONDS)
        .build()

    private var socket: WebSocket? = null

    @Volatile
    var closedByUs = false
        private set

    fun connect(sessionId: String, joinToken: String, listener: Listener) {
        closedByUs = false
        val request = Request.Builder().url(relayUrl).build()
        socket = http.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                webSocket.send(
                    JSONObject()
                        .put("type", "join")
                        .put("sessionId", sessionId)
                        .put("joinToken", joinToken)
                        .toString(),
                )
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                val message = try {
                    JSONObject(text)
                } catch (_: Exception) {
                    return
                }
                when (message.optString("type")) {
                    "joined" -> listener.onJoined()
                    "peer_joined" -> listener.onPeerJoined()
                    "sdp" -> {
                        val description = message.optJSONObject("description") ?: return
                        if (description.optString("type") == "offer") {
                            listener.onOffer(description.optString("sdp"))
                        } else if (description.optString("type") == "answer" &&
                            message.optString("from") == "companion"
                        ) {
                            // The user-side browser companion answers our
                            // offer path too; ignore on Android where we only
                            // ever answer the technician offer.
                        }
                    }
                    "ice" -> message.optJSONObject("candidate")?.let { listener.onIceCandidate(it) }
                    "session_end" -> listener.onSessionEnd()
                    "error" -> Unit // rate limits etc.; stay connected and retry logic lives above
                    else -> listener.onOther(message.optString("type"), message)
                }
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                listener.onDisconnected(closedByUs)
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                listener.onDisconnected(closedByUs || code == 1000)
            }
        })
    }

    fun sendAnswer(sdp: String) {
        socket?.send(
            JSONObject()
                .put("type", "sdp")
                .put("description", JSONObject().put("type", "answer").put("sdp", sdp))
                .toString(),
        )
    }

    fun sendIce(candidate: JSONObject) {
        socket?.send(
            JSONObject()
                .put("type", "ice")
                .put("candidate", candidate)
                .toString(),
        )
    }

    fun sendChat(body: String) {
        socket?.send(JSONObject().put("type", "chat").put("body", body).toString())
    }

    fun close() {
        closedByUs = true
        socket?.close(1000, "agent_closed")
        socket = null
    }
}
