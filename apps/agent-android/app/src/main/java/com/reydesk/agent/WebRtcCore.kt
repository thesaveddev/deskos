package com.reydesk.agent

import android.content.Context
import android.content.Intent
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.util.DisplayMetrics
import android.view.WindowManager
import org.json.JSONObject
import org.webrtc.DefaultVideoDecoderFactory
import org.webrtc.DefaultVideoEncoderFactory
import org.webrtc.EglBase
import org.webrtc.IceCandidate
import org.webrtc.MediaConstraints
import org.webrtc.PeerConnection
import org.webrtc.PeerConnectionFactory
import org.webrtc.SdpObserver
import org.webrtc.SessionDescription
import org.webrtc.SurfaceTextureHelper
import org.webrtc.VideoTrack
import org.webrtc.ScreenCapturerAndroid
import org.webrtc.RtpTransceiver

/**
 * Answers the technician's SDP offer with a screen-only description and owns
 * the [PeerConnection]. Mirrors the desktop agent's recovery rule: a healthy
 * peer ignores duplicate offers (companion browser joins re-offer), but a
 * failed/disconnected/closed peer is replaced by the fresh offer.
 */
class WebRtcCore(
    private val context: Context,
    private val relay: RelayClient,
    private val listener: Listener,
) : PeerConnection.Observer {

    interface Listener {
        fun onConnected()
        fun onFailed()
        fun onDataChannelOpened(label: String)
    }

    val eglBase: EglBase = EglBase.create()

    private lateinit var factory: PeerConnectionFactory
    private var helper: SurfaceTextureHelper? = null
    private var capturer: ScreenCapturerAndroid? = null
    private var screenTrack: VideoTrack? = null
    private var peer: PeerConnection? = null
    private var projectionData: Intent? = null

    fun ensureFactory() {
        if (::factory.isInitialized) return
        PeerConnectionFactory.initialize(
            PeerConnectionFactory.InitializationOptions.builder(context)
                .setEnableInternalTracer(false)
                .createInitializationOptions(),
        )
        factory = PeerConnectionFactory.builder()
            .setVideoEncoderFactory(DefaultVideoEncoderFactory(eglBase.eglBaseContext, true, true))
            .setVideoDecoderFactory(DefaultVideoDecoderFactory(eglBase.eglBaseContext))
            .createPeerConnectionFactory()
    }

    /** Screen resolution reported to the console for pointer mapping. */
    fun displaySize(): Pair<Int, Int> {
        val metrics = DisplayMetrics()
        @Suppress("DEPRECATION")
        (context.getSystemService(Context.WINDOW_SERVICE) as WindowManager)
            .defaultDisplay.getRealMetrics(metrics)
        return metrics.widthPixels to metrics.heightPixels
    }

    /** Incoming data-channel payloads: (label, bytes). */
    var dataListener: ((label: String, payload: ByteArray) -> Unit)? = null

    private val channels = HashMap<String, org.webrtc.DataChannel>()

    /** Send raw text back over a data channel created by the browser. */
    fun sendData(label: String, text: String) {
        val channel = channels[label] ?: return
        val buffer = java.nio.ByteBuffer.wrap(text.toByteArray(Charsets.UTF_8))
        channel.send(org.webrtc.DataChannel.Buffer(buffer, false))
    }

    fun createPeer(iceServers: List<JSONObject>, projectionData: Intent) {
        this.projectionData = projectionData
        ensureFactory()
        // A rebuild after a dead peer must release the old capturer/helper
        // first or MediaProjection refuses to start twice per session.
        disposeCapture()

        val rtcServers = iceServers.map { server ->
            val urls = server.optJSONArray("urls") ?: org.json.JSONArray().put(server.optString("urls"))
            val list = (0 until urls.length()).mapNotNull { urls.optString(it).takeIf(String::isNotBlank) }
            PeerConnection.IceServer.builder(list)
                .setUsername(server.optString("username").takeIf { it.isNotBlank() && it != "null" })
                .setPassword(server.optString("credential").takeIf { it.isNotBlank() && it != "null" })
                .createIceServer()
        }
        val config = PeerConnection.RTCConfiguration(rtcServers).apply {
            sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN
            continualGatheringPolicy = PeerConnection.ContinualGatheringPolicy.GATHER_CONTINUALLY
        }

        // Answerer side: incoming tracks are negotiated from the offer; we only
        // add our own transceiver for sending the screen.
        peer?.close()
        peer = factory.createPeerConnection(config, this) ?: throw IllegalStateException("libwebrtc refused to create a peer connection")

        val widthHeight = displaySize()
        capturer = ScreenCapturerAndroid(projectionData, object : MediaProjection.Callback() {})
        helper = SurfaceTextureHelper.create("capture-thread", eglBase.eglBaseContext)
        val source = factory.createVideoSource(capturer!!.isScreencast)
        capturer!!.initialize(helper!!, context, source.capturerObserver)
        capturer!!.startCapture(widthHeight.first, widthHeight.second, 15)

        val trackId = "screen0"
        screenTrack = factory.createVideoTrack(trackId, source)
        peer!!.addTrack(screenTrack)
    }

    private fun disposeCapture() {
        try {
            capturer?.stopCapture()
        } catch (_: InterruptedException) {
            Thread.currentThread().interrupt()
        }
        capturer?.dispose()
        screenTrack?.dispose()
        helper?.dispose()
        capturer = null
        screenTrack = null
        helper = null
    }

    fun handleOffer(sdp: String) {
        val currentPeer = peer ?: run {
            listener.onFailed()
            return
        }
        val state = currentPeer.connectionState()
        val unhealthy = state == PeerConnection.PeerConnectionState.FAILED ||
            state == PeerConnection.PeerConnectionState.DISCONNECTED ||
            state == PeerConnection.PeerConnectionState.CLOSED ||
            state == null

        val target: PeerConnection
        if (!unhealthy && offeredOnce) {
            // Desktop-agent parity: companion joins make the technician
            // renegotiate; answering again would orphan the live media peer.
            return
        } else if (unhealthy) {
            val deadPeer = currentPeer
            deadPeer.close()
            peer = null
            target = rebuildDeadPeer() ?: return
        } else {
            target = currentPeer
        }

        offeredOnce = true
        target.setRemoteDescription(SessionDescriptionObserver(), SessionDescription(SessionDescription.Type.OFFER, sdp))
        val constraints = MediaConstraints()
        target.createAnswer(object : SdpObserverAdapter() {
            override fun onCreateSuccess(description: SessionDescription) {
                target.setLocalDescription(SessionDescriptionObserver(), description)
                relay.sendAnswer(description.description)
            }

            override fun onCreateFailure(error: String?) {
                listener.onFailed()
            }
        }, constraints)
    }

    /** Recreate the capture pipeline after a dead-peer replacement. */
    private fun rebuildDeadPeer(): PeerConnection? {
        val data = projectionData ?: return null
        val serversJson = lastIceServers
        createPeer(serversJson, data)
        return peer
    }

    private var lastIceServers: List<JSONObject> = emptyList()

    fun rememberIceServers(servers: List<JSONObject>) {
        lastIceServers = servers
    }

    private var offeredOnce = false

    fun addRemoteCandidate(candidate: JSONObject) {
        val init = IceCandidate(
            candidate.optString("sdpMid"),
            candidate.optInt("sdpMLineIndex"),
            candidate.optString("candidate"),
        )
        peer?.addIceCandidate(init)
    }

    fun close() {
        disposeCapture()
        peer?.close()
        peer = null
        offeredOnce = false
        channels.clear()
    }

    override fun onIceCandidate(candidate: IceCandidate) {
        relay.sendIce(
            JSONObject()
                .put("candidate", candidate.sdp)
                .put("sdpMid", candidate.sdpMid ?: JSONObject.NULL)
                .put("sdpMLineIndex", candidate.sdpMLineIndex),
        )
    }

    override fun onConnectionChange(newState: PeerConnection.PeerConnectionState) {
        when (newState) {
            PeerConnection.PeerConnectionState.CONNECTED -> listener.onConnected()
            PeerConnection.PeerConnectionState.FAILED, PeerConnection.PeerConnectionState.CLOSED -> listener.onFailed()
            else -> Unit
        }
    }

    override fun onSignalingChange(state: PeerConnection.SignalingState?) = Unit
    override fun onIceConnectionChange(state: PeerConnection.IceConnectionState?) = Unit
    override fun onIceConnectionReceivingChange(receiving: Boolean) = Unit
    override fun onIceGatheringChange(state: PeerConnection.IceGatheringState?) = Unit
    override fun onIceCandidatesRemoved(candidates: Array<out IceCandidate>?) = Unit
    override fun onAddStream(stream: org.webrtc.MediaStream?) = Unit
    override fun onRemoveStream(stream: org.webrtc.MediaStream?) = Unit
    override fun onDataChannel(channel: org.webrtc.DataChannel?) {
        val ch = channel ?: return
        val label = ch.label()
        channels[label] = ch
        listener.onDataChannelOpened(label)
        ch.registerObserver(object : org.webrtc.DataChannel.Observer {
            override fun onBufferedAmountChange(previous: Long) = Unit
            override fun onStateChange() = Unit
            override fun onMessage(buffer: org.webrtc.DataChannel.Buffer?) {
                val binary = buffer ?: return
                val bytes = ByteArray(binary.data.remaining())
                binary.data.get(bytes)
                dataListener?.invoke(label, bytes)
            }
        })
    }
    override fun onRenegotiationNeeded() = Unit
    override fun onTrack(transceiver: RtpTransceiver?) = Unit

    private open class SdpObserverAdapter : SdpObserver {
        override fun onCreateSuccess(description: SessionDescription?) = Unit
        override fun onSetSuccess() = Unit
        override fun onCreateFailure(error: String?) = Unit
        override fun onSetFailure(error: String?) = Unit
    }

    private class SessionDescriptionObserver : SdpObserver {
        override fun onCreateSuccess(description: SessionDescription?) = Unit
        override fun onSetSuccess() = Unit
        override fun onCreateFailure(error: String?) = Unit
        override fun onSetFailure(error: String?) = Unit
    }
}
